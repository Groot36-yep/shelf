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
  // Straight out of a black moment (within 1.5 s): where a title card almost always is.
  return runs.map((r) => { r.rightAfterBlack = blacks.some((b) => r.start >= b.b - 0.6 && r.start - b.b <= 1.5); return r; })
    .map((r) => ({ r, score: Math.abs(r.t - likely) / 30 - (afterBlack(r) ? 3 : 0) - (r.rightAfterBlack ? 4 : 0) - Math.min(r.secs, 4) / 4 }))
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
// Black-on-white image of pixels at or below a darkness cut (black lettering with coloured outlines).
function darkOnly(plane, keep) {
  const hist = new Uint32Array(256); for (let k = 0; k < plane.length; k++) hist[plane[k]]++;
  let acc = 0, cut = 0; const target = plane.length * keep;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) { cut = v; break; } }
  cut = Math.min(cut, 110);
  const out = new Uint8Array(plane.length); for (let k = 0; k < plane.length; k++) out[k] = plane[k] <= cut ? 0 : 255;
  return out;
}
// Strongly coloured pixels (red, blue, green lettering) as black on white.
function colourful(r, g, b, keep) {
  const n = r.length, sat = new Uint8Array(n);
  for (let k = 0; k < n; k++) { const mx = Math.max(r[k], g[k], b[k]), mn = Math.min(r[k], g[k], b[k]); sat[k] = mx > 40 ? ((mx - mn) * 255 / mx) | 0 : 0; }
  return brightOnly(sat, keep);
}
// Each main colour of the frame on its own, as black on white: title lettering is usually one flat colour.
function colourLayers(r, g, b, K) {
  const n = r.length, step = Math.max(1, Math.floor(n / 6000));
  const c = [];
  for (let i = 0; i < K; i++) { const j = Math.floor((i + 0.5) / K * n); c.push([r[j], g[j], b[j]]); }
  for (let it = 0; it < 8; it++) {
    const sum = c.map(() => [0, 0, 0, 0]);
    for (let k = 0; k < n; k += step) {
      let bi = 0, bd = 1e9;
      for (let q = 0; q < K; q++) { const d = (r[k] - c[q][0]) ** 2 + (g[k] - c[q][1]) ** 2 + (b[k] - c[q][2]) ** 2; if (d < bd) { bd = d; bi = q; } }
      sum[bi][0] += r[k]; sum[bi][1] += g[k]; sum[bi][2] += b[k]; sum[bi][3]++;
    }
    sum.forEach((v, q) => { if (v[3]) c[q] = [v[0] / v[3], v[1] / v[3], v[2] / v[3]]; });
  }
  const lab = new Uint8Array(n), count = new Uint32Array(K);
  for (let k = 0; k < n; k++) {
    let bi = 0, bd = 1e9;
    for (let q = 0; q < K; q++) { const d = (r[k] - c[q][0]) ** 2 + (g[k] - c[q][1]) ** 2 + (b[k] - c[q][2]) ** 2; if (d < bd) { bd = d; bi = q; } }
    lab[k] = bi; count[bi]++;
  }
  const out = [];
  // Lettering covers a small-to-medium share of the frame; skip the background and specks.
  const order = Array.from({ length: K }, (_, q) => q).filter((q) => count[q] / n >= 0.03 && count[q] / n <= 0.5).sort((x, y) => count[x] - count[y]);
  for (const q of order) { const m = new Uint8Array(n); for (let k = 0; k < n; k++) m[k] = lab[k] === q ? 0 : 255; out.push(m); }
  return out;
}
// White lettering: bright, colourless pixels (painted signs, "CLUB SPONGEBOB").
function whiteOnly(r, g, b) {
  const n = r.length, out = new Uint8Array(n);
  for (let k = 0; k < n; k++) { const mn = Math.min(r[k], g[k], b[k]), mx = Math.max(r[k], g[k], b[k]); out[k] = mn >= 190 && mx - mn < 40 ? 0 : 255; }
  return out;
}
// The same size, turned by a few degrees.
function turned(plane, W, h, deg) {
  const out = new Uint8Array(W * h).fill(255);
  const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), cx = W / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy, sx = Math.round(ca * dx + sa * dy + cx), sy = Math.round(-sa * dx + ca * dy + cy);
      if (sx >= 0 && sx < W && sy >= 0 && sy < h) out[y * W + x] = plane[sy * W + sx];
    }
  }
  return { w: W, h, data: out };
}
// A half-size copy turned by a few degrees (bouncy, tilted lettering reads better straightened).
function turnedHalf(plane, W, h, deg) {
  const w2 = W >> 1, h2 = h >> 1, out = new Uint8Array(w2 * h2).fill(255);
  const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), cx = w2 / 2, cy = h2 / 2;
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = Math.round((ca * dx + sa * dy + cx) * 2), sy = Math.round((-sa * dx + ca * dy + cy) * 2);
      if (sx >= 0 && sx < W && sy >= 0 && sy < h) out[y * w2 + x] = plane[sy * W + sx];
    }
  }
  return { w: w2, h: h2, data: out };
}
/**
 * Versions of one frame for the text reader, most useful first. full: also the slower ones
 * (used only on the few frames most likely to be the title card).
 */
