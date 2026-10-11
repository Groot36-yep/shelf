// End-to-end: a half-hour whose two cartoons aren't next to each other gets split, by choice.
// Run with: xvfb-run -a node tests/split.smoke.js     (PACKAGED=1 to test dist/linux-unpacked)
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

// Made with the system's ffmpeg (it can draw text): "Pizza Delivery" (S01E10), a black + silent gap
// at 11:00, then "Pickles" (S01E13). Two cartoons that are NOT next to each other in the list.
function fakeMixed(file) {
  const card = (t, title, bg) => `drawbox=enable='between(t,${t},${t + 4})':color=${bg}:t=fill,drawtext=enable='between(t,${t},${t + 4})':text='${title}':fontfile=${FONT}:fontsize=48:fontcolor=yellow:borderw=4:bordercolor=0x5a2d0c:x=(w-tw)/2:y=(h-th)/2`;
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=12:d=1320', '-f', 'lavfi', '-i', 'sine=f=440:r=16000:d=1320',
    '-vf', `drawbox=enable='between(t,659.0,660.6)':color=black:t=fill,${card(62, 'Pizza Delivery', '0x3d9be9')},${card(663, 'Pickles', '0xe95b3d')}`,
    '-af', "volume=enable='between(t,659.0,660.6)':volume=0", '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-c:a', 'aac', '-b:a', '48k', file]);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-split-'));
  const dir = path.join(tmp, 'Downloads', 'SpongeBob', 'Season 1'); const lib = path.join(tmp, 'Plex');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(lib);
  const src = path.join(dir, 'SpongeBob.S01E05.mp4');
  fakeMixed(src);
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
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.route('**/*', handle);
  await win.waitForLoadState();

  await win.click('.side-item[data-open=settings]'); await win.check('#optCardScan'); await win.keyboard.press('Escape'); await sleep(200);
  await win.click('text=Choose Folder…');
  for (let i = 0; i < 60; i++) { await sleep(100); if (await win.evaluate(() => window.Shelf.items().length === 1 && !['pending', 'matching'].includes(window.Shelf.items()[0].status))) break; }
  await win.evaluate(() => document.querySelector('.row-item').click()); await sleep(200);

  // 1. Read the title cards: the two cartoons aren't next to each other → Shelf offers to split.
  await win.click('#readCards');
  for (let i = 0; i < 900; i++) { await sleep(200); if (/Read \d+ of/.test(await win.textContent("#scanStatus"))) break; } // up to 3 min on a busy machine
  await sleep(400);
  const it = await win.evaluate(() => { const i = window.Shelf.items()[0]; return { status: i.status, err: i.error, entries: i.episode && i.episode.entries }; });
  console.log('after cards:', JSON.stringify(it));
  assert.ok(it.entries && it.entries.map((e) => e.number).join(',') === '10,13', 'Pizza Delivery + Pickles found');
  assert.ok(await win.isVisible('#inspSplitWrap') && /aren’t next to each other/.test(await win.textContent('#splitHelp')), 'split offered with the reason');
  assert.strictEqual(await win.evaluate(() => window.Shelf.items()[0].split || null), null, 'nothing split until you choose');

  // 2. Open the split window: it asks first, then suggests the cut at the black + silent gap.
  await win.click('#openSplit');
  await win.waitForSelector('#splitSheet[open]');
  for (let i = 0; i < 100; i++) { await sleep(150); if (await win.isHidden('#spBusy')) break; }
  await sleep(300);
  const info = await win.textContent('#spInfo');
  console.log('suggestion:', info);
  const cutAt = await win.evaluate(() => { const m = document.getElementById('spInfo').textContent.match(/(\d+):(\d+\.\d)/); return m ? +m[1] * 60 + +m[2] : null; });
  assert.ok(cutAt >= 659 && cutAt <= 661.3, 'cut suggested inside the black, silent gap (got ' + cutAt + ')');
  assert.match(info, /black screen \+ silence/);
  const playable = await win.evaluate(() => { const v = document.getElementById('spVideo'); return { hidden: v.hidden, ready: v.readyState, err: v.error && v.error.code }; });
  console.log('player:', JSON.stringify(playable), '| still-frames mode:', await win.isVisible('#spMode'));
  let parts = await win.$$eval('#spParts .sp-part', (rows) => rows.map((r) => r.textContent));
  console.log('parts:', parts);
  assert.ok(/S01E10 - Pizza Delivery/.test(parts[0]) && /S01E13 - Pickles/.test(parts[1]), 'each part named');
  if (process.env.SHOT) await win.screenshot({ path: process.env.SHOT });

  // 3. "Change…" opens the episode search; pick another, then put it back.
  await win.click('#spParts .sp-part:nth-child(2) .link-btn');
  await win.fill('#epSearch', 'hall monitor'); await win.keyboard.press('Enter'); await sleep(200);
  parts = await win.$$eval('#spParts .sp-part', (rows) => rows.map((r) => r.textContent));
  assert.ok(/S01E14 - Hall Monitor/.test(parts[1]), 'picked from search');
  await win.click('#spParts .sp-part:nth-child(2) .link-btn');
  await win.fill('#epSearch', 's1e13'); await win.keyboard.press('Enter'); await sleep(200);
  parts = await win.$$eval('#spParts .sp-part', (rows) => rows.map((r) => r.textContent));
  assert.ok(/S01E13 - Pickles/.test(parts[1]), 'picked by number');

  // 4. Use it, then Rename Now.
  await win.click('#spUse'); await sleep(300);
  assert.ok(!(await win.isVisible('#splitSheet')));
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
    'TV Shows/SpongeBob SquarePants/Season 01/SpongeBob SquarePants - S01E13 - Pickles.mp4'
  ]);
  const lens = [];
  for (const m of made) lens.push(await probe.duration(path.join(lib, m)));
  console.log('piece lengths:', lens);
  assert.ok(lens[0] >= 659 && lens[0] <= 662 && Math.abs(lens[0] + lens[1] - 1320) <= 2, 'pieces split at the gap: ' + lens);
  assert.strictEqual(fs.statSync(src).size, srcSize, 'original untouched');

  // 5. Undo removes the pieces; the original is still there.
  await win.click('#undoBar'); await sleep(1000);
  assert.deepStrictEqual(walk(lib), [], 'pieces removed');
  assert.ok(fs.existsSync(src), 'original still there');
  const prompts = await app.evaluate(() => global.__prompts);
  console.log('prompts:', prompts);
  assert.ok(prompts.some((p) => /Read the title cards/.test(p)) && prompts.some((p) => /choose where to split/.test(p)), 'asked before reading and before opening');

  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  assert.deepStrictEqual(errors, []);
  console.log('Split test passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
