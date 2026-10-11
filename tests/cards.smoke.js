// End-to-end: "Check Lengths" and "Read Title Cards" on fake cartoon episodes made here.
// Run with: xvfb-run -a node tests/cards.smoke.js        (PACKAGED=1 to test dist/linux-unpacked)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = require('./fixtures/cartoons.json');
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find((f) => fs.existsSync(f));

// (Made with the system's ffmpeg, which can draw text; Shelf itself only uses its bundled one.)
// A fake cartoon: moving test picture, with a title card (coloured screen + big title) at given times.
function fakeEpisode(file, secs, cards) {
  const vf = cards.map(([t, title, bg]) => `drawbox=enable='between(t,${t},${t + 4})':color=${bg}:t=fill,drawtext=enable='between(t,${t},${t + 4})':text='${title}':fontfile=${FONT}:fontsize=52:fontcolor=yellow:borderw=4:bordercolor=0x5a2d0c:x=(w-tw)/2:y=(h-th)/2`).join(',') || 'null';
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=480x270:r=6:d=${secs}`, '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '18', file]);
}

(async () => {
  const scanDirsBefore = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('shelf-scan-')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-cards-'));
  const dir = path.join(tmp, 'Downloads', 'SpongeBob', 'Season 1'); const lib = path.join(tmp, 'Plex');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(lib);
  // Named S01E09, but really holds Jellyfishing + Plankton! (S01E06-E07): only the cards can tell.
  fakeEpisode(path.join(dir, 'SpongeBob.S01E09.mkv'), 1320, [[62, 'Jellyfishing', '0x3d9be9'], [668, 'Plankton!', '0xe95b3d']]);
  // A single 11-minute cartoon.
  fakeEpisode(path.join(dir, 'SpongeBob.S01E14.mkv'), 660, []);

  const handle = (route) => {
    const u = route.request().url();
    if (u.includes('api.tvmaze.com/search')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([{ score: 1, show: { id: 713, name: 'SpongeBob SquarePants', premiered: '1999-05-01', weight: 99 } }]) });
    if (u.includes('api.tvmaze.com/shows/713/episodes')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify(F.spongebob.map(([season, number, name, airdate, runtime]) => ({ season, number, name, airdate, runtime }))) });
    return route.continue();
  };

  const exe = process.env.PACKAGED ? path.join(ROOT, 'dist/linux-unpacked/shelf') : path.join(ROOT, 'node_modules/electron/dist/electron');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--user-data-dir=' + profile].concat(process.env.PACKAGED ? [] : [ROOT]) });
  // The folder dialog picks our fake folder; the consent prompt answers from `answers`, and we keep what it said.
  await app.evaluate(({ dialog }, d) => {
    global.__prompts = []; global.__answers = [1, 0, 0]; // Cancel, then OK, OK
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
    dialog.showMessageBox = async (w, o) => { global.__prompts.push(o.message + ' | ' + o.detail); return { response: global.__answers.shift() }; };
  }, path.join(tmp, 'Downloads'));
  if (process.env.DEBUG) { app.process().stderr.on('data', (d) => process.stdout.write('[main] ' + d)); app.process().stdout.on('data', (d) => process.stdout.write('[main] ' + d)); }
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.route('**/*', handle);
  await win.waitForLoadState();

  await win.click('text=Choose Folder…');
  const settled = () => win.evaluate(() => window.Shelf.items().length === 2 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)));
  for (let i = 0; i < 60 && !(await settled()); i++) await sleep(100);
  await sleep(300);
  const state = () => win.evaluate(() => window.Shelf.items().map((i) => ({ n: i.name, s: i.status, ep: i.episode && ('S' + i.episode.season + 'E' + i.episode.number + (i.episode.end ? '-E' + i.episode.end : '') + ' ' + i.episode.how), min: i.minutes ? Math.round(i.minutes) : null, err: i.error })));
  console.log('before:', JSON.stringify(await state()));

  const pick = (n) => win.evaluate((n) => { const it = window.Shelf.items().find((i) => i.name === n); document.querySelector('[data-id="' + it.id + '"]').click(); }, n);
  await pick('SpongeBob.S01E09.mkv'); await sleep(200);
  assert.ok(await win.isVisible('#checkLengths'), 'Check Lengths offered');
  assert.ok(!(await win.isVisible('#readCards')), 'Read Title Cards hidden until turned on in Settings');

  // 1. Cancel at the prompt: nothing is read.
  await win.click('#checkLengths'); await sleep(500);
  let s = await state();
  assert.ok(s.every((x) => x.min === null), 'nothing read after Cancel');
  assert.match(await win.textContent('#scanStatus'), /Cancelled/);

  // 2. OK: lengths decide one cartoon vs half-hour.
  await win.click('#checkLengths'); await sleep(800);
  s = await state();
  console.log('after lengths:', JSON.stringify(s));
  const e9 = s.find((x) => x.n === 'SpongeBob.S01E09.mkv'), e14 = s.find((x) => x.n === 'SpongeBob.S01E14.mkv');
  assert.strictEqual(e9.min, 22); assert.strictEqual(e14.min, 11);
  assert.strictEqual(e9.ep, 'S1E18-E19 halfhour', 'by length alone: half-hour no. 9');
  assert.strictEqual(e14.ep, 'S1E14 number', '11 minutes: one cartoon');

  // 3. Turn on title cards (Advanced) and read them: the cards beat the misleading name.
  await win.click('.side-item[data-open=settings]'); await win.check('#optCardScan'); await win.keyboard.press('Escape'); await sleep(200);
  await pick('SpongeBob.S01E09.mkv'); await sleep(200);
  assert.ok(await win.isVisible('#readCards'));
  const t0 = Date.now();
  await win.click('#readCards');
  for (let i = 0; i < 900; i++) { await sleep(200); if (/Read \d+ of/.test(await win.textContent("#scanStatus"))) break; } // up to 3 min on a busy machine
  const took = Date.now() - t0;
  await sleep(300);
  s = await state();
  console.log('after cards (' + took + ' ms):', JSON.stringify(s));
  assert.strictEqual(s.find((x) => x.n === 'SpongeBob.S01E09.mkv').ep, 'S1E6-E7 card', 'title cards win');
  const prompts = await app.evaluate(() => global.__prompts);
  console.log('prompts:\n ', prompts.join('\n  '));
  assert.strictEqual(prompts.length, 3, 'asked every time');
  assert.ok(prompts[2].includes('SpongeBob.S01E09.mkv') && /Read the title cards/.test(prompts[2]), 'prompt names the files');
  // Frames are deleted afterwards.
  const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('shelf-scan-') && !scanDirsBefore.has(n));
  assert.deepStrictEqual(left, [], 'temp frames removed');

  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  assert.deepStrictEqual(errors, []);
  console.log('Cards test passed');
})().catch((e) => {
  console.error('FAIL', e.message);
  if (process.env.DEBUG) for (const d of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('shelf-profile-'))) {
    const log = path.join(os.tmpdir(), d, 'startup.log'); if (fs.existsSync(log)) console.error('--- ' + d + '\n' + fs.readFileSync(log, 'utf8').slice(-1500));
  }
  process.exit(1);
});
