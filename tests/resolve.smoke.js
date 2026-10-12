// End-to-end: problems in the side panel and the Resolve window.
//  A. Two cartoons that aren't next to each other → "holds 2 separate episodes" → Resolve → Split into 2 Files.
//  B. Per-episode Change in the side panel.
//  C. One title card only → "One long episode?" → Yes, One Episode.
// Run with: xvfb-run -a node tests/resolve.smoke.js
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-resolve-'));
  const dir = path.join(tmp, 'Downloads', 'SpongeBob', 'Season 1'); fs.mkdirSync(dir, { recursive: true });
  fake(path.join(dir, 'SpongeBob.S01E05.mp4'), `drawbox=enable='between(t,659.0,660.6)':color=black:t=fill,${card(62, 'Pizza Delivery', '0x3d9be9')},${card(663, 'Pickles', '0xe95b3d')}`, "volume=enable='between(t,659.0,660.6)':volume=0");
  fake(path.join(dir, 'SpongeBob.S01E01.mp4'), card(62, 'Help Wanted', '0x3d9be9'));
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
  const item = (n) => win.evaluate((n) => { const v = window.Shelf.items().find((i) => i.name === n); return { split: v.split && v.split.pieces.map((p) => [Math.round(p.start), Math.round(p.end), p.entry.number]), ep: v.episode && [v.episode.number, v.episode.end || null, v.episode.how], block: !!v.epBlock }; }, n);

  await win.click('.side-item[data-open=settings]'); await win.keyboard.press('Escape'); await sleep(200);
  await win.click('text=Choose Folder…');
  for (let i = 0; i < 60; i++) { await sleep(100); if (await win.evaluate(() => window.Shelf.items().length === 2 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)))) break; }
  await pick('SpongeBob.S01E05.mp4'); await sleep(200);
  await win.click('#readCards');
  for (let i = 0; i < 900; i++) { await sleep(200); if (/Read \d+ of/.test(await win.textContent('#scanStatus'))) break; }
  await sleep(500);

  // ---- A ----
  await pick('SpongeBob.S01E05.mp4'); await sleep(300);
  assert.ok(await win.isVisible('#inspIssue'), 'problem card shown');
  assert.match(await win.textContent('#issueTitle'), /holds 2 separate episodes/);
  for (let i = 0; i < 50; i++) { await sleep(100); if (await win.$$eval('#inspEpList .ep-thumb img', (x) => x.length) === 2) break; }
  assert.strictEqual(await win.$$eval('#inspEpList .ep-thumb img', (x) => x.filter((i) => i.naturalWidth > 0).length), 2, 'title-card frames in the side panel');
  await win.click('#issueActions button:has-text("Resolve")');
  await win.waitForSelector('#resolveSheet[open]');
  for (let i = 0; i < 50; i++) { await sleep(100); if (await win.$$eval('#rsParts .rs-frame img', (x) => x.length) === 2) break; }
  assert.strictEqual(await win.$$eval('#rsParts .rs-part', (x) => x.length), 2);
  assert.match(await win.textContent('#rsVerdict'), /S01E10 - Pizza Delivery.*S01E13 - Pickles/);
  assert.match(await win.textContent('#rsMain'), /Split into 2 Files/);
  // Change part 2 to the episode right after part 1 → now one file can hold both.
  await win.click('#rsParts .rs-part:nth-child(2) .pill');
  await win.fill('#ebSearch', 'S01E11'); await win.keyboard.press('Enter'); await sleep(200);
  assert.match(await win.textContent('#rsMain'), /Keep One File/, 'episodes in a row can stay one file');
  await win.click('#rsParts .rs-part:nth-child(2) .pill');
  await win.fill('#ebSearch', 'pickles'); await win.keyboard.press('Enter'); await sleep(200);
  await win.click('#rsMain');
  for (let i = 0; i < 150; i++) { await sleep(200); if (!(await win.isVisible('#resolveSheet'))) break; }
  await sleep(500);
  let s = await item('SpongeBob.S01E05.mp4');
  console.log('A:', JSON.stringify(s));
  assert.ok(s.split && s.split.length === 2 && Math.abs(s.split[0][1] - 660) <= 2 && s.split[0][2] === 10 && s.split[1][2] === 13, 'split at the gap');
  assert.ok(!(await win.isVisible('#inspIssue')), 'problem gone');
  assert.match(await win.textContent('#inspEpLabel'), /Will be split into 2 files/);

  // ---- C ---- (one card, nothing further in)
  await pick('SpongeBob.S01E01.mp4'); await sleep(300);
  console.log('C card:', await win.textContent('#issueTitle'), '|', await win.textContent('#issueText'));
  assert.match(await win.textContent('#issueTitle'), /One long episode/);
  await win.click('#issueActions button:has-text("Yes, One Episode")'); await sleep(500);
  s = await item('SpongeBob.S01E01.mp4');
  console.log('C:', JSON.stringify(s));
  assert.deepStrictEqual(s.ep, [1, null, 'manual']);
  assert.ok(!s.block && !(await win.isVisible('#inspIssue')));

  // ---- B ---- (Change one row in the side panel)
  await win.click('#inspEpList .ep-change');
  await win.fill('#ebSearch', 'reef blower'); await win.keyboard.press('Enter'); await sleep(500);
  s = await item('SpongeBob.S01E01.mp4');
  console.log('B:', JSON.stringify(s));
  assert.deepStrictEqual(s.ep.slice(0, 1), [2]);
  assert.match(await win.textContent('#inspEpList'), /S01E02.*Reef Blower/);

  console.log('prompts:', JSON.stringify(await app.evaluate(() => global.__prompts)));
  assert.deepStrictEqual(errors, []);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Resolve test passed');
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
