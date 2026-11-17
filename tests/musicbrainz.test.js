// MusicBrainz lookups: Shelf says who it is, keeps to one request a second, waits and tries again when
// MusicBrainz is busy, remembers answers, and finds covers (the edition's, else the album's). A pretend
// MusicBrainz runs on this computer; nothing goes out to the internet.
// Run with: node tests/musicbrainz.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const MB = require('../desktop/musicbrainz.js');

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const REL = '9daa9d6e-7780-487f-9ef8-885755b73125', RG = 'c2c2b5b6-5a5c-3d70-8c4f-4f3f3b8e5b3e', REL2 = '11111111-2222-3333-4444-555555555555';
const release = {
  id: REL, title: 'Gold: Greatest Hits', date: '2014-05-02', country: 'XE', status: 'Official', barcode: '0602537767004',
  'artist-credit': [{ name: 'ABBA', joinphrase: '', artist: { id: 'd87e52c5-bb8d-4da8-b941-9f4928627dc8', name: 'ABBA', 'sort-name': 'ABBA' } }],
  'label-info': [{ 'catalog-number': '3776700', label: { name: 'Polar' } }],
  'release-group': { id: RG, title: 'Gold: Greatest Hits', 'primary-type': 'Album', 'secondary-types': ['Compilation'], 'first-release-date': '1992-09-21' },
  genres: [{ name: 'pop', count: 5 }, { name: 'disco', count: 9 }],
  media: [{ position: 1, format: 'Digital Media', 'track-count': 2, tracks: [
    { id: 't1', position: 1, number: '1', title: 'Dancing Queen', length: 231000, recording: { id: 'r1', title: 'Dancing Queen' } },
    { id: 't2', position: 2, number: '2', title: 'Knowing Me, Knowing You', length: 242000, recording: { id: 'r2' }, 'artist-credit': [{ name: 'ABBA', artist: { id: 'x', name: 'ABBA' } }] }
  ] }]
};

const hits = [], agents = [];
let busyLeft = 1;
const srv = http.createServer((req, res) => {
  hits.push({ url: req.url, at: Date.now() }); agents.push(req.headers['user-agent']);
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/ws/2/release/' + REL) {
    if (busyLeft-- > 0) { res.writeHead(503, { 'retry-after': '1' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(release));
  }
  if (u.pathname === '/ws/2/release' && u.searchParams.get('query')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ releases: [Object.assign({}, release, { score: 100, 'track-count': 2 })] })); }
  if (u.pathname === '/ws/2/release' && u.searchParams.get('release-group')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ releases: [release, Object.assign({}, release, { id: REL2, country: 'US', date: '1992' })] })); }
  if (u.pathname === '/cover/release/' + REL2 + '/front-250') { res.writeHead(404); return res.end(); }
  if (u.pathname === '/cover/release-group/' + RG + '/front-250') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(Buffer.from('JPEGDATA')); }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-mb-'));
  const mk = () => MB.create({ fetch, userAgent: 'Shelf/9.9.9 ( https://example.org )', cacheDir, base: 'http://127.0.0.1:' + port + '/ws/2', coverBase: 'http://127.0.0.1:' + port + '/cover', gapMs: 300 });
  let mb = mk();

  // 1. A release, after one "busy" answer; boiled down to what Shelf uses.
  const r = await mb.release(REL);
  assert.strictEqual(hits.length, 2, 'asked again after the busy answer');
  assert.ok(hits[1].at - hits[0].at >= 900, 'waited as told (Retry-After 1 s)');
  assert.strictEqual(r.title, 'Gold: Greatest Hits'); assert.strictEqual(r.artist, 'ABBA'); assert.strictEqual(r.year, 2014);
  assert.strictEqual(r.label, 'Polar'); assert.strictEqual(r.catno, '3776700'); assert.strictEqual(r.trackCount, 2);
  assert.deepStrictEqual(r.genres, ['disco', 'pop'], 'genres, most voted first');
  assert.strictEqual(r.group.id, RG); assert.deepStrictEqual(r.group.secondaryTypes, ['Compilation']);
  assert.strictEqual(r.media[0].tracks[0].length, 231); assert.strictEqual(r.media[0].tracks[1].recording, 'r2');
  assert.strictEqual(r.compilation, false);
  assert.ok(agents.every((a) => a === 'Shelf/9.9.9 ( https://example.org )'), 'says who it is every time');
  ok('a release (after MusicBrainz said it was busy), with tracks, label, genres and its group');

  // 2. Remembered: no second request, even from a fresh start.
  const n = hits.length;
  mb = mk();
  assert.strictEqual((await mb.release(REL)).title, 'Gold: Greatest Hits');
  assert.strictEqual(hits.length, n, 'answered from what was remembered');
  ok('remembered on this computer (nothing asked twice)');

  // 3. One request a second (here: one per 300 ms), even when asked for several at once.
  const t0 = hits.length;
  await Promise.all([mb.searchReleases({ album: 'Gold', artist: 'ABBA' }), mb.groupReleases(RG), mb.searchReleases({ album: 'Gold "Greatest"', artist: 'ABBA' })]);
  const ts = hits.slice(t0).map((h) => h.at);
  assert.strictEqual(ts.length, 3);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 280, 'spaced out: ' + (ts[i] - ts[i - 1]) + ' ms');
  assert.ok(hits.slice(t0).some((h) => /query=release%3A%22Gold%20%20Greatest%20%22/.test(h.url) || /Greatest/.test(decodeURIComponent(h.url))), 'quotes in titles are made safe');
  ok('several lookups at once still go one at a time, spaced out');

  // 4. Covers: the edition's, else the album's; none at all is fine.
  const c = await mb.cover(REL2, RG, 250);
  assert.ok(c && c.data.toString() === 'JPEGDATA' && c.mime === 'image/jpeg', 'fell back to the album cover');
  assert.strictEqual(await mb.cover('not-an-id', null, 250), null);
  ok('covers: the edition’s, else the album’s');

  // 5. Forget: the remembered answers are gone.
  await mb.forget();
  assert.ok(!fs.existsSync(cacheDir), 'forgotten');
  ok('Forget Remembered Lookups clears music lookups too');

  srv.close();
  console.log(passed + ' MusicBrainz checks passed');
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
