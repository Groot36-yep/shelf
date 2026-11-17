// End-to-end: music. A folder with an album (tagged, no MusicBrainz ids), its lyrics, a loose song and a damaged
// file; a pretend MusicBrainz + Cover Art Archive on this computer. Albums appear as shelves, the right edition
// is found, the tags before → after are shown, another edition can be picked, Rename Now writes tags + cover and
// files the songs the Plex way, and Undo puts everything back.
// Run with: node tests/music.smoke.js     (SHOT=dir for screenshots)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');
const tags = require('../desktop/tags.js');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT = process.env.SHOT;
const ff = require('ffmpeg-static');
const run = (args) => execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { windowsHide: true });

// ---- A pretend MusicBrainz ----
const ART = 'd87e52c5-bb8d-4da8-b941-9f4928627dc8', GR = 'c2c2b5b6-5a5c-3d70-8c4f-4f3f3b8e5b3e';
const R1 = '11111111-1111-1111-1111-111111111111', R2 = '22222222-2222-2222-2222-222222222222', R3 = '33333333-3333-3333-3333-333333333333';
const GINGER = '44444444-4444-4444-4444-444444444444', GG = '55555555-5555-5555-5555-555555555555';
const tr = (n, title, len, extra) => Object.assign({ id: 't' + n + title.length, position: n, number: String(n), title, length: len * 1000, recording: { id: 'rec-' + title.replace(/\W+/g, '') } }, extra || {});
const ac = (name, id) => [{ name, joinphrase: '', artist: { id, name, 'sort-name': name } }];
const gold = (id, date, country, format, tracks) => ({ id, title: 'Gold: Greatest Hits', date, country, status: 'Official', 'artist-credit': ac('ABBA', ART), 'label-info': [{ 'catalog-number': 'CAT-' + id.slice(0, 2), label: { name: 'Polar' } }],
  'release-group': { id: GR, title: 'Gold: Greatest Hits', 'primary-type': 'Album', 'secondary-types': ['Compilation'], 'first-release-date': '1992-09-21' },
  media: [{ position: 1, format, 'track-count': tracks.length, tracks }], 'track-count': tracks.length });
