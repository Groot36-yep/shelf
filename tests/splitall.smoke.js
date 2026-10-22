// End-to-end: splitting files that hold two episodes, one at a time ("Split into 2 Files", "Split by Hand…")
// and a whole show at once ("Split All": one question for every file). Fake videos made here.
// Run with: xvfb-run -a node tests/splitall.smoke.js
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

// A fake half-hour: moving test picture with a black, silent second at the gap between its two cartoons.
function fakeHalfHour(file, secs, gap) {
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=6:d=${secs}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`,
    '-vf', `drawbox=enable='between(t,${gap},${gap + 1.2})':color=black:t=fill`, '-af', `volume=enable='between(t,${gap},${gap + 1.2})':volume=0`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', '-c:a', 'aac', '-shortest', file]);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-splitall-'));
  const dir = path.join(tmp, 'Downloads', 'SpongeBob', 'Season 1');
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, gap] of [['SpongeBob.S01E06-E07.mkv', 655], ['SpongeBob.S01E08-E09.mkv', 662], ['SpongeBob.S01E10-E11.mkv', 650]]) fakeHalfHour(path.join(dir, n), 1320, gap);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const exe = path.join(ROOT, 'node_modules/electron/dist/electron');
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--user-data-dir=' + profile, ROOT] });
  await app.evaluate(({ dialog }, d) => {
    global.__prompts = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
    global.__shelfConsent = async (o) => { global.__prompts.push({ title: o.title, files: o.files }); return true; };
  }, path.join(tmp, 'Downloads'));
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('api.tvmaze.com/search')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([{ score: 1, show: { id: 713, name: 'SpongeBob SquarePants', premiered: '1999-05-01', weight: 99 } }]) });
    if (u.includes('api.tvmaze.com/shows/713/episodes')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify(F.spongebob.map(([season, number, name, airdate, runtime]) => ({ season, number, name, airdate, runtime }))) });
    if (/^https?:/.test(u)) return route.fulfill({ status: 404, headers: H, body: 'null' });
    return route.continue();
  });
  await win.waitForLoadState();
  await win.click('#chooseFolder');
  for (let i = 0; i < 80 && !(await win.evaluate(() => window.Shelf.items().length === 3 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)))); i++) await sleep(150);
  await sleep(400);
  const state = () => win.evaluate(() => window.Shelf.items().map((i) => ({ n: i.name, split: i.split ? i.split.pieces.map((p) => 'E' + p.entry.number + '@' + Math.round(p.start) + '-' + Math.round(p.end)) : null })));
  const pick = (n) => win.evaluate((n) => { const it = window.Shelf.items().find((i) => i.name === n); document.querySelector('[data-id="' + it.id + '"]').click(); }, n);

  // 1. One file: the details offer to split it, and Shelf finds the gap.
  await pick('SpongeBob.S01E06-E07.mkv'); await sleep(300);
  assert.ok(await win.isVisible('#splitRow'), 'a file with two episodes offers to split');
  assert.strictEqual(await win.textContent('#splitNow'), 'Split into 2 Files');
  assert.ok(await win.isVisible('#splitByHand'), 'and to split it by hand');
  await win.click('#splitNow');
  for (let i = 0; i < 120 && !(await state())[0].split; i++) await sleep(250);
  let s = await state();
  const one = s.find((x) => x.n === 'SpongeBob.S01E06-E07.mkv').split;
  assert.ok(one && one.length === 2 && /^E6@0-/.test(one[0]) && /^E7@/.test(one[1]), JSON.stringify(one));
  const cutAt = +one[0].split('-')[1];
  assert.ok(Math.abs(cutAt - 656) <= 3, 'cut at the black, silent gap (655–656 s): ' + cutAt);
  assert.strictEqual(await win.isVisible('#splitRow'), false, 'split: no more offer to split');
  assert.ok(await win.isVisible('#clearSplit'), '“Don’t Split” undoes it');
  const prompts1 = await app.evaluate(() => global.__prompts.length);
  console.log('  ✓ Split into 2 Files: ' + one.join(' + ') + ' (asked first: ' + prompts1 + ')');

  // 2. Split by Hand… opens Check Episodes in its Split Into Files mode.
  await pick('SpongeBob.S01E08-E09.mkv'); await sleep(300);
  await win.click('#splitByHand');
  await win.waitForSelector('#editorSheet[open]', { timeout: 20000 });
  await sleep(600);
  assert.strictEqual(await win.getAttribute('#edMode [data-mode="split"]', 'aria-pressed'), 'true', 'opens ready to place the cuts');
  await win.keyboard.press('Escape'); await sleep(500);
  assert.strictEqual((await state()).find((x) => x.n === 'SpongeBob.S01E08-E09.mkv').split, null, 'closing without saving splits nothing');
  console.log('  ✓ Split by Hand… opens Check Episodes in Split Into Files');

  // 3. Split All on the show's heading: the two left, one question for both.
  const before = await app.evaluate(() => global.__prompts.length);
  const label = await win.textContent('.shelf-split');
  assert.strictEqual(label, 'Split All (2)', label);
  await win.click('.shelf-split');
  for (let i = 0; i < 200 && !(await state()).every((x) => x.split); i++) await sleep(250);
  s = await state();
  assert.ok(s.every((x) => x.split && x.split.length === 2), JSON.stringify(s));
  const asked = await app.evaluate((e, b) => global.__prompts.slice(b), before);
  assert.strictEqual(asked.length, 1, 'one question for all of them: ' + JSON.stringify(asked));
  assert.ok(/these 2 videos/.test(asked[0].title) && asked[0].files.length === 2, JSON.stringify(asked[0]));
  assert.strictEqual(await win.$$eval('.shelf-split', (x) => x.length), 0, 'nothing left to split: the button goes');
  const names = await win.evaluate(() => [...document.querySelectorAll('.row-item')].map((r) => r.title));
  assert.ok(names.every((t) => /S01E\d\d - .* \+ .*S01E\d\d - /.test(t)), JSON.stringify(names));
  console.log('  ✓ Split All (2): one question (“' + asked[0].title + '”), ' + s.map((x) => x.split.join(' + ')).join(' | '));

  assert.deepStrictEqual(errors, []);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  console.log('Split All smoke test passed');
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
