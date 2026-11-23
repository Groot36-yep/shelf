// Quick end-to-end check of the desktop app: pick a folder, match (lookups mocked), Rename Now, Undo.
// Run with: xvfb-run -a node tests/app.smoke.js   (needs the "playwright" package)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-app-'));
  const videos = path.join(tmp, 'Downloads'); const lib = path.join(tmp, 'Plex');
  fs.mkdirSync(videos); fs.mkdirSync(lib);
  for (const n of ['charade.1963.1080p.mkv', 'bonanza.s01e01.mkv', 'bonanza.s01e01.en.srt', "weird 'name' $(x) 2001.mkv"]) fs.writeFileSync(path.join(videos, n), 'v');

  const handle = (route) => {
    const u = route.request().url();
    if (u.includes('api.themoviedb.org/3/search/tv')) return route.fulfill({ status: 200, body: JSON.stringify({ results: [{ id: 3456, name: 'Bonanza', first_air_date: '1959-09-12', popularity: 20, origin_country: ['US'] }] }), headers: H });
    if (u.includes('api.themoviedb.org/3/tv/3456')) return route.fulfill({ status: 200, body: JSON.stringify({ id: 3456, number_of_seasons: 1, 'season/1': { episodes: [{ season_number: 1, episode_number: 1, name: 'A Rose for Lotta', air_date: '1959-09-12', runtime: 50 }] } }), headers: H });
    if (u.includes('api.themoviedb.org')) {
      const q = decodeURIComponent((u.match(/query=([^&]+)/) || [])[1] || '').toLowerCase();
      const res = q.includes('charade') ? [{ id: 4808, title: 'Charade', release_date: '1963-12-05', popularity: 9 }] : [{ id: 9, title: 'Weird Name', release_date: '2001-01-01', popularity: 1 }];
      return route.fulfill({ status: 200, body: JSON.stringify({ results: res }), headers: H });
    }
    if (u.includes('api.tvmaze.com')) {
      if (u.includes('search')) return route.fulfill({ status: 200, body: JSON.stringify([{ score: 1, show: { id: 1, name: 'Bonanza', premiered: '1959-09-12' } }]), headers: H });
      return route.fulfill({ status: 200, body: JSON.stringify([{ season: 1, number: 1, name: 'A Rose for Lotta' }]), headers: H });
    }
    return route.continue();
  };

  const errors = [];
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-')), ROOT] });
  // Pretend the user picked these folders in the system dialogs.
  await app.evaluate(({ dialog }, dirs) => { const q = [...dirs]; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [q.shift()] }); }, [videos, lib]);
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.route('**/*', handle);
  await win.waitForLoadState();
  console.log('version:', await win.textContent('#appVersion'));
  const native = await win.evaluate(() => document.documentElement.classList.contains('native'));
  const pageNode = await win.evaluate(() => typeof require !== 'undefined' || typeof process !== 'undefined');
  console.log('url:', win.url(), '| native:', native, '| page can use Node:', pageNode);
  // The window is Shelf's own page, with Shelf's bridge, and never Node.
  assert.strictEqual(win.url(), 'app://shelf/index.html');
  assert.strictEqual(native, true, 'the desktop bridge is there');
  assert.strictEqual(pageNode, false, 'the page must not be able to use Node');
  assert.match(await win.textContent('#appVersion'), new RegExp(require('../package.json').version.replace(/\./g, '\\.')));
  await win.click('#menuBtn'); await win.click('#mainMenu [data-open=settings]');
  await win.click('#setTabs [data-page=keys]'); await win.fill('#keyInput', 'test-key'); await win.dispatchEvent('#keyInput', 'change');
  await win.keyboard.press('Escape'); await sleep(300);
  await win.click('#chooseFolder');
  for (let i = 0; i < 40; i++) {
    if (await win.evaluate(() => window.Shelf.items().length === 4 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)))) break;
    await sleep(250);
  }
  const matched = await win.evaluate(() => window.Shelf.items().map((i) => i.name + ' -> ' + i.status));
  console.log('matched:', matched);
  assert.strictEqual(matched.length, 4);
  assert.ok(matched.every((m) => / -> matched$/.test(m)), 'every file matched');
  await win.click('#renameBtn');
  await win.click('#pickLib'); await sleep(400);
  if (process.env.SHOT) await win.screenshot({ path: process.env.SHOT });
  await win.click('#renameNow'); await sleep(1500);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(lib, path.join(d, e.name))]);
  const named = walk(lib).map((p) => p.split(path.sep).join('/')).sort();
  console.log('library now:', named);
  console.log('downloads now:', fs.readdirSync(videos));
  assert.deepStrictEqual(named, [
    'Movies/Charade (1963)/Charade (1963).mkv',
    'Movies/Weird Name (2001)/Weird Name (2001).mkv',
    'TV Shows/Bonanza {tmdb-3456}/Season 01/Bonanza - S01E01 - A Rose for Lotta.en.srt',
    'TV Shows/Bonanza {tmdb-3456}/Season 01/Bonanza - S01E01 - A Rose for Lotta.mkv'
  ], 'named and filed the Plex way (subtitles with their video)');
  assert.deepStrictEqual(fs.readdirSync(videos), [], 'moved out of Downloads');
  const undoShown = await win.isVisible('#undoBar');
  console.log('undo button showing:', undoShown);
  assert.ok(undoShown, 'Undo is offered');
  await win.click('#undoBar'); await sleep(1000);
  const back = fs.readdirSync(videos).sort();
  console.log('after undo -> downloads:', back, '| library files:', walk(lib).length);
  assert.deepStrictEqual(back, ['bonanza.s01e01.en.srt', 'bonanza.s01e01.mkv', 'charade.1963.1080p.mkv', "weird 'name' $(x) 2001.mkv"], 'Undo put every file back');
  assert.strictEqual(walk(lib).length, 0, 'and left nothing in the library');
  await app.close();
  console.log('ERRORS:', errors);
  assert.deepStrictEqual(errors, [], 'no errors in the window');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('App test passed');
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
