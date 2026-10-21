// End-to-end: marking a title card yourself, for one Shelf couldn't read.
//  The first card is readable, the second has no readable text → "One long episode?" →
//  Mark 2nd Card… → the editor opens near the middle → M → pick the episode → both episodes, sure.
//  Then: Remove Mark (on the same spot) takes it back; mark again and save.
// Run with: xvfb-run -a node tests/mark.smoke.js
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
// A card Shelf can't read: a plain coloured screen with squiggles, no letters.
const blank = (t, bg) => `drawbox=enable='between(t,${t},${t + 4})':color=${bg}:t=fill,drawbox=enable='between(t,${t},${t + 4})':x=120:y=110:w=240:h=6:color=yellow:t=fill`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-mark-'));
  const dir = path.join(tmp, 'Downloads', 'SpongeBob', 'Season 1'); fs.mkdirSync(dir, { recursive: true });
  const file = 'SpongeBob.S01E03.mp4';
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=12:d=1320', '-f', 'lavfi', '-i', 'sine=f=440:r=16000:d=1320',
    '-vf', card(62, 'Jellyfishing', '0x3d9be9') + ',' + blank(663, '0xe95b3d'), '-c:v', 'libx264', '-preset', 'veryfast', '-g', '48', '-c:a', 'aac', '-b:a', '48k', path.join(dir, file)]);
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
  const pick = (n) => win.evaluate((n) => { const it = window.Shelf.items().find((i) => i.name === n); document.querySelector('[data-id="' + it.id + '"]').click(); }, n);
  const item = () => win.evaluate((n) => { const v = window.Shelf.items().find((i) => i.name === n); return { ep: v.episode && [v.episode.number, v.episode.end || null, v.episode.how], block: !!v.epBlock, marks: (v.marks || []).map((m) => m.number + '@' + Math.round(m.t)) }; }, file);
  const edT = () => win.evaluate(() => window.ShelfEditor._state().t);

  await win.click('#menuBtn'); await win.click('#mainMenu [data-open=settings]'); await win.keyboard.press('Escape'); await sleep(200);
  await win.click('#chooseFolder');
  for (let i = 0; i < 60; i++) { await sleep(100); if (await win.evaluate(() => window.Shelf.items().length === 1 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)))) break; }
  await pick(file); await sleep(200);
  await win.click('#autoMode');
  for (let i = 0; i < 900; i++) { await sleep(200); if (await win.evaluate(() => window.Shelf.items().filter((x) => x.kind === 'episode' && x.fullPath).every((x) => x.cards) && document.getElementById('activity').hidden)) break; }
  await sleep(500);
  await pick(file); await sleep(300);
  console.log('before:', JSON.stringify(await item()), '|', await win.textContent('#issueTitle'));
  assert.match(await win.textContent('#issueTitle'), /One long episode/);

  // ---- Mark the second card ----
  await win.click('#issueActions button:has-text("Find It in the Video")');
  await win.waitForSelector('#editorSheet[open]');
  await sleep(800);
  const t0 = await edT();
  console.log('editor opened at', t0.toFixed(1));
  assert.ok(t0 > 600 && t0 < 680, 'opens near the middle, where the second card usually is');
  assert.match(await win.textContent('#edInfo'), /Find the title card/);
  assert.match(await win.textContent('#edMarkCard'), /Mark Title Card Here/);
  await win.evaluate(() => { document.activeElement.blur(); });
  for (let i = 0; i < 40 && (await edT()) < 664; i++) { await win.keyboard.press('Shift+ArrowRight'); await sleep(60); }
  if (process.env.SHOT) await win.screenshot({ path: process.env.SHOT.replace('.png', '-before.png') });
  await win.keyboard.press('m');
  await win.waitForSelector('#epBrowser:not([hidden])');
  assert.match(await win.textContent('#ebTitle'), /Whose title card is at 11:0/);
  await win.fill('#ebSearch', 'plankton'); await win.keyboard.press('Enter'); await sleep(800);
  let s = await item();
  console.log('marked:', JSON.stringify(s));
  assert.deepStrictEqual(s.marks, ['7@664']);
  assert.deepStrictEqual(s.ep, [6, 7, 'card'], 'both episodes, from the title cards');
  assert.ok(!s.block, 'no problem left');
  assert.strictEqual(await win.$$eval('#edCardList .ed-chip.is-manual', (x) => x.length), 1, 'your mark is in the title-card row');
  assert.strictEqual(await win.$$eval('#edCardList .ed-chip', (x) => x.length), 2);
  assert.match(await win.textContent('#edPanel'), /You marked this title card/);
  assert.match(await win.textContent('#edMarkCard'), /Remove Mark/);
  if (process.env.SHOT) await win.screenshot({ path: process.env.SHOT });

  // ---- Remove it, then mark it again and save ----
  await win.click('#edMarkCard'); await sleep(1200);
  s = await item();
  assert.deepStrictEqual(s.marks, []);
  assert.match(await win.textContent('#edMarkCard'), /Mark Title Card Here/);
  await win.click('#edMarkCard');
  await win.fill('#ebSearch', 'plankton'); await win.keyboard.press('Enter'); await sleep(400);
  await win.click('#edSave'); await sleep(800);
  s = await item();
  console.log('saved:', JSON.stringify(s));
  assert.deepStrictEqual(s.ep.slice(0, 2), [6, 7]);
  assert.match(await win.textContent('#inspEpList'), /Plankton/);

  // ---- One episode, or more: always yours to say, right in the side panel ----
  assert.strictEqual(await win.getAttribute('#epCount button[data-count=more]', 'aria-pressed'), 'true');
  await win.click('#epCount button[data-count=one]'); await sleep(600);
  s = await item();
  assert.deepStrictEqual(s.ep.slice(0, 2), [6, null], 'one episode');
  assert.strictEqual(await win.$$eval('#inspEpList .ep-card-row', (x) => x.length), 1);
  await win.click('#epCount button[data-count=more]'); await sleep(600);
  s = await item();
  assert.deepStrictEqual(s.ep.slice(0, 2), [6, 7], 'two: the next one is added');
  assert.ok(await win.isVisible('#epAdd'), '+ Add Another Episode');
  await win.click('#inspEpList .ep-card-row:nth-child(2) .ep-remove'); await sleep(600);
  assert.deepStrictEqual((await item()).ep.slice(0, 2), [6, null], 'removed again');

  console.log('prompts:', JSON.stringify(await app.evaluate(() => global.__prompts)));
  assert.deepStrictEqual(errors, []);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Mark test passed');
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
