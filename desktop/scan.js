/*
 * Shelf desktop — read the title cards inside a video, entirely on this computer.
 *
 * How: around where each cartoon probably starts, the bundled ffmpeg makes tiny thumbnails
 * (two a second) to find moments where the picture holds still — title cards always do. Only
 * those moments are decoded at full size, in memory, and the bundled Tesseract OCR reads them
 * (plain, and with only the brightest pixels kept, since cartoon lettering sits on busy
 * backgrounds). Nothing is uploaded or downloaded: the OCR's English data ships inside Shelf,
 * and no pictures are written to disk.
 *
 * Only runs for files the user picked, after they confirmed a prompt naming those files.
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');

// Inside the packaged app these live in app.asar.unpacked (real files the OS can run).
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function ffmpegPath() { return unpacked(require('ffmpeg-static')); }

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Took too long')); }, timeoutMs);
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.split('\n').filter(Boolean).pop() || 'ffmpeg failed')); });
  });
}

function runCapture(cmd, args, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Took too long')); }, timeoutMs);
    child.stdout.on('data', (d) => { size += d.length; if (size <= maxBytes) chunks.push(d); });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.split('\n').filter(Boolean).pop() || 'ffmpeg failed')); });
  });
}

// ---- 1. Find still moments: title cards hold still for a few seconds ----
const TW = 96, TH = 72, RATE = 2; // tiny grey thumbnails, 2 per second
async function stills(file, from, len) {
  const buf = await runCapture(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(Math.max(0, from)), '-t', String(len), '-i', file,
    '-an', '-sn', '-dn', '-vf', `fps=${RATE},scale=${TW}:${TH},format=gray`, '-f', 'rawvideo', '-'
  ], 240000, TW * TH * RATE * 700);
  const n = Math.floor(buf.length / (TW * TH));
  const frames = []; for (let i = 0; i < n; i++) frames.push(buf.subarray(i * TW * TH, (i + 1) * TW * TH));
  const diff = (a, b) => { let d = 0; for (let k = 0; k < a.length; k += 2) d += Math.abs(a[k] - b[k]); return d / (a.length / 2); };
  const spread = (a) => { let m = 0; for (let k = 0; k < a.length; k++) m += a[k]; m /= a.length; let v = 0; for (let k = 0; k < a.length; k++) v += (a[k] - m) * (a[k] - m); return Math.sqrt(v / a.length); };
  const mean = (a) => { let m = 0; for (let k = 0; k < a.length; k += 3) m += a[k]; return m / (a.length / 3); };
  const still = frames.map((f, i) => i > 0 && diff(frames[i - 1], f) < 6 && spread(f) > 10);
  // Black moments (between cartoons): runs of near-black thumbnails.
  const dark = frames.map((f) => mean(f) < 18 && spread(f) < 14);
  const blacks = [];
  for (let i = 0; i < n; i++) {
    if (!dark[i]) continue;
    let j = i; while (j + 1 < n && dark[j + 1]) j++;
    blacks.push({ a: from + i / RATE, b: from + (j + 1) / RATE });
    i = j;
  }
  // Runs of still frames → the middle of each run is a candidate.
  const runs = [];
  for (let i = 0; i < n; i++) {
    if (!still[i]) continue;
    let j = i; while (j + 1 < n && still[j + 1]) j++;
    runs.push({ t: from + ((i - 1 + j) / 2) / RATE, start: from + (i - 1) / RATE, secs: (j - i + 2) / RATE });
    i = j;
  }
  runs.blacks = blacks;
  return runs;
}

// Order still moments by how likely each is to be a title card: right after a black moment is
// best (a new cartoon starting), then closeness to where a card usually is, longer holds first.
function rankRuns(runs, likely) {
  const blacks = runs.blacks || [];
  const afterBlack = (r) => blacks.some((b) => r.start >= b.b - 0.6 && r.start - b.b <= 25);
  return runs.map((r) => ({ r, score: Math.abs(r.t - likely) / 30 - (afterBlack(r) ? 3 : 0) - Math.min(r.secs, 4) / 4 }))
    .sort((x, y) => x.score - y.score).map((x) => x.r);
}

// ---- 2. One full-size frame, prepared several ways for the text reader ----
function pgm(w, h, data) { return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`, 'latin1'), Buffer.from(data.buffer, data.byteOffset, data.length)]); }
// Black-on-white image of the brightest pixels (the lettering on most title cards).
function brightOnly(plane, keep) {
  const hist = new Uint32Array(256); for (let k = 0; k < plane.length; k++) hist[plane[k]]++;
  let acc = 0, cut = 255; const target = plane.length * (1 - keep);
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) { cut = v; break; } }
  cut = Math.max(cut, 120);
  const out = new Uint8Array(plane.length); for (let k = 0; k < plane.length; k++) out[k] = plane[k] > cut ? 0 : 255;
  return out;
}
async function frameVariants(file, t) {
  const W = 960;
  const raw = await runCapture(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(Math.max(0, t)), '-i', file,
    '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `scale=${W}:-2,format=gbrp`, '-f', 'rawvideo', '-'
  ], 60000, 40e6);
  const plane = raw.length / 3, h = Math.round(plane / W);
  if (!h) return [];
  const g = raw.subarray(0, plane), b = raw.subarray(plane, 2 * plane), r = raw.subarray(2 * plane, 3 * plane);
  const y = new Uint8Array(plane); for (let k = 0; k < plane; k++) y[k] = (r[k] * 77 + g[k] * 150 + b[k] * 29) >> 8;
  // Tried in this order; Shelf stops as soon as one reads as a known title.
  return [pgm(W, h, y), pgm(W, h, brightOnly(g, 0.18)), pgm(W, h, g), pgm(W, h, brightOnly(y, 0.18)), pgm(W, h, brightOnly(r, 0.18))];
}

let workerPromise = null;
function ocrWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    const eng = require('@tesseract.js-data/eng');
    const tessDir = path.dirname(require.resolve('tesseract.js/package.json'));
    workerPromise = createWorker('eng', 1, {
      langPath: unpacked(eng.langPath),          // bundled data: never fetched from the internet
      gzip: true,
      cacheMethod: 'none',                       // don't write a copy anywhere
      workerPath: unpacked(path.join(tessDir, 'src', 'worker-script', 'node', 'index.js')),
      logger: () => {}
    }).then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: '11' }); // sparse text: big words anywhere on screen
      return w;
    });
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}
async function stopOcr() {
  if (!workerPromise) return;
  const p = workerPromise; workerPromise = null;
  try { (await p).terminate(); } catch (e) { /* ignore */ }
}

