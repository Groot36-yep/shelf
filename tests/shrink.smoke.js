// End-to-end in the real window: Make Music Smaller on a pretend Plex server (tests/fakeplex.js) with a Music
// library. A real FLAC is copied here, made smaller (Ogg Vorbis), sent back next to the original and checked;
// the original is set aside (Plex ignores "….shelf-original"), Plex rescans its music; Free Up Space lists the
// original as a song made smaller; Undo puts it all back.
// Run with: node tests/shrink.smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fake = require('./fakeplex');
const tags = require('../desktop/tags.js');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALBUM = '/srv/disk1/Music/ABBA/Gold - Greatest Hits (1992)';
const FLAC = ALBUM + '/04 - Mamma Mia.flac', OGG = ALBUM + '/04 - Mamma Mia.ogg', KEPT = FLAC + '.shelf-original';

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-shrink-test-'));
  const local = path.join(tmp, 'mamma.flac');
  execFileSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=20', '-c:a', 'flac', local], { windowsHide: true });
  await tags.writeTo(local, local, { title: 'Mamma Mia', artists: ['ABBA'], album: 'Gold: Greatest Hits', track: 4 });
  const flacSize = fs.statSync(local).size;
  // A renamed song (and its album's cover) in your library folder on this PC, to send.
  const lib = path.join(tmp, 'Plex'), here = path.join(lib, 'Music', 'Ginger Root', 'City Slicker (2020)');
  fs.mkdirSync(here, { recursive: true });
  fs.writeFileSync(path.join(here, '02 - Let’s Stay Out.ogg'), Buffer.alloc(300000, 5)); fs.writeFileSync(path.join(here, 'cover.jpg'), Buffer.alloc(5000, 9));
  fs.mkdirSync(path.join(lib, 'Movies', 'X (2000)'), { recursive: true }); fs.writeFileSync(path.join(lib, 'Movies', 'X (2000)', 'poster.jpg'), 'not sent');
  const srv = await fake.start({ real: { [FLAC]: local }, extra: { [FLAC]: flacSize, [ALBUM + '/01 - Dancing Queen.ogg']: 4e6 } });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const errors = [];
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + profile, ROOT] });
  await app.evaluate(({ app: a, safeStorage }, s) => {
    const fsm = process.mainModule.require('fs'), pm = process.mainModule.require('path');
    const dir = a.getPath('userData');
    fsm.writeFileSync(pm.join(dir, 'shelf-prefs.json'), JSON.stringify({ library: s.lib, server: { host: '127.0.0.1', port: s.port, user: 'me', fingerprint: s.fp, keyType: 'ED25519', auth: 'password', home: '/home/me',
      movies: '/mnt/media/Movies', tv: '/mnt/media/TV', music: '/mnt/media/Music', libraries: [
        { key: '1', kind: 'movies', title: 'Movies', folders: ['/mnt/media/Movies'] },
        { key: '2', kind: 'tv', title: 'TV Shows', folders: ['/mnt/media/TV'] },
        { key: '3', kind: 'music', title: 'Music', folders: ['/mnt/media/Music'] }] } }));
    fsm.writeFileSync(pm.join(dir, 'server-pass.bin'), safeStorage.encryptString(s.pass));
    fsm.writeFileSync(pm.join(dir, 'plex-token.bin'), safeStorage.encryptString('tok12345'));
  }, { port: srv.port, fp: srv.fp, pass: srv.pass, lib });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.waitForLoadState();
  await win.evaluate(() => window.ShelfSend.refresh());

  // 0. Sending music: a song (and its cover.jpg) goes to the server's Music folder; a movie folder's poster doesn't.
  const plan = await win.evaluate(() => window.shelfNative.sendPlan(null));
  assert.ok(plan.files === 2 && plan.fresh === 2 && !plan.missing.length, JSON.stringify(plan));
  await win.evaluate(() => window.shelfNative.send(null, {}));
  const SENT = '/srv/disk1/Music/Ginger Root/City Slicker (2020)/02 - Let’s Stay Out.ogg';
  for (let i = 0; i < 100 && srv.files.get(SENT) !== 300000; i++) await sleep(200);
  assert.strictEqual(srv.files.get(SENT), 300000, 'the song arrived in Music');
  for (let i = 0; i < 50 && !srv.files.has('/srv/disk1/Music/Ginger Root/City Slicker (2020)/cover.jpg'); i++) await sleep(200);
  assert.ok(srv.files.has('/srv/disk1/Music/Ginger Root/City Slicker (2020)/cover.jpg'), 'its cover too');
  assert.ok(![...srv.files.keys()].some((k) => /poster\.jpg/.test(k)), 'no other pictures');
  console.log('  ✓ Send to Plex puts songs (and their album’s cover.jpg) in the server’s Music folder');

  // 1. The menu offers it; the sheet lists the album's lossless song with the space it saves.
  await win.waitForSelector('#shrinkBtn:not([hidden])', { state: 'attached', timeout: 5000 });
  await win.click('#menuBtn'); await win.click('#shrinkBtn');
  await win.waitForSelector('#shrinkSheet[open]', { timeout: 20000 });
  const rows = await win.$$eval('#shList .dp-file', (r) => r.map((x) => x.textContent));
  assert.deepStrictEqual(rows.length, 1, rows.join(' | '));
  assert.match(rows[0], /ABBA \/ Gold - Greatest Hits \(1992\).*1 song/);
  assert.match(await win.textContent('#shLead'), /1 lossless song takes/);
  assert.match(await win.textContent('#shGo'), /Make 1 Song Smaller/);
  console.log('  ✓ Make Music Smaller lists the lossless songs (by album) and what it saves; Ogg files aren’t listed');

  // 2. Make it smaller: an Ogg next to it, the FLAC set aside, Plex rescans its music.
  await win.click('#shGo');
  for (let i = 0; i < 150 && !srv.files.has(KEPT); i++) await sleep(200);
  await sleep(500);
  assert.ok(srv.files.has(OGG) && srv.files.has(KEPT) && !srv.files.has(FLAC), JSON.stringify([...srv.files.keys()].filter((k) => k.includes('Music'))));
  const oggSize = srv.files.get(OGG);
  assert.ok(oggSize > 1000 && oggSize < flacSize / 2, 'smaller: ' + oggSize + ' vs ' + flacSize);
  assert.ok(srv.plexAsked.some((u) => /\/library\/sections\/3\/refresh/.test(u)), 'Plex asked to rescan the music library: ' + srv.plexAsked.join(' '));
  assert.ok(!fs.readdirSync(os.tmpdir()).some((n) => n.startsWith('shelf-shrink-') && !n.startsWith('shelf-shrink-test-') && fs.readdirSync(path.join(os.tmpdir(), n)).length), 'nothing left on this PC');
  console.log('  ✓ made smaller (' + Math.round(flacSize / 1024) + ' KB → ' + Math.round(oggSize / 1024) + ' KB), sent back and checked; the FLAC set aside; Plex rescans');

  // 3. Free Up Space lists the original as a song made smaller.
  await win.click('#menuBtn'); await win.click('#spaceBtn');
  await win.waitForSelector('#spaceSheet[open]', { timeout: 20000 });
  assert.match(await win.textContent('#spList'), /Originals of songs made smaller.*Mamma Mia\.flac/s);
  await win.click('#spaceSheet button[value="cancel"]'); await sleep(300);
  console.log('  ✓ Free Up Space lists the original under “Originals of songs made smaller”');

  // 4. Undo: the Ogg goes, the FLAC is back.
  await win.waitForSelector('#undoBar:not([hidden])', { timeout: 5000 });
  await win.click('#undoBar');
  for (let i = 0; i < 50 && !srv.files.has(FLAC); i++) await sleep(200);
  assert.ok(srv.files.has(FLAC) && !srv.files.has(OGG) && !srv.files.has(KEPT), 'put back');
  console.log('  ✓ Undo puts the FLAC back and removes the smaller copy');

  assert.deepStrictEqual(errors, []);
  await app.close(); srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Make Music Smaller test passed');
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
