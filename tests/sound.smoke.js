// End-to-end in the real window: a video's sound tracks. An episode whose Hindi track plays first (and also has
// English): its details list both, Shelf's suggestion is "English plays first"; you remove the Hindi one (Ctrl+Z
// puts it back, then remove it again), add Spanish from another copy of the episode (lined up by Shelf), and Rename
// Now (Copy) makes a copy with English first, Spanish added and Hindi gone; Undo removes it. Nothing is re-encoded
// but the added track. Your original is never changed.
// Run with: node tests/sound.smoke.js   (needs the "playwright" package; SHOT=file.png saves a screenshot)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');
const A = require('../desktop/audiotracks');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FF = require('ffmpeg-static');
const SOUND = (f) => `aevalsrc='0.4*sin(2*PI*${f}*t)*gt(sin(2*PI*0.9*t)+sin(2*PI*1.37*t)+sin(2*PI*0.21*t),0.4)':s=48000:d=150`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sound-ui-'));
  const dl = path.join(tmp, 'Downloads'), lib = path.join(tmp, 'Library'), others = path.join(tmp, 'Other copies');
  [dl, lib, others].forEach((d) => fs.mkdirSync(d));
  const video = path.join(dl, 'Bonanza.S01E01.mkv'), spanish = path.join(others, 'Bonanza.S01E01.Latino.mka');
  execFileSync(FF, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x204060:s=160x90:r=10:d=150', '-f', 'lavfi', '-i', SOUND(330), '-f', 'lavfi', '-i', SOUND(440),
    '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '64k',
    '-metadata:s:a:0', 'language=hin', '-metadata:s:a:1', 'language=eng', '-disposition:a:0', 'default', '-disposition:a:1', '0', video]);
  // Another copy's Spanish sound, 0.8 s later than this one's.
  execFileSync(FF, ['-loglevel', 'error', '-y', '-i', video, '-map', '0:a:1', '-af', 'adelay=800|800', '-c:a', 'aac', '-b:a', '64k', '-metadata:s:a:0', 'language=spa', spanish]);
  const before = fs.statSync(video).size;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + profile, ROOT] });
  // The system dialogs: the folder to add, the other copy to take a sound track from, then the library folder.
  await app.evaluate(({ dialog }, picks) => { const q = [...picks]; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [q.shift()] }); }, [dl, spanish, lib]);
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('api.tvmaze.com/search')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([{ score: 1, show: { id: 1, name: 'Bonanza', premiered: '1959-09-12' } }]) });
    if (u.includes('api.tvmaze.com')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([{ season: 1, number: 1, name: 'A Rose for Lotta' }]) });
    return route.continue();
  });
  await win.waitForLoadState();
  await win.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  await win.click('#chooseFolder');
  const item = () => win.evaluate(() => { const v = window.Shelf.items()[0]; return v && { status: v.status, sound: v.sound && v.sound.tracks.map((t) => t.lang + (t.def ? '*' : '')), pick: v.soundPick || null }; });
  for (let i = 0; i < 100; i++) { const it = await item(); if (it && it.sound && !['pending', 'matching'].includes(it.status)) break; await sleep(150); }
  assert.deepStrictEqual((await item()).sound, ['hin*', 'eng'], 'its sound tracks were read');
  await win.evaluate(() => document.querySelector('[data-id="' + window.Shelf.items()[0].id + '"]').click());
  await win.waitForSelector('#inspSound:not([hidden])');
  const rows = () => win.$$eval('#inspSound .snd-row', (r) => r.map((x) => x.querySelector('.snd-name b').textContent + (x.classList.contains('is-off') ? ' (removed)' : '') + (x.querySelector('.snd-first input').checked ? ' (first)' : '')));
  assert.deepStrictEqual(await rows(), ['Hindi', 'English (first)'], 'Shelf suggests English first (your language)');
  assert.match(await win.textContent('#sndWhat'), /English plays first\. Nothing is re-encoded/);
  console.log('  ✓ the details list its sound tracks, with English to play first (Hindi played first)');

  // Remove Hindi; Ctrl+Z puts it back; remove it again.
  await win.click('#inspSound .snd-row:nth-child(1) input[type=checkbox]');
  await sleep(200);
  assert.deepStrictEqual(await rows(), ['Hindi (removed)', 'English (first)']);
  assert.match(await win.textContent('#sndWhat'), /English plays first; Hindi removed/);
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z'); await sleep(400);
  assert.deepStrictEqual(await rows(), ['Hindi', 'English (first)'], 'Ctrl+Z put it back');
  await win.click('#inspSound .snd-row:nth-child(1) input[type=checkbox]'); await sleep(200);
  console.log('  ✓ removing a track (and Ctrl+Z)');

  // Add Spanish from the other copy: Shelf lines it up.
  await win.click('#sndAdd');
  for (let i = 0; i < 100 && !(await item()).pick?.add; i++) await sleep(150);
  const pick = (await item()).pick;
  assert.ok(pick && pick.add && pick.add.lang === 'spa' && Math.abs(pick.add.offset - -0.8) < 0.06, JSON.stringify(pick));
  await sleep(200);
  assert.deepStrictEqual(await rows(), ['Hindi (removed)', 'English (first)', '+ Spanish']);
  assert.match(await win.textContent('#sndWhat'), /English plays first; Hindi removed; Spanish added. Only the added track is re-encoded/);
  assert.match(await win.textContent('#toast'), /lines up 0\.\d\d s earlier/);
  if (process.env.SHOT) await win.screenshot({ path: process.env.SHOT });
  console.log('  ✓ Spanish added from another copy, lined up (' + pick.add.offset + ' s)');

  // Rename Now, as a copy.
  await win.click('#renameBtn');
  await win.click('#renameSheet [data-mode=copy]');
  await win.click('#pickLib'); await sleep(300);
  assert.ok(await win.isVisible('#renameSoundRow'));
  assert.match(await win.textContent('#renameSoundLabel'), /sound tracks you picked \(1 video\)/);
  await win.click('#renameNow');
  const out = path.join(lib, 'TV Shows', 'Bonanza', 'Season 01', 'Bonanza - S01E01 - A Rose for Lotta.mkv');
  for (let i = 0; i < 200 && !fs.existsSync(out); i++) await sleep(150);
  for (let i = 0; i < 100 && (await item()).status !== 'done'; i++) await sleep(150);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  assert.ok(fs.existsSync(out), 'renamed: ' + walk(lib).join(' | '));
  const got = await A.list(out);
  assert.deepStrictEqual(got.tracks.map((t) => t.lang + (t.def ? '*' : '')), ['eng*', 'spa'], 'English first, Spanish added, Hindi gone');
  const sp = await A.align(video, out, 1);
  assert.ok(sp.ok && Math.abs(sp.offset) < 0.05, 'Spanish in time: ' + JSON.stringify(sp));
  assert.strictEqual(fs.statSync(video).size, before, 'your original untouched');
  assert.match(await win.evaluate(() => window.Shelf.items()[0].error), /English plays first; Hindi removed; Spanish added/);
  console.log('  ✓ Rename Now (Copy): English first, Spanish added and in time, Hindi gone; the original as it was');
  await win.click('#undoBar');
  for (let i = 0; i < 50 && fs.existsSync(out); i++) await sleep(150);
  assert.ok(!fs.existsSync(out) && fs.existsSync(video), 'Undo removed the copy');
  console.log('  ✓ Undo removed the copy');

  assert.deepStrictEqual(errors, [], 'no errors in the window');
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Sound tracks window test passed');
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