async function readText(png) {
  const w = await ocrWorker();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The text reader stopped responding')), 20000); });
  try {
    const { data } = await Promise.race([w.recognize(png), timeout]);
    return String(data.text || '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    await stopOcr(); // start a fresh one next time
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Leftovers from a scan that was interrupted (e.g. the computer shut down): remove them.
async function cleanStale() {
  try {
    const now = Date.now();
    for (const n of await fsp.readdir(os.tmpdir())) {
      if (!n.startsWith('shelf-scan-')) continue;
      const full = path.join(os.tmpdir(), n);
      const st = await fsp.stat(full).catch(() => null);
      if (st && now - st.mtimeMs > 10 * 60 * 1000) await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
}

/**
 * Where to look: around where each cartoon in the video probably starts.
 * secs: running time (or null). Returns [{ from, len, likely }] — `likely` is where its
 * title card most often is (after the theme song for the first cartoon), tried first.
 */
function windowsFor(secs) {
  const d = secs || 1320;
  const parts = Math.max(1, Math.min(4, Math.round(d / 660)));
  const out = [];
  for (let i = 0; i < parts; i++) {
    const start = (d * i) / parts;
    out.push(i === 0
      ? { from: 0, len: Math.min(240, d), likely: Math.min(50, d / 4) }
      : { from: Math.max(0, start - 150), len: Math.min(300, d - Math.max(0, start - 150)), likely: start + 10 });
  }
  return out;
}

/**
 * Read the title cards of one video.
 * opts.isMatch(texts) → true once the readings match a known title (Shelf then stops for that part).
 * Returns { texts: [{ part, t, texts }], frames }.
 */
async function scanFile(file, secs, opts) {
  opts = opts || {};
  await cleanStale();
  const texts = [];
  let frames = 0;
  const wins = windowsFor(secs);
  // How far along this video is, 0..1 (each cartoon's part is an equal share).
  const report = (part, frac) => { if (opts.onProgress) opts.onProgress(Math.min(1, (part + frac) / wins.length)); };
  for (let i = 0; i < wins.length; i++) {
    if (opts.cancelled && opts.cancelled()) break;
    report(i, 0.02);
    const runs = await stills(file, wins[i].from, wins[i].len);
    report(i, 0.2);
    // Most likely spots first; at most 30 still moments per cartoon.
    const tryRuns = rankRuns(runs, wins[i].likely).slice(0, i ? 45 : 30);
    let k = 0;
    for (const run of tryRuns) {
      if (opts.cancelled && opts.cancelled()) break;
      frames++;
      report(i, 0.2 + 0.8 * (k++ / tryRuns.length));
      const read = [];
      for (const img of await frameVariants(file, run.t)) {
        const text = await readText(img);
        if (text.replace(/[^A-Za-z]/g, '').length >= 3) read.push(text.slice(0, 300));
        if (opts.isMatch && read.length && opts.isMatch(read, i)) break;
      }
      if (read.length) texts.push({ part: i, t: Math.round(run.t * 10) / 10, start: Math.round(run.start * 10) / 10, secs: run.secs, texts: read });
      if (opts.onFrame) opts.onFrame();
      if (opts.isMatch && read.length && opts.isMatch(read, i)) break; // found this cartoon's card
    }
  }
  report(wins.length, 0);
  return { texts, frames };
}

module.exports = { scanFile, stopOcr, windowsFor, readText, ffmpegPath, stills, frameVariants };
