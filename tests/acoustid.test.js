// Recognising songs by their sound: fpcalc (Chromaprint, fetched by scripts/get-fpcalc.js) makes fingerprints on
// this computer; only fingerprints, lengths and your key go to AcoustID (a pretend one here), and the answers come
// back in order. Without a key, or with a wrong one, it says so in plain words.
// Run with: node tests/acoustid.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { execFileSync } = require('child_process');
const A = require('../desktop/acoustid.js');
const ff = require('ffmpeg-static');

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const FPCALC = path.join(__dirname, '..', 'build', 'bin', process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc');
if (!fs.existsSync(FPCALC)) { console.log('acoustid checks skipped (run node scripts/get-fpcalc.js first)'); process.exit(0); }

const bodies = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
    bodies.push(b);
    const p = new URLSearchParams(b);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (p.get('client') !== 'GOODKEY') return res.end(JSON.stringify({ status: 'error', error: { code: 4, message: 'invalid API key' } }));
    const n = [...p.keys()].filter((k) => k.startsWith('fingerprint.')).length;
    // Answers in a different order than asked: each says which fingerprint it's for.
    const fps = [];
    for (let i = n - 1; i >= 0; i--) fps.push({ index: i, results: [{ score: 0.9 - i * 0.01, id: 'a' + i, recordings: [{ id: 'rec-' + i, title: 'Song ' + i, duration: 3, artists: [{ name: 'Tone' }],
      releasegroups: [{ id: 'g' + i, title: 'Tones', type: 'Album', releases: [{ id: 'rel-' + i, title: 'Tones', date: { year: 2020, month: 5 }, country: 'XW', track_count: 3 }] }] }] }] });
    res.end(JSON.stringify(n === 1 ? { status: 'ok', results: fps[0].results } : { status: 'ok', fingerprints: fps }));
  });
});

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port + '/v2';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-acoustid-'));
  const songs = [440, 660, 880].map((hz) => { const f = path.join(tmp, 'Secret Name ' + hz + '.mp3'); execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=' + hz + ':duration=20', '-c:a', 'libmp3lame', f]); return f; });
  const broken = path.join(tmp, 'broken.mp3'); fs.writeFileSync(broken, Buffer.alloc(3000, 1));
  let key = 'GOODKEY';
  const a = A.create({ fpcalc: FPCALC, fetch, base, key: () => key });

  // 1. A fingerprint, made on this computer.
  const fp = await a.fingerprint(songs[0]);
  assert.ok(fp && fp.duration === 20 && /^[A-Za-z0-9_-]{20,}$/.test(fp.fingerprint), JSON.stringify(fp));
  assert.strictEqual(await a.fingerprint(broken), null, 'a file that isn’t really audio has no fingerprint');
  ok('fingerprints are made on this computer (and a broken file simply has none)');

  // 2. Several at once: one request, answers put back in order; the broken file is skipped.
  const heard = await a.recognise([songs[0], broken, songs[1], songs[2]]);
  assert.strictEqual(bodies.length, 1, 'one request for all of them');
  assert.deepStrictEqual(heard.map((h) => h && h.recordings[0].id), ['rec-0', null, 'rec-1', 'rec-2'], 'in the right order');
  assert.strictEqual(heard[0].recordings[0].releases[0].date, '2020-05');
  const sent = new URLSearchParams(bodies[0]);
  assert.deepStrictEqual([...new Set([...sent.keys()].map((k) => k.replace(/\.\d+$/, '')))].sort(), ['client', 'duration', 'fingerprint', 'format', 'meta']);
  assert.ok(!/Secret|\.mp3|shelf-acoustid/.test(decodeURIComponent(bodies[0])), 'no file names or folders are sent');
  ok('several songs in one request; only fingerprints, lengths and your key are sent; answers in order');

  // 3. No key / a wrong key: plain words.
  key = '';
  await assert.rejects(a.lookup([fp]), (e) => e.code === 'NOKEY' && /AcoustID key in Settings/.test(e.message));
  key = 'WRONG';
  await assert.rejects(a.lookup([fp]), (e) => e.code === 'KEY' && /didn’t accept your key/.test(e.message));
  ok('no key, or a wrong one, is explained');

  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(passed + ' AcoustID checks passed');
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
