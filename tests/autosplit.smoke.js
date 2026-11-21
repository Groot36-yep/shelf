// End-to-end: a half-hour whose two cartoons' title cards are read clearly, but aren't next to each other in the
// list, is split by itself after Read Title Cards (Settings → TV Shows → Split files by themselves, on by default),
// at the black, silent moment between them; Check All shows the cut and can move it.
// Run with: xvfb-run -a node tests/autosplit.smoke.js
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
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'].find((f) => fs.existsSync(f));
const card = (t, title, bg) => `drawbox=enable='between(t,${t},${t + 4})':color=${bg}:t=fill,drawtext=enable='between(t,${t},${t + 4})':text='${title}':fontfile=${FONT}:fontsize=48:fontcolor=yellow:borderw=4:bordercolor=0x5a2d0c:x=(w-tw)/2:y=(h-th)/2`;
function fake(file, vf, af) {
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=12:d=1320', '-f', 'lavfi', '-i', 'sine=f=440:r=16000:d=1320',
    '-vf', vf].concat(af ? ['-af', af] : [], ['-c:v', 'libx264', '-preset', 'veryfast', '-bf', '3', '-g', '48', '-c:a', 'aac', '-b:a', '48k', file]));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-autosplit-'));
  const dir = path.join(tmp, 'Downloads', 'SpongeBob', 'Season 1'); fs.mkdirSync(dir, { recursive: true });
  fake(path.join(dir, 'SpongeBob.S01E05.mp4'), `drawbox=enable='between(t,659.0,660.6)':color=black:t=fill,${card(62, 'Pizza Delivery', '0x3d9be9')},${card(663, 'Pickles', '0xe95b3d')}`, "volume=enable='between(t,659.0,660.6)':volume=0");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const exe = process.env.PACKAGED ? path.join(ROOT, 'dist/linux-unpacked/shelf') : path.join(ROOT, 'node_modules/electron/dist/electron');
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--user-data-dir=' + profile].concat(process.env.PACKAGED ? [] : [ROOT]) });
  await app.evaluate(({ dialog }, d) => { global.__prompts = []; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }); global.__shelfConsent = async (o) => { global.__prompts.push(o.title); return true; }; }, path.join(tmp, 'Downloads'));
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  const errors = []; win.on('pageerror', (e) => errors.push(String(e)));
  await win.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('api.tvmaze.com/search')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([{ score: 1, show: { id: 713, name: 'SpongeBob SquarePants', premiered: '1999-05-01', weight: 99 } }]) });
    if (u.includes('api.tvmaze.com/shows/713/episodes')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify(F.spongebob.map(([season, number, name, airdate, runtime]) => ({ season, number, name, airdate, runtime }))) });
    return route.continue();
  });
  await win.waitForLoadState();
  await win.click('#chooseFolder');
  for (let i = 0; i < 60; i++) { await sleep(100); if (await win.evaluate(() => window.Shelf.items().length === 1 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)))) break; }
  await win.click('#autoMode');
  const state = () => win.evaluate(() => { const v = window.Shelf.items()[0]; return { cards: !!v.cards, split: v.split && v.split.pieces.map((p) => [Math.round(p.start), Math.round(p.end), p.entry.number]) }; });
  for (let i = 0; i < 900; i++) { await sleep(200); const s = await state(); if (s.split) break; }
  const s = await state();
  console.log('after reading:', JSON.stringify(s));
  assert.ok(s.split && s.split.length === 2 && Math.abs(s.split[0][1] - 660) <= 2 && s.split[0][2] === 10 && s.split[1][2] === 13, 'split by itself, at the gap');
  assert.strictEqual(await win.evaluate(() => document.querySelectorAll('.row-item.is-asked').length), 0, 'nothing to ask');
  // Check All: the cut, and moving it.
  await win.waitForSelector('.shelf-check'); await win.click('.shelf-check');
  await win.waitForSelector('#reviewSheet[open] .rv-cut');
  assert.match(await win.textContent('.rv-cut-at'), /Cut 1 at 11:0[0-1]/);
  await win.click('.rv-cut button:has-text("2 s ▸")'); await sleep(300);
  const moved = await state();
  assert.strictEqual(moved.split[0][1], s.split[0][1] + 2, 'the cut moved 2 seconds later');
  assert.strictEqual(moved.split[1][0], moved.split[0][1], 'the next part starts there');
  console.log('prompts:', JSON.stringify(await app.evaluate(() => global.__prompts)));
  assert.deepStrictEqual(await app.evaluate(() => global.__prompts), ['Read this video’s title cards?'], 'one OK, for reading; none more for splitting');
  assert.deepStrictEqual(errors, []);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  console.log('Auto split test passed');
})().catch((e) => { console.error(e); process.exit(1); });