// Frames are read at 480 pixels wide by default: lettering that fills the screen reads much better
// at that size than at full size (and four times faster).
async function frameVariants(file, t, full, width) {
  const W = width || 480;
  const raw = await runCapture(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(Math.max(0, t)), '-i', file,
    '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `scale=${W}:-2,format=gbrp`, '-f', 'rawvideo', '-'
  ], 60000, 40e6);
  const plane = raw.length / 3, h = Math.round(plane / W);
  if (!h) return [];
  const g = raw.subarray(0, plane), b = raw.subarray(plane, 2 * plane), r = raw.subarray(2 * plane, 3 * plane);
  const y = new Uint8Array(plane); for (let k = 0; k < plane; k++) y[k] = (r[k] * 77 + g[k] * 150 + b[k] * 29) >> 8;
  // Tried in this order; Shelf stops as soon as one reads as a known title.
  const out = [pgm(W, h, y), pgm(W, h, brightOnly(g, 0.18)), pgm(W, h, darkOnly(y, 0.2))];
  if (full) {
    const white = whiteOnly(r, g, b);
    out.push(pgm(W, h, white));
    for (const deg of [5, -5]) { const t2 = W > 640 ? turnedHalf(white, W, h, deg) : turned(white, W, h, deg); out.push(pgm(t2.w, t2.h, t2.data)); }
    out.push(pgm(W, h, colourful(r, g, b, 0.2)));
    for (const m of colourLayers(r, g, b, 6)) out.push(pgm(W, h, m));
    out.push(pgm(W, h, g), pgm(W, h, brightOnly(y, 0.18)), pgm(W, h, brightOnly(r, 0.18)));
  }
  out.preview = preview(W, h, r, g, b);
  return out;
}
// A small colour copy of the frame (RGBA, 1/5 size), so the window can show what's being read. Kept in memory only.
function preview(W, h, r, g, b) {
  const f = Math.max(1, Math.round(W / 192)), pw = Math.floor(W / f), ph = Math.floor(h / f);
  const data = new Uint8Array(pw * ph * 4);
  for (let yy = 0; yy < ph; yy++) {
    for (let xx = 0; xx < pw; xx++) {
      // average a 2×2 patch from the middle of each 5×5 block: cheap, and smoother than picking one pixel
      const k0 = (yy * f + 2) * W + xx * f + 2, k1 = k0 + 1, k2 = k0 + W, k3 = k2 + 1, o = (yy * pw + xx) * 4;
      data[o] = (r[k0] + r[k1] + r[k2] + r[k3]) >> 2;
      data[o + 1] = (g[k0] + g[k1] + g[k2] + g[k3]) >> 2;
      data[o + 2] = (b[k0] + b[k1] + b[k2] + b[k3]) >> 2;
      data[o + 3] = 255;
    }
  }
  return { w: pw, h: ph, data };
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
      currentPsm = '11';
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

let currentPsm = '11';
// psm '11' looks for words anywhere (most title cards); '6' reads the picture as one block of text,
// which suits big lettering that fills the screen.
async function readText(png, psm) {
  const w = await ocrWorker();
  psm = psm || '11';
  if (psm !== currentPsm) { await w.setParameters({ tessedit_pageseg_mode: psm }); currentPsm = psm; }
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

// Black fades most likely to be the gap between cartoons: longer ones first (a real gap is a second or
// more; a scene cut is a flicker), then the ones nearest to where a card is expected.
function fadeOrder(blacks, likely) {
  return (blacks || []).filter((b) => b.b - b.a >= 0.4)
    .map((b) => ({ b, score: -Math.min(b.b - b.a, 2) + Math.abs(b.b - likely) / 120 }))
    .sort((x, y) => x.score - y.score).map((x) => x.b);
}
// Words from a cartoon's opening credits.
const CREDITS = /story ?board|written|directors?\b|director|animation|supervising|producer|creative/i;

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
    let k = 0, found = false;
    // Title cards come straight after a black fade, often fading in: besides the still moments, look
    // a moment after the black fades nearest to where a card is expected.
    const probeBlacks = fadeOrder(runs.blacks, wins[i].likely).slice(0, 2);
    const probes = [].concat(...probeBlacks.map((b) => [0.8, 1.6].map((d) => ({ t: b.b + d, start: b.b, secs: 0, probe: true, rightAfterBlack: true }))));
    if (tryRuns.length > 4) tryRuns.splice(4, 0, ...probes); else tryRuns.push(...probes);
    for (const run of tryRuns) {
      if (opts.cancelled && opts.cancelled()) break;
      frames++;
      report(i, 0.2 + 0.8 * (k++ / tryRuns.length));
      const read = [];
      // The likeliest few frames (and any straight after a black moment) get every version of the
      // picture; the rest only the quick ones.
      const imgs = await frameVariants(file, run.t, k <= 4 || run.rightAfterBlack);
      if (opts.onPeek && imgs.preview) opts.onPeek({ part: i, t: run.t, image: imgs.preview });
      let hit = null;
      const tryImgs = async (list, psm) => {
        for (const img of list) {
          const text = await readText(img, psm);
          if (text.replace(/[^A-Za-z]/g, '').length >= 3) read.push(text.slice(0, 300));
          if (opts.isMatch && read.length && (hit = opts.isMatch(read, i))) return;
        }
      };
      await tryImgs(imgs);
      // Small lettering: the likeliest frames also get a look at full size.
      if (!hit && (k <= 4 || run.rightAfterBlack)) await tryImgs(await frameVariants(file, run.t, false, 960));
      // Cards often fade in: near the end of the still moment the lettering is at its clearest.
      if (!hit && (k <= 4 || run.rightAfterBlack) && run.secs >= 1.5) await tryImgs(await frameVariants(file, run.start + run.secs - 0.4, true));
      if (read.length) texts.push({ part: i, t: Math.round(run.t * 10) / 10, start: Math.round(run.start * 10) / 10, secs: run.secs, texts: read });
      if (opts.onFrame) opts.onFrame();
      if (hit) { found = true; if (opts.onFound) opts.onFound({ part: i, t: run.t, hit }); break; } // found this cartoon's card
    }
    // Deep scan (only when you ask for it): the parts still without a card get many more tries:
    // more frames from each still moment, several sizes, both ways of reading.
    if (opts.deep && !found && !(opts.cancelled && opts.cancelled())) {
      // The likeliest still moments, and every one straight after a black moment.
      const ranked = rankRuns(runs, wins[i].likely);
      const cands = ranked.slice(0, 6).concat(ranked.slice(6).filter((r) => r.rightAfterBlack).slice(0, 4));
      fadeOrder(runs.blacks, wins[i].likely).slice(0, 3)
        .forEach((b) => cands.push({ start: b.b, probeTimes: [0.6, 1.0, 1.4, 1.8, 2.4].map((d) => b.b + d), probe: true }));
      let n = 0;
      deep: for (const run of cands) {
        // The middle and (cards fade in) near the end of the still moment.
        const times = run.probeTimes || (run.secs >= 1.5 ? [run.start + run.secs - 0.4, run.t] : [run.t]);
        const votes = {}; // title → the readings (one group per size, way of reading and moment) that found it
        for (const tt of times) {
          if (opts.cancelled && opts.cancelled()) break deep;
          n++; frames++;
          if (opts.onProgress) opts.onProgress(Math.min(1, (i + 0.2 + 0.8 * Math.min(1, n / (cands.length * 2))) / wins.length));
          const read = [];
          let hit = null, hitTexts = null;
          for (const width of [480, 400, 360, 640, 960]) {
            // Every version of the picture at the two sizes that read best; the quick ones at the rest.
            const imgs = await frameVariants(file, tt, width === 480 || width === 400, width);
            if (opts.onPeek && imgs.preview && width === 480) opts.onPeek({ part: i, t: tt, image: imgs.preview, deep: true });
            for (const psm of ['11', '6']) {
              const before = read.length;
              for (const img of imgs) {
                if (opts.cancelled && opts.cancelled()) break deep;
                const text = await readText(img, psm);
                if (text.replace(/[^A-Za-z]/g, '').length >= 3) read.push(text.slice(0, 300));
                // Each size and way of reading is judged on its own readings (pooling everything a
                // deep scan reads would make chance matches likely).
              }
              const mine = read.slice(before);
              // A deep scan reads so much that a single chance match is likely; a title counts only
              // when two different sizes or ways of reading agree on it.
              const m = opts.isMatch && mine.length ? opts.isMatch(mine, i) : null;
              if (m) {
                const key = m.entry ? m.entry.name : String(m);
                (votes[key] = votes[key] || []).push(mine);
                if (votes[key].length >= 2) { hit = m; hitTexts = [].concat.apply([], votes[key]).slice(0, 30); break; }
              }
            }
            if (hit) break;
          }
          // Only the readings that made the match are kept (see above).
          if (hit) texts.push({ part: i, t: Math.round(tt * 10) / 10, start: Math.round(run.start * 10) / 10, secs: run.secs, texts: hitTexts, deep: true });
          if (hit) { found = true; if (opts.onFound) opts.onFound({ part: i, t: tt, hit }); break deep; }
        }
      }
    }
    // No card read for a later cartoon: is one starting here at all? A new cartoon shows its
    // credits ("storyboard directors", "written by") a few seconds after a black moment; one long
    // episode doesn't. Shelf notes what it sees so the file isn't wrongly called one episode.
    if (i > 0 && !found && !(opts.cancelled && opts.cancelled())) {
      // A short still moment between two black fades (black → card → black) is a title card even
      // when its lettering can't be read: a new cartoon starts here.
      const bl = runs.blacks || [];
      const sandwich = bl.find((b1, j) => bl[j + 1] && bl[j + 1].a - b1.b >= 1 && bl[j + 1].a - b1.b <= 5);
      if (sandwich) texts.push({ part: i, t: Math.round((sandwich.b + 0.5) * 10) / 10, start: sandwich.b, texts: [], boundary: true });
    }
    if (i > 0 && !found && !texts.some((x) => x.part === i && x.boundary) && !(opts.cancelled && opts.cancelled())) {
      const gaps = (runs.blacks || []).filter((b) => b.b - b.a >= 0.4).sort((x, y) => Math.abs(x.b - wins[i].likely) - Math.abs(y.b - wins[i].likely)).slice(0, 3);
      seek: for (const g of gaps) {
        for (const dt of [3.5, 6, 9]) {
          if (opts.cancelled && opts.cancelled()) break seek;
          const imgs = await frameVariants(file, g.b + dt, false);
          const text = imgs.length ? await readText(imgs[0]) : '';
          if (CREDITS.test(text)) { texts.push({ part: i, t: Math.round((g.b + dt) * 10) / 10, start: Math.round(g.b * 10) / 10, texts: [text.slice(0, 300)], boundary: true }); break seek; }
        }
      }
    }
  }
  report(wins.length, 0);
  return { texts, frames };
}

module.exports = { scanFile, stopOcr, windowsFor, readText, ffmpegPath, stills, frameVariants };
