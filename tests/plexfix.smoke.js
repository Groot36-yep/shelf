// End-to-end in the real window: Fix My Plex Library against a pretend Plex server (tests/fakeplex.js),
// so it runs on Windows too. Check Library → the messy files are listed and matched (lookups mocked)
// → Rename fixes them on the server → Undo puts them back. Also: the server folder browser opens
// /mnt (a linked drive), says why a folder can't be opened, and the graphics card setting is there.
// Run with: node tests/plexfix.smoke.js   (needs the "playwright" package; SHOTS=dir saves screenshots)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fake = require('./fakeplex');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EPS = [[1, 'Stanley S. SquarePants'], [2, 'Spy Buddies'], [3, 'Rise and Shine'], [4, 'Waiting']];

(async () => {
  const srv = await fake.start();
  const shots = process.env.SHOTS;
  const shot = async (win, name) => { if (shots) await win.screenshot({ path: path.join(shots, name + '.png') }); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const errors = [];
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + profile, ROOT] });
  // A server that's already set up (as after the setup steps), with its password saved encrypted.
  await app.evaluate(({ app: a, safeStorage }, s) => {
    const fsm = process.mainModule.require('fs'), pm = process.mainModule.require('path');
    const dir = a.getPath('userData');
    const prefs = pm.join(dir, 'shelf-prefs.json');
    let p = {}; try { p = JSON.parse(fsm.readFileSync(prefs, 'utf8')); } catch (e) { /* new */ }
    p.server = { host: '127.0.0.1', port: s.port, user: 'me', fingerprint: s.fp, keyType: 'ED25519', auth: 'password', home: '/home/me',
      movies: '/mnt/media/Movies', tv: '/mnt/media/TV', libraries: [
        { key: '1', kind: 'movies', title: 'Movies', folders: ['/mnt/media/Movies'] },
        { key: '2', kind: 'tv', title: 'TV Shows', folders: ['/mnt/media/TV'] }] };
    fsm.writeFileSync(prefs, JSON.stringify(p));
    fsm.writeFileSync(pm.join(dir, 'server-pass.bin'), safeStorage.encryptString(s.pass));
    fsm.writeFileSync(pm.join(dir, 'plex-token.bin'), safeStorage.encryptString('tok12345'));
  }, { port: srv.port, fp: srv.fp, pass: srv.pass });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('api.themoviedb.org/3/search/tv') || (u.includes('api.tvmaze.com') && u.includes('search'))) {
      return u.includes('tvmaze')
        ? route.fulfill({ status: 200, body: JSON.stringify([{ score: 1, show: { id: 387, name: 'SpongeBob SquarePants', premiered: '1999-05-01' } }]), headers: H })
        : route.fulfill({ status: 200, body: JSON.stringify({ results: [{ id: 387, name: 'SpongeBob SquarePants', first_air_date: '1999-05-01', popularity: 50, origin_country: ['US'] }] }), headers: H });
    }
    if (u.includes('api.themoviedb.org/3/tv/387')) return route.fulfill({ status: 200, body: JSON.stringify({ id: 387, number_of_seasons: 5, 'season/5': { episodes: EPS.map(([n, name]) => ({ season_number: 5, episode_number: n, name, air_date: '2007-01-01', runtime: 11 })) } }), headers: H });
    if (u.includes('api.tvmaze.com')) return route.fulfill({ status: 200, body: JSON.stringify(EPS.map(([n, name]) => ({ season: 5, number: n, name }))), headers: H });
    if (u.includes('api.themoviedb.org')) return route.fulfill({ status: 200, body: JSON.stringify({ results: [{ id: 4808, title: 'Charade', release_date: '1963-12-05', popularity: 9 }] }), headers: H });
    return route.continue();
  });
  await win.waitForLoadState();
  await win.click('#menuBtn'); await win.click('#mainMenu [data-open=settings]');
  await win.fill('#keyInput', 'test-key'); await win.dispatchEvent('#keyInput', 'change');
  await sleep(300);
  // The graphics card setting.
  const gpu = await win.evaluate(() => ({ value: document.getElementById('optGpu').value, help: document.getElementById('gpuHelp').textContent }));
  assert.strictEqual(gpu.value, 'auto');
  assert.ok(gpu.help.length > 20, gpu.help);
  await win.evaluate(() => document.getElementById('optGpu').scrollIntoView());
  await shot(win, '1-settings-gpu');
  console.log('  ✓ Settings has the graphics card choice (' + gpu.help.replace(/^.*\. /, '') + ')');
  await win.keyboard.press('Escape'); await sleep(300);

  // Fix My Plex Library.
  await win.evaluate(() => window.ShelfSend.refresh());
  await win.waitForSelector('#fixLibBtn:not([hidden])', { state: 'attached', timeout: 5000 });
  await win.click('#menuBtn'); await win.click('#fixLibBtn');
  for (let i = 0; i < 60; i++) {
    if (await win.evaluate(() => window.Shelf.items().length === 3 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)))) break;
    await sleep(250);
  }
  const listed = await win.evaluate(() => window.Shelf.items().map((i) => ({ name: i.name, status: i.status, plex: i.plexState, remote: i.remote })));
  assert.strictEqual(listed.length, 3, JSON.stringify(listed));
  assert.ok(listed.every((i) => i.remote && i.status === 'matched'), JSON.stringify(listed));
  await shot(win, '2-fix-list');
  console.log('  ✓ Check Library lists the 3 files that need fixing, matched: ' + listed.map((i) => i.name + ' [' + (i.plex || 'subtitle') + ']').join(', '));

  await win.click('#renameBtn'); await sleep(400);
  assert.ok(!(await win.isDisabled('#renameNow')), 'Rename works without a library folder on this PC');
  assert.match(await win.textContent('#renameSummary'), /on your Plex server and will be renamed there/);
  await shot(win, '3-rename-sheet');
  await win.click('#renameNow');
  const want = ['/srv/disk1/Movies/Charade (1963)/Charade (1963).mkv', '/srv/disk1/TV/SpongeBob SquarePants {tmdb-387}/Season 05/SpongeBob SquarePants - S05E03 - Rise and Shine.mkv', '/srv/disk1/TV/SpongeBob SquarePants {tmdb-387}/Season 05/SpongeBob SquarePants - S05E03 - Rise and Shine.en.srt'];
  for (let i = 0; i < 60 && !want.every((f) => srv.files.has(f)); i++) await sleep(250); // renamed one after another
  const now = [...srv.files.keys()].sort();
  assert.ok(now.includes('/srv/disk1/TV/SpongeBob SquarePants {tmdb-387}/Season 05/SpongeBob SquarePants - S05E03 - Rise and Shine.mkv'), now.join('\n'));
  assert.ok(now.includes('/srv/disk1/TV/SpongeBob SquarePants {tmdb-387}/Season 05/SpongeBob SquarePants - S05E03 - Rise and Shine.en.srt'), now.join('\n'));
  assert.ok(now.includes('/srv/disk1/Movies/Charade (1963)/Charade (1963).mkv'), now.join('\n'));
  assert.ok(srv.plexAsked.some((u) => /\/refresh$/.test(u)), 'Plex was asked to rescan');
  await sleep(300);
  await shot(win, '4-renamed');
  console.log('  ✓ Rename fixed them on the server and Plex was asked to rescan');

  await win.waitForSelector('#undoBar:not([hidden])', { timeout: 5000 });
  await win.click('#undoBar');
  for (let i = 0; i < 40 && !srv.files.has('/srv/disk1/Movies/new stuff/Charade.1963.1080p.BluRay.mkv'); i++) await sleep(250);
  assert.ok(srv.files.has('/srv/disk1/TV/Spongebob/Season 5/SpongeBob.SquarePants.S05E03.720p.mkv'));
  assert.ok(srv.files.has('/srv/disk1/Movies/new stuff/Charade.1963.1080p.BluRay.mkv'));
  console.log('  ✓ Undo put them back on the server');

  // The server folder browser: /mnt (a linked drive) opens; a folder you can't open says why.
  await win.evaluate(() => window.ShelfSend.open('ready'));
  await sleep(600);
  await win.click('[data-pick=tv]');
  await win.waitForSelector('#brPath');
  await win.fill('#brPath', '/mnt'); await win.press('#brPath', 'Enter'); await sleep(800);
  const mnt = await win.evaluate(() => [...document.querySelectorAll('#brList .br-name')].map((x) => x.textContent));
  assert.deepStrictEqual(mnt, ['media']);
  const places = await win.evaluate(() => [...document.querySelectorAll('#brPlaces .pill')].map((x) => x.textContent));
  assert.ok(places.includes('/') && places.includes('~ Home'), places.join(','));
  await shot(win, '5-browse-mnt');
  await win.fill('#brPath', '/root'); await win.press('#brPath', 'Enter'); await sleep(800);
  const help = await win.textContent('#brHelp');
  assert.match(help, /isn’t allowed to open this folder[\s\S]*sudo setfacl -R -m u:me:rwX/);
  await shot(win, '6-browse-denied');
  console.log('  ✓ The folder browser opens /mnt (a linked drive), has quick jumps, and explains a folder it can’t open');

  assert.deepStrictEqual(errors.filter((e) => !/favicon|net::ERR/.test(e)), []);
  await app.close();
  srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('Fix My Plex Library smoke test passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