const T5 = [tr(1, 'Dancing Queen', 6), tr(2, 'Knowing Me, Knowing You', 9), tr(3, 'Take a Chance on Me', 5), tr(4, 'Mamma Mia', 9), tr(5, 'Lay All Your Love on Me', 7)];
const RELS = {
  [R1]: gold(R1, '1992-09-21', 'XE', 'CD', T5),
  [R2]: gold(R2, '2008-10-18', 'XW', 'Digital Media', T5.concat([tr(6, 'Bonus Song', 9)])),
  [R3]: gold(R3, '2014-04-04', 'US', '12" Vinyl', T5),
  [GINGER]: { id: GINGER, title: 'City Slicker', date: '2020-05-01', country: 'XW', status: 'Official', 'artist-credit': ac('Ginger Root', 'g'), 'release-group': { id: GG, title: 'City Slicker', 'primary-type': 'EP', 'secondary-types': [], 'first-release-date': '2020-05-01' },
    media: [{ position: 1, format: 'Digital Media', 'track-count': 2, tracks: [tr(1, 'Loretta', 9), tr(2, 'Let’s Stay Out', 6)] }], 'track-count': 2 }
};
const hits = [];
const mbServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); hits.push(decodeURIComponent(req.url));
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  let m;
  if ((m = /^\/ws\/2\/release\/([0-9a-f-]{36})$/.exec(u.pathname))) return RELS[m[1]] ? json(RELS[m[1]]) : (res.writeHead(404), res.end());
  if (u.pathname === '/ws/2/release' && u.searchParams.get('release-group') === GR) return json({ releases: [RELS[R1], RELS[R2], RELS[R3]] });
  if (u.pathname === '/ws/2/release' && /Gold/i.test(u.searchParams.get('query') || '')) return json({ releases: [RELS[R3], RELS[R2], RELS[R1]].map((r) => Object.assign({ score: 100 }, r)) });
  if (u.pathname === '/ws/2/release') return json({ releases: [] });
  if (u.pathname === '/ws/2/recording' && /Stay Out/i.test(u.searchParams.get('query') || '')) return json({ recordings: [{ id: 'rec-LetsStayOut', title: 'Let’s Stay Out', length: 6000, score: 100, 'artist-credit': ac('Ginger Root', 'g'),
    releases: [{ id: GINGER, title: 'City Slicker', date: '2020-05-01', status: 'Official', 'release-group': { id: GG, 'primary-type': 'EP', 'secondary-types': [] } }] }] });
  if (u.pathname === '/ws/2/recording') return json({ recordings: [] });
  if (u.pathname.startsWith('/ws/2/release-group')) return json({ 'release-groups': [] });
  if (u.pathname.startsWith('/cover/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(COVER); }
  res.writeHead(404); res.end();
});
let COVER;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-music-'));
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  const dl = path.join(tmp, 'Downloads'), album = path.join(dl, 'Music', 'ABBA', 'Gold'), va = path.join(dl, 'Music', 'Various Artists'), lib = path.join(tmp, 'Plex');
  fs.mkdirSync(album, { recursive: true }); fs.mkdirSync(va, { recursive: true }); fs.mkdirSync(lib);
  const jpg = path.join(tmp, 'c.jpg'); run(['-f', 'lavfi', '-i', 'color=c=orange:s=300x300', '-frames:v', '1', jpg]); COVER = fs.readFileSync(jpg);
  const song = async (file, secs, t) => { run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + secs, '-c:a', 'libmp3lame', '-b:a', '64k', file]); await tags.writeTo(file, file, t); };
  const base = { album: 'Gold: Greatest Hits', albumArtists: ['ABBA'], artists: ['ABBA'], year: 1992 };
  await song(path.join(album, '01 Dancing Queen.mp3'), 6, Object.assign({ title: 'Dancing Queen', track: 1 }, base));
  await song(path.join(album, '03 Take a Chance on Me.mp3'), 5, Object.assign({ title: 'Take a Chance on Me', track: 3 }, base));
  await song(path.join(album, '05 Lay All Your Love on Me.mp3'), 7, Object.assign({ title: 'Lay All Your Love on Me', track: 5 }, base));
  // A lossless song (made smaller in Rename Now).
  const flac = path.join(album, '04 Mamma Mia.flac');
  run(['-f', 'lavfi', '-i', 'sine=frequency=550:duration=9', '-c:a', 'flac', flac]); await tags.writeTo(flac, flac, Object.assign({ title: 'Mamma Mia', track: 4 }, base));
  fs.writeFileSync(path.join(album, '01 Dancing Queen.lrc'), '[00:01.00]You can dance\n');
  await song(path.join(va, 'Ginger Root - Let’s Stay Out.mp3'), 6, { title: 'Let’s Stay Out', artists: ['Ginger Root'] });
  fs.writeFileSync(path.join(album, '1-06 At the Door.mp3'), Buffer.alloc(5000, 7)); // damaged
  const before = tags.read(path.join(album, '01 Dancing Queen.mp3'));

  await new Promise((r) => mbServer.listen(0, '127.0.0.1', r));
  const port = mbServer.address().port;
  const exe = path.join(ROOT, 'node_modules/electron/dist/electron');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--user-data-dir=' + profile, ROOT] });
  await app.evaluate(({ dialog }, o) => {
    const q = [...o.dirs];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [q.shift()] });
    global.__shelfConsent = async () => true;
    global.__shelfMusicTest = { base: 'http://127.0.0.1:' + o.port + '/ws/2', coverBase: 'http://127.0.0.1:' + o.port + '/cover', gapMs: 0, trashDir: o.bin };
  }, { dirs: [dl, lib], port, bin });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.waitForLoadState();
  const state = () => win.evaluate(() => window.Shelf.items().map((i) => ({ name: i.name, kind: i.kind, status: i.status, error: i.error, linkTo: i.linkTo || null, track: i.music && i.music.track ? i.music.track.position : null, album: i.music && i.music.album })));

  // 1. Add the folder: songs (and their lyrics) become album shelves.
  await win.click('#chooseFolder');
  for (let i = 0; i < 100; i++) { await sleep(150); if (await win.evaluate(() => window.Shelf.items().length === 7 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)))) break; }
  await sleep(600); // (the next redraw)
  let s = await state();
  console.log(JSON.stringify(s));
  const by = (n) => s.find((x) => x.name === n);
  assert.ok(s.every((x) => x.kind === 'track'), 'all music');
  assert.strictEqual(by('01 Dancing Queen.mp3').status, 'matched', 'found by its tags (title, number, length): ' + by('01 Dancing Queen.mp3').error);
  assert.deepStrictEqual(['01 Dancing Queen.mp3', '03 Take a Chance on Me.mp3', '04 Mamma Mia.flac', '05 Lay All Your Love on Me.mp3'].map((n) => by(n).track), [1, 3, 4, 5]);
  assert.ok(by('01 Dancing Queen.lrc').linkTo, 'lyrics go with their song');
  assert.strictEqual(by('1-06 At the Door.mp3').status, 'error');
  assert.match(by('1-06 At the Door.mp3').error, /damaged/);
  assert.strictEqual(by('Ginger Root - Let’s Stay Out.mp3').track, 2, 'a loose song placed on its album');
  const heads = await win.$$eval('#list .shelf-head h3', (h) => h.map((x) => x.textContent));
  assert.ok(heads.includes('Gold: Greatest Hits') && heads.includes('City Slicker'), 'album shelves: ' + heads);
  const meta = await win.$$eval('#list .album-head', (hs) => hs.find((h) => /Gold/.test(h.textContent)).querySelector('.shelf-meta').textContent);
  assert.match(meta, /ABBA · 1992 · 4 of 5 songs/, 'heading: ' + meta);
  assert.ok(hits.some((h) => /query=release:"Gold: Greatest Hits" AND artist:"ABBA"/.test(h)), 'searched by album + artist');
  console.log('  ✓ albums as shelves; songs on their tracks; lyrics with their song; a damaged file explained; a loose song on its album');

  // 2. The details: the edition, and the tags before → after.
  await win.evaluate(() => { const it = window.Shelf.items().find((i) => i.name === '01 Dancing Queen.mp3'); document.querySelector('[data-id="' + it.id + '"]').click(); });
  await sleep(300);
  assert.ok(await win.isVisible('#inspMusic'));
  const diff = await win.$$eval('#inspMusic .td-row.is-changed .td-k', (x) => x.map((n) => n.textContent));
  assert.ok(diff.includes('Track') && diff.includes('MusicBrainz link'), 'changed tags shown: ' + diff);
  assert.ok(!diff.includes('Title'), 'the title stays');
  assert.match(await win.textContent('#inspFile'), /01 - Dancing Queen\.mp3/);
  assert.match(await win.textContent('#inspCrumbs'), /Music.*ABBA.*Gold - Greatest Hits \(1992\)/);
  if (SHOT) { await sleep(500); await win.screenshot({ path: path.join(SHOT, 'music-album.png') }); }
  console.log('  ✓ details: the edition, the tags before → after, the new name');

  // 3. Other editions: the list, and picking another one.
  await win.click('#inspMusic button:has-text("Other Editions")');
  await win.waitForSelector('#mxEditions .mx-option');
  const eds = await win.$$eval('#mxEditions .mx-option', (x) => x.map((n) => n.textContent));
  assert.strictEqual(eds.length, 3, eds.join(' | '));
  assert.ok(eds.some((e) => /Shelf’s pick/.test(e)));
  if (SHOT) await win.screenshot({ path: path.join(SHOT, 'music-editions.png') });
  const picked = await win.evaluate(() => window.Shelf.music.albumOf(window.Shelf.items()[0]).release.id);
  const other = [R1, R2, R3].indexOf(picked) === 1 ? 0 : 1; // another one
  await win.click('#mxEditions .mx-option >> nth=' + other);
  for (let i = 0; i < 40; i++) { await sleep(100); if (await win.evaluate((p) => window.Shelf.music.albumOf(window.Shelf.items()[0]).release.id !== p, picked)) break; }
  const now = await win.evaluate(() => { const a = window.Shelf.music.albumOf(window.Shelf.items()[0]); return { id: a.release.id, picked: a.picked }; });
  assert.ok(now.id !== picked && now.picked, 'another edition chosen: ' + JSON.stringify(now));
  console.log('  ✓ Other Editions lists every edition and switches to the one picked');

  // The loose song was found by its title only: it waits for a yes (Looks Right on its album).
  assert.match(await win.textContent('#list'), /Found by its title\. Is this the right album\?/);
  await win.click('#list .album-head:has-text("City Slicker") button:has-text("Looks Right")'); await sleep(300);
  assert.strictEqual((await state()).find((x) => /Ginger/.test(x.name)).status, 'review');
  assert.ok(await win.evaluate(() => window.Shelf.items().find((i) => /Ginger/.test(i.name)).confirmed), 'confirmed');

  // 4. Rename Now: tags + cover written, Plex folders, lyrics along; Undo puts it all back.
  await win.click('#renameBtn');
  await win.click('#pickLib'); await sleep(300);
  // Make the lossless one smaller.
  assert.ok(await win.isVisible('#renameShrinkRow'));
  assert.match(await win.textContent('#renameShrinkLabel'), /Make 1 lossless song smaller \(Ogg Vorbis\)/);
  assert.match(await win.textContent('#renameShrinkHelp'), /Recycle Bin/);
  await win.click('#renameShrinkRow .switch'); await sleep(200);
  assert.match(await win.textContent('#renameSummary'), /6 music files/);
  await win.click('#renameNow');
  for (let i = 0; i < 100; i++) { await sleep(200); if (!(await win.isVisible('#renameSheet'))) break; }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(lib, path.join(d, e.name)).split(path.sep).join('/')]);
  const made = walk(lib).sort();
  console.log('library:', made);
  const A = 'Music/ABBA/Gold - Greatest Hits (1992)/';
  assert.deepStrictEqual(made, [A + '01 - Dancing Queen.lrc', A + '01 - Dancing Queen.mp3', A + '03 - Take a Chance on Me.mp3', A + '04 - Mamma Mia.ogg', A + '05 - Lay All Your Love on Me.mp3', A + 'cover.jpg',
    'Music/Ginger Root/City Slicker (2020)/02 - Let’s Stay Out.mp3', 'Music/Ginger Root/City Slicker (2020)/cover.jpg']);
  const t = tags.read(path.join(lib, A + '01 - Dancing Queen.mp3'));
  assert.strictEqual(t.title, 'Dancing Queen'); assert.strictEqual(t.trackTotal, now.id === R2 ? 6 : 5); assert.strictEqual(t.mb.release, now.id);
  assert.ok(t.cover && t.cover.size === COVER.length, 'cover embedded');
  const mm = tags.read(path.join(lib, A + '04 - Mamma Mia.ogg'));
  assert.ok(mm.ok && mm.format === 'ogg' && mm.title === 'Mamma Mia' && mm.mb.release === now.id && mm.cover, 'made smaller, with its tags: ' + JSON.stringify(mm));
  assert.ok(!fs.existsSync(flac) && fs.existsSync(path.join(bin, '04 Mamma Mia.flac')), 'the FLAC went to the (pretend) Recycle Bin');
  console.log('  ✓ Rename Now: Plex folders and names, tags and cover written, cover.jpg, lyrics along; the FLAC made smaller (Ogg Vorbis)');
  await win.click('#undoBar');
  for (let i = 0; i < 50; i++) { await sleep(200); if (fs.existsSync(path.join(album, '01 Dancing Queen.mp3'))) break; }
  await sleep(500);
  const back = tags.read(path.join(album, '01 Dancing Queen.mp3'));
  assert.strictEqual(back.mb.release, '', 'old tags back (no MusicBrainz id)');
  assert.strictEqual(back.trackTotal, before.trackTotal);
  assert.ok(fs.existsSync(path.join(album, '01 Dancing Queen.lrc')));
  assert.deepStrictEqual(walk(lib), [], 'library empty again');
  console.log('  ✓ Undo: names, tags and covers back');

  assert.deepStrictEqual(errors, [], 'no errors in the window');
  await app.close(); mbServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Music test passed');
})().catch(async (e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
