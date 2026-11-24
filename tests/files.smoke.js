// End-to-end in the real window: Server Files against a pretend Plex server (tests/fakeplex.js), so it runs on
// Windows too. Opens from the ⚙ menu once a server is set up; browses both sides (starting at the library
// folders, quick links, Up, sorting); copies a folder to this PC with the button and a file to the server by
// dragging; files already there ask once (Keep Both); Pause and Resume in the queue; New Folder, Rename and
// Delete (which asks first) on the server. This PC's side uses a temporary folder, never your own.
// Run with: node tests/files.smoke.js   (needs the "playwright" package; SHOTS=dir saves screenshots of both looks)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fake = require('./fakeplex');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = crypto.randomBytes(3 << 20);
  const net = { mbps: 100000, ms: 0 };
  const srv = await fake.start({ keep: true, net, content: {
    '/srv/disk1/TV/Show X/Season 01/Show X - S01E01 - Pilot.mkv': A,
    '/srv/disk1/TV/Show X/Season 01/Show X - S01E01 - Pilot.en.srt': 'subtitles',
    '/srv/disk1/TV/Show X/Season 01/Show X - S01E02 - Second.mkv': crypto.randomBytes(1 << 20),
    '/srv/disk1/Movies/Big Movie (2001)/Big Movie (2001).mkv': crypto.randomBytes(10 << 20)
  } });
  const shots = process.env.SHOTS;
  const shot = async (win, name) => { if (shots) await win.screenshot({ path: path.join(shots, name + '.png') }); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-pc-'));
  const vids = path.join(home, 'Videos');
  for (const d of ['Videos', 'Music', 'Downloads', 'Desktop']) fs.mkdirSync(path.join(home, d));
  fs.mkdirSync(path.join(vids, 'Home Movies'));
  fs.writeFileSync(path.join(vids, 'Holiday (2019).mkv'), crypto.randomBytes(600 * 1024));
  fs.writeFileSync(path.join(vids, 'Notes.txt'), 'hello');
  const errors = [];
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + profile, ROOT] });
  // A server that's already set up, and this PC's folders pointed at a temporary one.
  await app.evaluate(({ app: a, safeStorage }, s) => {
    const fsm = process.mainModule.require('fs'), pm = process.mainModule.require('path');
    for (const n of ['videos', 'music', 'downloads', 'desktop']) a.setPath(n, pm.join(s.home, n[0].toUpperCase() + n.slice(1)));
    a.setPath('home', s.home);
    const dir = a.getPath('userData');
    const prefs = pm.join(dir, 'shelf-prefs.json');
    let p = {}; try { p = JSON.parse(fsm.readFileSync(prefs, 'utf8')); } catch (e) { /* new */ }
    p.server = { host: '127.0.0.1', port: s.port, user: 'me', fingerprint: s.fp, keyType: 'ED25519', auth: 'password', home: '/home/me',
      movies: '/mnt/media/Movies', tv: '/mnt/media/TV', options: { verify: true, scan: false }, libraries: [
        { key: '1', kind: 'movies', title: 'Movies', folders: ['/mnt/media/Movies'] },
        { key: '2', kind: 'tv', title: 'TV Shows', folders: ['/mnt/media/TV'] }] };
    fsm.writeFileSync(prefs, JSON.stringify(p));
    fsm.writeFileSync(pm.join(dir, 'server-pass.bin'), safeStorage.encryptString(s.pass));
  }, { port: srv.port, fp: srv.fp, pass: srv.pass, home });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.waitForLoadState();
  await win.setViewportSize({ width: 1320, height: 840 }).catch(() => {});
  const names = (side) => win.$$eval('.xf-pane[data-side=' + side + '] .xf-row .xf-name', (r) => r.map((x) => x.textContent));
  const crumbs = (side) => win.$$eval('.xf-pane[data-side=' + side + '] .xf-crumb', (r) => r.map((x) => x.textContent));
  const row = (side, name) => '.xf-pane[data-side=' + side + '] .xf-row[data-name="' + name + '"]';
  const waitFor = async (fn, what, ms) => { for (let i = 0; i < (ms || 15000) / 100; i++) { if (await fn()) return; await sleep(100); } throw new Error('waited too long for ' + what); };
  const jobs = () => win.evaluate(() => window.ShelfFiles._queue().jobs);
  const allDone = async () => (await jobs()).every((j) => j.state === 'done' || j.state === 'failed');

  // ---- Only once a server is set up, from the ⚙ menu ----
  await win.evaluate(() => window.ShelfSend.refresh());
  await win.waitForSelector('#filesBtn:not([hidden])', { state: 'attached', timeout: 5000 });
  await win.click('#menuBtn'); await win.click('#filesBtn');
  await win.waitForSelector('#xferSheet[open]');
  await waitFor(async () => (await names('server')).length && (await names('pc')).length, 'both sides to list');
  assert.deepStrictEqual(await crumbs('server'), ['/', 'mnt', 'media'], 'starts at the folder holding the library folders');
  assert.deepStrictEqual((await names('server')).sort(), ['Movies', 'TV']);
  const places = await win.$$eval('.xf-pane[data-side=server] .xf-place', (b) => b.map((x) => x.textContent));
  assert.deepStrictEqual(places, ['Movies', 'TV Shows', 'Home']);
  assert.deepStrictEqual(await names('pc'), ['Home Movies', 'Holiday (2019).mkv', 'Notes.txt'], 'this PC starts in Videos, folders first');
  assert.strictEqual(await win.textContent('#xfToPC'), 'Copy to This PC');
  assert.ok(await win.isDisabled('#xfToPC'), 'nothing picked yet');
  console.log('  ✓ Server Files opens from the menu: server at ' + '/' + (await crumbs('server')).slice(1).join('/') + ' (quick links: ' + places.join(', ') + '), this PC in Videos');

  // ---- Browsing: quick link, double-click, Up, sorting ----
  await win.click('.xf-pane[data-side=server] .xf-place:has-text("TV Shows")');
  await waitFor(async () => (await names('server')).includes('Show X'), 'the TV folder');
  await win.dblclick(row('server', 'Show X'));
  await waitFor(async () => (await names('server')).join() === 'Season 01', 'Show X');
  await win.click('.xf-pane[data-side=server] .xf-bar .xf-ibtn[aria-label="Up one folder"]');
  await waitFor(async () => (await crumbs('server')).pop() === 'TV', 'going up');
  assert.strictEqual(await win.getAttribute(row('server', 'Show X'), 'aria-selected'), 'true', 'the folder you came from stays picked');
  await win.click('.xf-pane[data-side=pc] .xf-col-size'); // biggest first (folders stay on top)
  assert.deepStrictEqual(await names('pc'), ['Home Movies', 'Holiday (2019).mkv', 'Notes.txt']);
  await win.click('.xf-pane[data-side=pc] .xf-col-size');
  assert.deepStrictEqual(await names('pc'), ['Home Movies', 'Notes.txt', 'Holiday (2019).mkv'], 'smallest first');
  await win.click('.xf-pane[data-side=pc] .xf-col-name');
  console.log('  ✓ quick links, double-click to open, Up (back where you were), sorting by size');

  // ---- Server → this PC, with the button ----
  await win.click(row('server', 'Show X'));
  assert.match(await win.textContent('.xf-pane[data-side=server] .xf-selinfo'), /1 folder selected/);
  await win.click('#xfToPC');
  await waitFor(async () => (await jobs()).length && await allDone(), 'the copy');
  const ep = path.join(vids, 'Show X', 'Season 01', 'Show X - S01E01 - Pilot.mkv');
  assert.ok(fs.readFileSync(ep).equals(A), 'the same bytes arrived');
  await waitFor(async () => (await names('pc')).includes('Show X'), 'this PC’s side to show it');
  const info = await win.textContent('.xf-job[data-state=done] .xf-jinfo');
  assert.match(info, /Copied 3 files/, info);
  await shot(win, 'files-1-copied');
  console.log('  ✓ Copy to This PC: a whole folder (' + info + '), shown on this PC’s side');

  // ---- Already there: asked once ----
  fs.writeFileSync(ep, 'changed on this PC');
  await win.click(row('server', 'Show X'));
  await win.click('#xfToPC');
  await win.waitForSelector('.xf-ask[open]');
  const title = await win.textContent('#xfAskTitle');
  assert.match(title, /A file is already there/, title);
  assert.match(await win.textContent('.xf-ask .xf-check'), /Skip the 2 files that are the same size and date/);
  await sleep(400); await shot(win, 'files-2-already-there');
  await win.click('.xf-ask .xf-choice:has-text("Keep Both")');
  await win.click('#xfAskOk');
  await waitFor(async () => (await jobs()).length === 2 && await allDone(), 'the second copy');
  assert.ok(fs.readFileSync(path.join(vids, 'Show X', 'Season 01', 'Show X - S01E01 - Pilot (2).mkv')).equals(A), 'Keep Both');
  assert.strictEqual(fs.readFileSync(ep, 'utf8'), 'changed on this PC');
  assert.match(await win.textContent('.xf-job:last-child .xf-jinfo'), /2 files already there, skipped/);
  console.log('  ✓ files already there: asked once (Skip / Replace / Keep Both), the same ones skipped');

  // ---- This PC → server, by dragging ----
  await win.click('.xf-pane[data-side=server] .xf-place:has-text("Movies")');
  await waitFor(async () => (await names('server')).includes('Big Movie (2001)'), 'Movies');
  await win.dragAndDrop(row('pc', 'Holiday (2019).mkv'), '.xf-pane[data-side=server] .xf-list');
  await waitFor(async () => (await jobs()).length === 3 && await allDone(), 'the upload');
  assert.ok(srv.kept.get('/srv/disk1/Movies/Holiday (2019).mkv').equals(fs.readFileSync(path.join(vids, 'Holiday (2019).mkv'))), 'on the server');
  await waitFor(async () => (await names('server')).includes('Holiday (2019).mkv'), 'the server side to show it');
  console.log('  ✓ dragging a file from this PC onto the server copies it there');

  // ---- Picking several: a box dragged from an empty spot, Ctrl to toggle, Shift+click for a run ----
  const picked = (side) => win.$$eval('.xf-pane[data-side=' + side + '] .xf-row[aria-selected="true"]', (r) => r.map((x) => x.dataset.name));
  const pcRows = await win.$$('.xf-pane[data-side=pc] .xf-row');
  const pcNames = await names('pc');
  assert.ok(pcRows.length >= 4, 'enough files on this PC side to pick from: ' + pcNames.length);
  const boxOf = async (k) => pcRows[k].boundingBox();
  const r0 = await boxOf(0), r2 = await boxOf(2), r3 = await boxOf(3);
  // From the date column of the first row (not its name) down to the third: those three.
  await win.mouse.move(r0.x + r0.width - 20, r0.y + 8); await win.mouse.down();
  await win.mouse.move(r2.x + r2.width - 60, r2.y + r2.height / 2, { steps: 6 });
  if (process.env.SHOT) await win.screenshot({ path: process.env.SHOT });
  await win.mouse.up();
  assert.deepStrictEqual(await picked('pc'), pcNames.slice(0, 3), 'the box picks the rows it touches');
  // Ctrl + a box over the fourth: added; Ctrl + a box over the first: taken off.
  await win.keyboard.down('Control');
  await win.mouse.move(r3.x + r3.width - 20, r3.y + 4); await win.mouse.down(); await win.mouse.move(r3.x + r3.width - 40, r3.y + r3.height - 4, { steps: 4 }); await win.mouse.up();
  await win.mouse.move(r0.x + r0.width - 20, r0.y + 4); await win.mouse.down(); await win.mouse.move(r0.x + r0.width - 40, r0.y + r0.height - 4, { steps: 4 }); await win.mouse.up();
  await win.keyboard.up('Control');
  assert.deepStrictEqual(await picked('pc'), pcNames.slice(1, 4), 'Ctrl toggles what the box touches');
  // A click on a name, then Shift+click another: the run between them.
  await win.click(row('pc', pcNames[0]) + ' .xf-name');
  await win.click(row('pc', pcNames[3]) + ' .xf-name', { modifiers: ['Shift'] });
  assert.deepStrictEqual(await picked('pc'), pcNames.slice(0, 4), 'Shift+click picks the run');
  assert.match(await win.textContent('.xf-pane[data-side=pc] .xf-selinfo'), /selected$/, 'the footer counts what’s picked');
  // A plain box elsewhere starts over.
  await win.mouse.move(r2.x + r2.width - 20, r2.y + 4); await win.mouse.down(); await win.mouse.move(r2.x + r2.width - 40, r2.y + r2.height - 4, { steps: 4 }); await win.mouse.up();
  assert.deepStrictEqual(await picked('pc'), [pcNames[2]]);
  console.log('  ✓ picking several: a box from an empty spot, Ctrl to toggle, Shift+click for a run');

  // ---- Pause and Resume ----
  net.mbps = 30; net.ms = 2;
  await win.dblclick(row('server', 'Big Movie (2001)'));
  await waitFor(async () => (await names('server')).length === 1, 'the movie folder');
  await win.click(row('server', 'Big Movie (2001).mkv'));
  await win.click('#xfToPC');
  await waitFor(async () => (await jobs()).some((j) => j.state === 'running' && j.bytesDone > 0), 'the copy to start');
  await shot(win, 'files-3-copying');
  await win.click('.xf-job[data-state=running] .xf-pause');
  await waitFor(async () => (await jobs()).some((j) => j.state === 'paused'), 'pausing');
  const paused = await win.textContent('.xf-job[data-state=paused] .xf-jinfo');
  assert.match(paused, /Paused at [1-9]\d*% · [\d.]+ [KM]B of 10.5 MB/, paused);
  assert.ok(fs.existsSync(path.join(vids, '.Big Movie (2001).mkv.shelf-part')) && !fs.existsSync(path.join(vids, 'Big Movie (2001).mkv')), 'only a temporary piece meanwhile');
  net.mbps = 100000;
  await win.click('.xf-job[data-state=paused] .xf-resume');
  await waitFor(allDone, 'resuming');
  assert.strictEqual(fs.statSync(path.join(vids, 'Big Movie (2001).mkv')).size, 10 << 20);
  await win.click('#xfClear');
  await waitFor(async () => !(await jobs()).length, 'Clear Finished');
  console.log('  ✓ Pause (' + paused + ') and Resume; Clear Finished empties the list');

  // ---- New Folder, Rename, Delete on the server ----
  await win.click('.xf-pane[data-side=server] .xf-ibtn[aria-label="New folder"]');
  await win.waitForSelector('.xf-ask[open] #xfName');
  await win.fill('#xfName', 'Extras');
  await win.click('#xfAskOk');
  await waitFor(async () => (await names('server')).includes('Extras'), 'the new folder');
  assert.strictEqual(await win.getAttribute(row('server', 'Extras'), 'aria-selected'), 'true');
  await win.keyboard.press('F2');
  await win.waitForSelector('.xf-ask[open] #xfName');
  await win.fill('#xfName', 'Bonus');
  await win.click('#xfAskOk');
  await waitFor(async () => (await names('server')).includes('Bonus'), 'the rename');
  await win.click(row('server', 'Bonus'));
  await win.click('.xf-pane[data-side=server] .xf-danger');
  await win.waitForSelector('.xf-ask[open]');
  assert.match(await win.textContent('.xf-ask[open]'), /can’t be undone/);
  await sleep(400); await shot(win, 'files-4-delete');
  await win.click('#xfAskOk');
  await waitFor(async () => !(await names('server')).includes('Bonus'), 'deleting');
  assert.ok(!srv.dirs.has('/srv/disk1/Movies/Big Movie (2001)/Bonus'));
  console.log('  ✓ New Folder, Rename (F2) and Delete (asks first, says it can’t be undone) on the server');

  // ---- Both looks, light and dark ----
  if (shots) {
    await win.click('.xf-pane[data-side=server] .xf-place:has-text("TV Shows")');
    await sleep(400);
    await win.click(row('server', 'Show X'));
    await win.dblclick(row('pc', 'Show X')); await sleep(400);
    for (const look of ['studio', 'seventies']) {
      for (const scheme of ['light', 'dark']) {
        await win.emulateMedia({ colorScheme: scheme });
        await win.evaluate((l) => window.Shelf.setTheme(l), look);
        await sleep(700);
        await shot(win, 'look-' + look + '-' + scheme);
      }
    }
    await win.setViewportSize({ width: 800, height: 600 }).catch(() => {});
    await sleep(400);
    await shot(win, 'look-narrow');
  }

  await win.keyboard.press('Escape'); await sleep(300);
  assert.ok(!(await win.$('#xferSheet[open]')));
  assert.deepStrictEqual(errors, [], 'no errors in the window');
  await app.close();
  srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  console.log('Server Files window test passed');
})().catch((e) => { console.log('FAIL', e.stack || e.message); process.exit(1); });
