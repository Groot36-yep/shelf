// End-to-end: the Check Episodes window — scrubbing, zoom, title cards, cuts, episode browser,
// one file vs split — then Rename Now and Undo.
// Run with: xvfb-run -a node tests/split.smoke.js     (PACKAGED=1 to test dist/linux-unpacked, SHOT=dir for screenshots)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');
const probe = require('../desktop/probe.js');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = require('./fixtures/cartoons.json');
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'].find((f) => fs.existsSync(f));
const SHOT = process.env.SHOT;

// Made with the system's ffmpeg (it can draw text). Two cartoons that are NOT next to each other
// in the list: "Pizza Delivery" (S01E10), a black + silent gap at 11:00, then "Pickles" (S01E13).
function fakeMixed(file) {
  const card = (t, title, bg) => `drawbox=enable='between(t,${t},${t + 4})':color=${bg}:t=fill,drawtext=enable='between(t,${t},${t + 4})':text='${title}':fontfile=${FONT}:fontsize=48:fontcolor=yellow:borderw=4:bordercolor=0x5a2d0c:x=(w-tw)/2:y=(h-th)/2`;
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=12:d=1320', '-f', 'lavfi', '-i', 'sine=f=440:r=16000:d=1320',
    '-vf', `drawbox=enable='between(t,659.0,660.6)':color=black:t=fill,${card(62, 'Pizza Delivery', '0x3d9be9')},${card(663, 'Pickles', '0xe95b3d')}`,
    '-af', "volume=enable='between(t,659.0,660.6)':volume=0", '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-c:a', 'aac', '-b:a', '48k', file]);
}
function fakeSingle(file) {
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=12:d=660', '-f', 'lavfi', '-i', 'sine=f=300:r=16000:d=660',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-c:a', 'aac', '-b:a', '48k', file]);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-split-'));
  const dir = path.join(tmp, 'Downloads', 'SpongeBob', 'Season 1'); const lib = path.join(tmp, 'Plex');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(lib);
  const src = path.join(dir, 'SpongeBob.S01E05.mp4');
  fakeMixed(src);
  const single = path.join(dir, 'SpongeBob.S01E30.mp4'); // really "Hall Monitor" (S01E14); no title cards
  fakeSingle(single);
  const srcSize = fs.statSync(src).size;

  const handle = (route) => {
    const u = route.request().url();
    if (u.includes('api.tvmaze.com/search')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([{ score: 1, show: { id: 713, name: 'SpongeBob SquarePants', premiered: '1999-05-01', weight: 99 } }]) });
    if (u.includes('api.tvmaze.com/shows/713/episodes')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify(F.spongebob.map(([season, number, name, airdate, runtime]) => ({ season, number, name, airdate, runtime }))) });
    return route.continue();
  };
  const exe = process.env.PACKAGED ? path.join(ROOT, 'dist/linux-unpacked/shelf') : path.join(ROOT, 'node_modules/electron/dist/electron');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--user-data-dir=' + profile].concat(process.env.PACKAGED ? [] : [ROOT]) });
  await app.evaluate(({ dialog }, dirs) => {
    const q = [...dirs]; global.__prompts = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [q.shift()] });
    dialog.showMessageBox = async (w, o) => { global.__prompts.push(o.message); return { response: 0 }; };
  }, [path.join(tmp, 'Downloads'), lib]);
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1400, height: 960 }).catch(() => {});
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.route('**/*', handle);
  await win.waitForLoadState();
  const ed = () => win.evaluate(() => { const s = ShelfEditor._state(); return s && { t: s.t, cuts: s.cuts.slice(), mode: s.mode, view: s.view, zoom: s.zoom, sel: s.sel, parts: s.parts.map((p) => p.entry && p.entry.number), one: s.oneEntries.map((e) => e.number), cards: s.cards.length, playable: s.playable }; });
  const pick = (n) => win.evaluate((n) => { const it = window.Shelf.items().find((i) => i.name === n); document.querySelector('[data-id="' + it.id + '"]').click(); }, n);

  await win.click('.side-item[data-open=settings]'); await win.check('#optCardScan'); await win.keyboard.press('Escape'); await sleep(200);
  await win.click('text=Choose Folder…');
  for (let i = 0; i < 60; i++) { await sleep(100); if (await win.evaluate(() => window.Shelf.items().length === 2 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)))) break; }

  // ---- A. A file never scanned: Check Episodes works straight away (#2.6) ----
  await pick('SpongeBob.S01E30.mp4'); await sleep(200);
  assert.ok(await win.isVisible('#inspEpWrap'), 'episode card shown');
  console.log('card for unscanned file:', (await win.textContent('#inspEpList')).trim(), '|', await win.textContent('#inspEpWhy'));
  await win.click('#checkEps');
  await win.waitForSelector('#editorSheet[open]');
  await sleep(800);
  let s = await ed();
  console.log('editor (unscanned):', JSON.stringify(s));
  assert.strictEqual(s.mode, 'one');
  // Change the episode with the browser: search by title (#14).
  await win.click('#edPanel .ed-part .pill');
  assert.ok(await win.isVisible('#epBrowser'));
  const seasonsShown = await win.$$eval('#ebSeasons button', (b) => b.map((x) => x.textContent));
  assert.ok(seasonsShown.includes('Season 1') && seasonsShown.includes('Season 2'), 'season tabs');
  await win.fill('#ebSearch', 'hall mon'); await sleep(100);
  const firstRow = await win.textContent('#ebList .eb-row');
  assert.match(firstRow, /S01E14.*Hall Monitor/, 'search finds it: ' + firstRow);
  await win.keyboard.press('Enter'); await sleep(200);
  assert.deepStrictEqual((await ed()).one, [14]);
  assert.match(await win.textContent('#edNames'), /S01E14 - Hall Monitor/);
  if (SHOT) await win.screenshot({ path: path.join(SHOT, 'editor-one.png') });
  await win.click('#edSave'); await sleep(400);
  assert.ok(!(await win.isVisible('#editorSheet')));
  const nm = await win.textContent('#inspFile');
  assert.match(nm, /SpongeBob SquarePants - S01E14 - Hall Monitor\.mp4/, 'saved name: ' + nm);
  assert.match(await win.textContent('#inspEpWhy'), /You chose this/);

  // ---- B. The mixed file: read title cards, then check and split ----
  await pick('SpongeBob.S01E05.mp4'); await sleep(200);
  await win.click('#readCards');
  for (let i = 0; i < 900; i++) { await sleep(200); if (/Read \d+ of/.test(await win.textContent('#scanStatus'))) break; }
  await sleep(500);
  await pick('SpongeBob.S01E05.mp4'); await sleep(200);
  const cardText = (await win.textContent('#inspEpList')).replace(/\s+/g, ' ');
  console.log('card after reading:', cardText, '|', await win.textContent('#inspEpWhy'));
  assert.match(cardText, /S01E10.*Pizza Delivery.*S01E13.*Pickles/, 'clear about what it thinks (#13)');
  assert.match(await win.textContent('#inspEpWhy'), /title cards/);
  await win.click('#checkEps');
  await win.waitForSelector('#editorSheet[open]');
  for (let i = 0; i < 100; i++) { await sleep(150); if (await win.isHidden('#edBusy')) break; }
  await sleep(500);
  s = await ed();
  console.log('editor (split):', JSON.stringify(s), '|', await win.textContent('#edInfo'));
  assert.strictEqual(s.mode, 'split');
  assert.ok(s.cuts[0] >= 659 && s.cuts[0] <= 661.3, 'suggested cut in the gap');
  assert.deepStrictEqual(s.parts, [10, 13]);
  assert.strictEqual(s.cards, 2, 'both title cards known');
  assert.strictEqual(await win.locator('#edPanel .ed-proof img').count(), 2, 'shows the frames it read (#12)');
  console.log('player playable:', s.playable);
  const cut0 = s.cuts[0];

  // True scrubber (#2.9): dragging on the timeline moves the playhead, never the cut.
  const box = await win.locator('#edTimeline').boundingBox();
  await win.mouse.move(box.x + box.width * 0.2, box.y + 60); await win.mouse.down();
  await win.mouse.move(box.x + box.width * 0.5, box.y + 60, { steps: 8 });
  await win.mouse.move(box.x + box.width * 0.8, box.y + 60, { steps: 8 }); await win.mouse.up();
  s = await ed();
  assert.strictEqual(s.cuts[0], cut0, 'scrubbing does not move the cut');
  const v = s.view; const want = v.a + (v.b - v.a) * 0.8;
  assert.ok(Math.abs(s.t - want) < (v.b - v.a) * 0.03, 'playhead followed the drag: ' + s.t + ' vs ' + want);
  await sleep(600);
  const vt = await win.evaluate(() => document.getElementById('edVideo').currentTime);
  assert.ok(Math.abs(vt - s.t) < 0.6, 'the picture followed the scrub too: video at ' + vt + ', playhead ' + s.t);

  // Zoom (#2.8)
  const span0 = s.view.b - s.view.a;
  await win.click('#edZoomIn'); await win.click('#edZoomIn'); await sleep(300);
  s = await ed();
  assert.ok(s.view.b - s.view.a < span0, 'zoomed in');
  await sleep(1200);
  const strip = await win.evaluate(() => getComputedStyle(document.getElementById('edStrip')).backgroundImage);
  assert.match(strip, /shelf-media:\/\/s\//, 'picture strip loaded for the zoomed view');

  // Frame step (#2.2): one key press = one frame.
  const t0 = (await ed()).t;
  await win.keyboard.press('ArrowRight'); await sleep(150);
  const t1 = (await ed()).t;
  assert.ok(Math.abs(t1 - t0 - 1 / 12) < 0.02, 'one frame forward: ' + (t1 - t0));

  // Jump to the title card (#2.5)
  await win.click('#edNextCard'); await sleep(300);
  s = await ed();
  console.log('after next card:', s.t, await win.textContent('#edInfo'));
  assert.ok((s.t > 60 && s.t < 68) || (s.t > 660 && s.t < 668), 'at a title card');

  // Set Cut Here moves the cut only by the button (#2.9)
  await win.evaluate(() => ShelfEditor._state().sel = 0);
  await win.evaluate(() => { const st = ShelfEditor._state(); st.t = 640; });
  await win.click('#edCutHere'); await sleep(1200);
  s = await ed();
  assert.ok(Math.abs(s.cuts[0] - 640) < 6, 'cut moved to the playhead (snapped): ' + s.cuts[0]);
  // ...and back to Shelf's spot
  await win.evaluate((c) => { ShelfEditor._state().t = c; }, cut0);
  await win.click('#edCutHere'); await sleep(1200);
  s = await ed();
  assert.ok(Math.abs(s.cuts[0] - cut0) < 0.5, 'cut back at the gap');

  // One file vs split (#2.4): one file can't hold E10 + E13 → explained, can't save.
  await win.click('#edMode button[data-mode=one]'); await sleep(200);
  assert.match(await win.textContent('#edWarn'), /aren’t next to each other/);
  assert.ok(await win.isDisabled('#edSave'));
  await win.click('#edMode button[data-mode=split]'); await sleep(300);

  // Change part 2 with the browser, then back (#2.3)
  await win.click('#edPanel .ed-part:nth-child(2) .pill');
  await win.fill('#ebSearch', 's1e15'); await win.keyboard.press('Enter'); await sleep(200);
  assert.deepStrictEqual((await ed()).parts, [10, 15]);
  await win.click('#edPanel .ed-part:nth-child(2) .pill');
  await win.fill('#ebSearch', 'pickles'); await win.keyboard.press('Enter'); await sleep(200);
  assert.deepStrictEqual((await ed()).parts, [10, 13]);
  if (SHOT) { await win.click('#edZoomOut'); await sleep(900); await win.screenshot({ path: path.join(SHOT, 'editor-split.png') }); }

  // Save → rename → two files; undo
  await win.click('#edSave'); await sleep(400);
  assert.match(await win.textContent('#inspEpLabel'), /Will be split into 2 files/);
  await win.click('#renameBtn');
  await win.click('#pickLib'); await sleep(300);
  console.log('rename summary:', await win.textContent('#renameSummary'));
  await win.click('#renameNow');
  for (let i = 0; i < 100; i++) { await sleep(200); if (!(await win.isVisible('#renameSheet'))) break; }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(lib, path.join(d, e.name)).split(path.sep).join('/')]);
  const made = walk(lib).sort();
  console.log('library:', made);
  assert.deepStrictEqual(made, [
    'TV Shows/SpongeBob SquarePants/Season 01/SpongeBob SquarePants - S01E10 - Pizza Delivery.mp4',
    'TV Shows/SpongeBob SquarePants/Season 01/SpongeBob SquarePants - S01E13 - Pickles.mp4',
    'TV Shows/SpongeBob SquarePants/Season 01/SpongeBob SquarePants - S01E14 - Hall Monitor.mp4'
  ]);
  const lens = [];
  for (const m of made.slice(0, 2)) lens.push(await probe.duration(path.join(lib, m)));
  assert.ok(lens[0] >= 659 && lens[0] <= 662 && Math.abs(lens[0] + lens[1] - 1320) <= 2, 'pieces split at the gap: ' + lens);
  assert.strictEqual(fs.statSync(src).size, srcSize, 'original untouched');
  await win.click('#undoBar'); await sleep(1200);
  assert.deepStrictEqual(walk(lib), [], 'undo removed everything');
  assert.ok(fs.existsSync(src) && fs.existsSync(single), 'originals back');

  const prompts = await app.evaluate(() => global.__prompts);
  console.log('prompts:', prompts);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  assert.deepStrictEqual(errors, []);
  console.log('Editor test passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
