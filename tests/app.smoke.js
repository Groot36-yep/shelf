// Quick end-to-end check of the desktop app: pick a folder, match (lookups mocked), Rename Now, Undo.
// Run with: xvfb-run -a node tests/app.smoke.js   (needs the "playwright" package)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-app-'));
  const videos = path.join(tmp, 'Downloads'); const lib = path.join(tmp, 'Plex');
  fs.mkdirSync(videos); fs.mkdirSync(lib);
  for (const n of ['charade.1963.1080p.mkv', 'bonanza.s01e01.mkv', "weird 'name' $(x) 2001.mkv"]) fs.writeFileSync(path.join(videos, n), 'v');

  const handle = (route) => {
    const u = route.request().url();
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
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', ROOT] });
  // Pretend the user picked these folders in the system dialogs.
  await app.evaluate(({ dialog }, dirs) => { const q = [...dirs]; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [q.shift()] }); }, [videos, lib]);
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.route('**/*', handle);
  await win.waitForLoadState();
  console.log('url:', win.url(), '| native:', await win.evaluate(() => document.documentElement.classList.contains('native')),
    '| page can use Node:', await win.evaluate(() => typeof require !== 'undefined' || typeof process !== 'undefined'));
  await win.click('.side-item[data-open=settings]');
  await win.fill('#keyInput', 'test-key'); await win.dispatchEvent('#keyInput', 'change');
  await win.keyboard.press('Escape'); await sleep(300);
  await win.click('text=Choose Folder…');
  for (let i = 0; i < 40; i++) {
    if (await win.evaluate(() => window.Shelf.items().length === 3 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)))) break;
    await sleep(250);
  }
  console.log('matched:', await win.evaluate(() => window.Shelf.items().map((i) => i.name + ' -> ' + i.status)));
  await win.click('#renameBtn');
  await win.click('#pickLib'); await sleep(400);
  if (process.env.SHOT) await win.screenshot({ path: process.env.SHOT });
  await win.click('#renameNow'); await sleep(1500);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(lib, path.join(d, e.name))]);
  console.log('library now:', walk(lib));
  console.log('downloads now:', fs.readdirSync(videos));
  console.log('undo button showing:', await win.isVisible('#undoBar'));
  await win.click('#undoBar'); await sleep(1000);
  console.log('after undo -> downloads:', fs.readdirSync(videos), '| library files:', walk(lib).length);
  await app.close();
  console.log('ERRORS:', errors);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
