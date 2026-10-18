// Reading title cards of videos on the Plex server (desktop/remoteread.js), against the pretend server
// (tests/fakeplex.js) serving a real video's bytes over SFTP. Checks the byte-range answers, that only
// this scan's addresses on 127.0.0.1 work, that hanging up stops the reads, that everything is closed
// afterwards, and that the bundled ffmpeg + OCR read the title card through it.
// Run with: node tests/remoteread.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const fake = require('./fakeplex');
const S = require('../desktop/server');
const RR = require('../desktop/remoteread');
const probe = require('../desktop/probe');
const scan = require('../desktop/scan');
const P = require('../app/js/parser.js');

const LOCAL = path.join(__dirname, 'fixtures', 'fake-title-card.mkv'); // 30 s: "Jellyfishing" at 10–14 s
const REMOTE = '/srv/disk1/TV/Spongebob/Season 5/Fake.Title.Card.mkv';
const BIG = '/srv/disk1/TV/Spongebob/Season 5/Big.mkv'; // 64 MB of zeros
const bytes = fs.readFileSync(LOCAL);

function get(url, headers, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: method || 'GET', headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
let pass = 0;
async function check(name, fn) { await fn(); pass++; console.log('  ✓ ' + name); }

(async () => {
  const srv = await fake.start({ real: { [REMOTE]: LOCAL } });
  srv.files.set(BIG, 64 * 1024 * 1024);
  const s = await S.connect({ host: '127.0.0.1', port: srv.port, username: 'me', password: srv.pass, pinned: srv.fp });
  const px = await RR.open(s.sftp);
  const f = await px.add(REMOTE);
  const size = bytes.length;

  await check('listens on 127.0.0.1 only, at a random 128-bit address per video', async () => {
    assert.match(f.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    assert.strictEqual(f.size, size);
  });
  await check('the whole file, with its size and "can jump" (200)', async () => {
    const r = await get(f.url);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['accept-ranges'], 'bytes');
    assert.strictEqual(+r.headers['content-length'], size);
    assert.ok(r.body.equals(bytes));
  });
  await check('byte ranges: a-b, a-, the last N, past the end (206 / 416)', async () => {
    let r = await get(f.url, { Range: 'bytes=100-1099' });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers['content-range'], 'bytes 100-1099/' + size);
    assert.ok(r.body.equals(bytes.subarray(100, 1100)));
    r = await get(f.url, { Range: 'bytes=' + (size - 300000) + '-' });
    assert.strictEqual(r.status, 206);
    assert.ok(r.body.equals(bytes.subarray(size - 300000)));
    r = await get(f.url, { Range: 'bytes=-50' });
    assert.ok(r.body.equals(bytes.subarray(size - 50)));
    r = await get(f.url, { Range: 'bytes=0-' + (size * 2) });
    assert.ok(r.body.equals(bytes), 'a range past the end stops at the end');
    r = await get(f.url, { Range: 'bytes=' + size + '-' });
    assert.strictEqual(r.status, 416);
    assert.strictEqual(r.headers['content-range'], 'bytes */' + size);
    r = await get(f.url, {}, 'HEAD');
    assert.strictEqual(r.status, 200); assert.strictEqual(+r.headers['content-length'], size); assert.strictEqual(r.body.length, 0);
  });
  await check('nothing else answers: another address, writing, another Host (404)', async () => {
    const base = f.url.replace(/[0-9a-f]{32}$/, '');
    assert.strictEqual((await get(base + '0'.repeat(32))).status, 404);
    assert.strictEqual((await get(base)).status, 404);
    assert.strictEqual((await get(f.url, {}, 'POST')).status, 404);
    assert.strictEqual((await get(f.url, {}, 'PUT')).status, 404);
    assert.strictEqual((await get(f.url, { Host: 'evil.example:' + px.port })).status, 404, 'a web page that renamed itself to 127.0.0.1 gets nothing');
  });
  await check('the header can be read as a file (probe.js): the running time', async () => {
    assert.strictEqual(await probe.duration(REMOTE, f.fh), 30);
    const b = Buffer.alloc(1 << 20);
    const { bytesRead } = await f.fh.read(b, 0, b.length, 0);
    assert.strictEqual(bytesRead, Math.min(size, b.length));
    assert.ok(b.subarray(0, bytesRead).equals(bytes.subarray(0, bytesRead)));
    const end = await f.fh.read(Buffer.alloc(4096), 0, 4096, size - 10);
    assert.strictEqual(end.bytesRead, 10, 'short at the end of the file');
  });
  await check('hanging up stops the reading (ffmpeg jumps away mid-stream)', async () => {
    const big = await px.add(BIG);
    const before = srv.reads.bytes;
    await new Promise((resolve, reject) => {
      const req = http.get(big.url, (res) => { res.once('data', () => { req.destroy(); setTimeout(resolve, 400); }); });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
    });
    const read = srv.reads.bytes - before;
    assert.ok(read < 8 * 1024 * 1024, 'read ' + read + ' bytes of 64 MB after hanging up');
    await big.done();
    assert.strictEqual((await get(big.url)).status, 404, 'a finished video’s address stops working');
  });
  await check('ffmpeg + OCR read the title card through it (and find its length)', async () => {
    const titles = ['Help Wanted', 'Jellyfishing', 'Plankton!', 'Jellyfish Jam'].map((name, i) => ({ name, number: i + 1, season: 1 }));
    const r = await scan.scanFile(f.url, await probe.duration(REMOTE, f.fh), { isMatch: (texts) => !!P.matchCardText(texts, titles) });
    await scan.stopOcr();
    const found = r.texts.map((t) => P.matchCardText(t.texts, titles)).filter(Boolean).map((m) => m.entry.name);
    assert.deepStrictEqual(found, ['Jellyfishing']);
    assert.ok(px.stats.requests > 2, 'ffmpeg jumped around: ' + px.stats.requests + ' requests');
  });
  await check('closing: the address stops answering and every file on the server is closed', async () => {
    const url = f.url;
    await px.close();
    await assert.rejects(get(url), /ECONNREFUSED|ECONNRESET/);
    assert.strictEqual(srv.reads.opens, 2); assert.strictEqual(srv.reads.closes, 2);
    await assert.rejects(px.add(REMOTE), /finished/);
  });

  s.close(); srv.close();
  console.log(pass + ' passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
