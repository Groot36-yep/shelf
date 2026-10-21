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
const hwaccel = require('./hwaccel');

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
// The thumbnails, on the graphics card when that's faster for this video (see hwaccel.js), else
// (or if the card fails) on the processor.
async function thumbnails(file, from, len) {
  const seek = ['-ss', String(Math.max(0, from)), '-t', String(len)];
  const run = (input, vf) => runCapture(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin'].concat(input, seek, ['-i', file,
    '-an', '-sn', '-dn', '-vf', vf, '-f', 'rawvideo', '-']), 240000, TW * TH * RATE * 700);
  const plan = await hwaccel.thumbPlan(file, RATE, TW, TH).catch(() => null);
  if (plan) {
    try {
      const buf = await run(plan.input, plan.vf);
      if (buf.length >= TW * TH) { hwaccel.worked(plan.method); return buf; }
    } catch (e) { /* the processor takes over */ }
    hwaccel.failed(plan.method);
  }
  return run([], `fps=${RATE},scale=${TW}:${TH},format=gray`);
}
async function stills(file, from, len) {
  const buf = await thumbnails(file, from, len);
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
// ---- The lettering on its own ----
// A title card's lettering is a handful of big blobs of one flat colour, away from the frame's edges. The
// background's pattern, bubbles and texture are specks, huge areas, or run off the edges. So each main colour
// of the frame is split into blobs (touching pixels) and only the letter-sized ones are kept: the reader
// then sees black lettering on plain white, and nothing else to trip over.

// The frame's main colours (k-means, started from colours far apart, so a small one like the lettering
// gets a colour of its own).
function mainColours(r, g, b, K) {
  const n = r.length, step = Math.max(1, Math.floor(n / 8000)), idx = [];
  for (let k = 0; k < n; k += step) idx.push(k);
  const d2 = (k, c) => (r[k] - c[0]) ** 2 + (g[k] - c[1]) ** 2 + (b[k] - c[2]) ** 2;
  const c = [[r[idx[0]], g[idx[0]], b[idx[0]]]], near = new Float64Array(idx.length).fill(Infinity);
  while (c.length < K) {
    let far = 0, fd = -1;
    for (let i = 0; i < idx.length; i++) { const d = d2(idx[i], c[c.length - 1]); if (d < near[i]) near[i] = d; if (near[i] > fd) { fd = near[i]; far = i; } }
    c.push([r[idx[far]], g[idx[far]], b[idx[far]]]);
  }
  for (let it = 0; it < 6; it++) {
    const sum = c.map(() => [0, 0, 0, 0]);
    for (const k of idx) {
      let bi = 0, bd = Infinity;
      for (let q = 0; q < K; q++) { const d = d2(k, c[q]); if (d < bd) { bd = d; bi = q; } }
      sum[bi][0] += r[k]; sum[bi][1] += g[k]; sum[bi][2] += b[k]; sum[bi][3]++;
    }
    sum.forEach((v, q) => { if (v[3]) c[q] = [v[0] / v[3], v[1] / v[3], v[2] / v[3]]; });
  }
  return c;
}
// Of the black pixels in `mask`, only the blobs shaped like big letters (or a joined-up word), as black on
// white; null when there are none. Also the share of the frame they cover. Smaller blobs among the big
// letters are kept too: lowercase letters, dots, and little words like "and" or "of".
function letterBlobs(mask, W, h) {
  const n = W * h, seen = new Uint8Array(n), stack = new Int32Array(n), out = new Uint8Array(n).fill(255);
  let kept = 0, keptArea = 0, kx0 = W, kx1 = 0, ky0 = h, ky1 = 0;
  const small = [], boxes = [];
  for (let s = 0; s < n; s++) {
    if (mask[s] || seen[s]) continue;
    let top = 0, area = 0, x0 = W, x1 = 0, y0 = h, y1 = 0;
    const px = [];
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const k = stack[--top], x = k % W, y = (k - x) / W;
      area++; px.push(k);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !mask[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[top++] = k - 1; }
      if (x < W - 1 && !mask[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[top++] = k + 1; }
      if (y > 0 && !mask[k - W] && !seen[k - W]) { seen[k - W] = 1; stack[top++] = k - W; }
      if (y < h - 1 && !mask[k + W] && !seen[k + W]) { seen[k + W] = 1; stack[top++] = k + W; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, fill = area / (bw * bh);
    const edge = x0 <= 1 || y0 <= 1 || x1 >= W - 2 || y1 >= h - 2;
    if (edge || bh > h * 0.6 || bw > W * 0.9) continue;
    // (Thin joined-up writing, "your Shoe's Untied" in rope, fills little of its box; a big letter never fills
    // all of it, though a dot does.)
    if (bh < h * 0.07 || area < n * 0.0015 || fill < 0.06 || fill > 0.9) {
      if (bh >= h * 0.025 && bh < h * 0.07 && area >= n * 0.0002) small.push({ x0, x1, y0, y1, px });
      continue;
    }
    kept++; keptArea += area; boxes.push({ y: (y0 + y1) / 2, h: bh });
    if (x0 < kx0) kx0 = x0; if (x1 > kx1) kx1 = x1; if (y0 < ky0) ky0 = y0; if (y1 > ky1) ky1 = y1;
    for (const k of px) out[k] = 0;
  }
  if (!kept) return null;
  // The small ones within (or just around) the big letters' area.
  const mx = W * 0.08, my = h * 0.08;
  for (const c of small) {
    if (c.x0 >= kx0 - mx && c.x1 <= kx1 + mx && c.y0 >= ky0 - my && c.y1 <= ky1 + my) for (const k of c.px) out[k] = 0;
  }
  // Letters sit in rows, side by side at about the same height; a background's shapes mostly don't.
  const rowed = boxes.filter((a) => boxes.some((o) => o !== a && Math.abs(a.y - o.y) < 0.4 * Math.max(a.h, o.h) && a.h / o.h > 0.6 && a.h / o.h < 1.67)).length;
  return { data: out, share: keptArea / n, kept, rowed };
}
// Lettering set at a slant ("Life of Crime"), turned level: the angle at which the letters' rows line up best.
// null when it's level already.
function levelled(mask, W, h) {
  const xs = [], ys = [];
  for (let k = 0; k < mask.length; k++) if (!mask[k]) { xs.push(k % W); ys.push((k / W) | 0); }
  if (xs.length < 50) return null;
  const energy = (deg) => {
    const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), bins = new Float64Array(h * 2);
    for (let i = 0; i < xs.length; i++) { const y2 = Math.round(-sa * (xs[i] - W / 2) + ca * (ys[i] - h / 2) + h); if (y2 >= 0 && y2 < bins.length) bins[y2]++; }
    let e = 0; for (const v of bins) e += v * v; return e;
  };
  let best = 0, bestE = energy(0);
  for (let deg = -30; deg <= 30; deg += 2) { if (!deg) continue; const e = energy(deg); if (e > bestE) { bestE = e; best = deg; } }
  if (Math.abs(best) < 6 || bestE < energy(0) * 1.15) return null;
  return turned(mask, W, h, -best).data;
}
// The lettering, cleaned: the frame's main colours each reduced to their letter-sized blobs, the most
// lettering-like first (at most `max`).
function letteringLayers(r, g, b, W, h, K, max) {
  const n = r.length, c = mainColours(r, g, b, K), lab = new Uint8Array(n), count = new Uint32Array(K);
  for (let k = 0; k < n; k++) {
    let bi = 0, bd = Infinity;
    for (let q = 0; q < K; q++) { const d = (r[k] - c[q][0]) ** 2 + (g[k] - c[q][1]) ** 2 + (b[k] - c[q][2]) ** 2; if (d < bd) { bd = d; bi = q; } }
    lab[k] = bi; count[bi]++;
  }
  const found = [];
  for (let q = 0; q < K; q++) {
    if (count[q] < n * 0.01 || count[q] > n * 0.45) continue;
    const m = new Uint8Array(n); for (let k = 0; k < n; k++) m[k] = lab[k] === q ? 0 : 255;
    const L = letterBlobs(m, W, h);
    // Most of this colour is in letter-sized blobs: that's lettering, not background. The more of them sit in
    // rows, the likelier (the share of the frame they cover only breaks ties).
    if (L && L.share >= count[q] / n * 0.35) found.push(Object.assign(L, { score: (0.25 + L.rowed / L.kept) * Math.min(L.rowed + 1, 9) + L.share }));
  }
  return found.sort((x, y) => y.score - x.score).slice(0, max).map((L) => L.data);
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
  // Tried in this order; Shelf stops as soon as one reads as a known title. The cleaned lettering first.
  const letters = letteringLayers(r, g, b, W, h, 8, 2);
  const out = letters.slice(0, 1).map((m) => pgm(W, h, m)).concat([pgm(W, h, y)], letters.slice(1, 2).map((m) => pgm(W, h, m)), [pgm(W, h, darkOnly(y, 0.2))]);
  out.lettering = letters.length ? out[0] : null;
  if (full) {
    // Slanted lettering turned level.
    const flat = letters[0] && levelled(letters[0], W, h);
    if (flat) out.push(pgm(W, h, flat));
    // Both lettering colours together (letters drawn in two shades, like bubbles).
    if (letters[1]) { const both = new Uint8Array(plane); for (let k = 0; k < plane; k++) both[k] = letters[0][k] & letters[1][k]; out.push(pgm(W, h, both)); }
    out.push(pgm(W, h, brightOnly(g, 0.18)));
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

// Reading text is most of a scan's time, and one reader uses one processor core. Several readers
// work side by side (one per spare core, at most 6), each on its own picture.
// One text reader per spare processor core, up to 6, but never more than free memory comfortably holds
// (each reader keeps its own copy of the OCR engine, roughly 100-150 MB): a busy 8 GB laptop gets fewer
// readers instead of being pushed into swapping.
const OCR_READER_MB = 160;
const OCR_READERS = Number(process.env.SHELF_OCR_READERS) || Math.max(1, Math.min(6, (os.cpus() || []).length - 2 || 1,
  Math.floor((os.freemem() / 1048576 - 1024) / OCR_READER_MB)));
let readers = [];      // [{ worker: Promise, psm, busy }]
const waiting = [];    // callers waiting for a free reader
function newReader() {
  const { createWorker } = require('tesseract.js');
  const eng = require('@tesseract.js-data/eng');
  const tessDir = path.dirname(require.resolve('tesseract.js/package.json'));
  const r = { psm: '11', busy: false };
  r.worker = createWorker('eng', 1, {
    langPath: unpacked(eng.langPath),          // bundled data: never fetched from the internet
    gzip: true,
    cacheMethod: 'none',                       // don't write a copy anywhere
    workerPath: unpacked(path.join(tessDir, 'src', 'worker-script', 'node', 'index.js')),
    logger: () => {}
  }).then(async (w) => {
    await w.setParameters({ tessedit_pageseg_mode: '11' }); // sparse text: big words anywhere on screen
    return w;
  });
  r.worker.catch(() => { readers = readers.filter((x) => x !== r); });
  return r;
}
// Starting the readers takes about half a second, so after a batch they stay ready for a minute
// in case you read more title cards; then they're stopped. (Quitting or erasing stops them at once.)
const OCR_IDLE_MS = 60000;
let idleTimer = null;
function stopOcrSoon(ms) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleTimer = null; stopOcr(); }, ms == null ? OCR_IDLE_MS : ms);
  if (idleTimer.unref) idleTimer.unref(); // never what keeps the app (or a test) running
}
// A free reader (a new one while there's a spare core), or wait for one to finish.
function takeReader() {
  clearTimeout(idleTimer); idleTimer = null; // in use again: keep them
  const free = readers.find((r) => !r.busy);
  if (free) { free.busy = true; return Promise.resolve(free); }
  if (readers.length < OCR_READERS) { const r = newReader(); r.busy = true; readers.push(r); return Promise.resolve(r); }
  return new Promise((resolve) => waiting.push(resolve));
}
function giveBack(r) {
  if (!readers.includes(r)) return; // stopped meanwhile
  const next = waiting.shift();
  if (next) next(r); else r.busy = false;
}
async function stopOcr() {
  clearTimeout(idleTimer); idleTimer = null;
  const old = readers; readers = [];
  for (const r of old) { try { (await r.worker).terminate(); } catch (e) { /* ignore */ } }
}
async function stopReader(r) {
  readers = readers.filter((x) => x !== r);
  try { (await r.worker).terminate(); } catch (e) { /* ignore */ }
  const next = waiting.shift();
  if (next) takeReader().then(next);
}

// psm '11' looks for words anywhere (most title cards); '6' reads the picture as one block of text,
// which suits big lettering that fills the screen.
async function readText(png, psm) {
  psm = psm || '11';
  const r = await takeReader();
  let timer;
  try {
    const w = await r.worker;
    if (psm !== r.psm) { await w.setParameters({ tessedit_pageseg_mode: psm }); r.psm = psm; }
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The text reader stopped responding')), 20000); });
    const { data } = await Promise.race([w.recognize(png), timeout]);
    clearTimeout(timer);
    giveBack(r);
    return String(data.text || '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    clearTimeout(timer);
    await stopReader(r); // a fresh one next time
    throw e;
  }
}
// Several pictures read side by side; the texts come back in the same order.
function readMany(pngs, psm) { return Promise.all(pngs.map((img) => readText(img, psm))); }

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

// Every part's thumbnails are made at once (each on its own core), so the later parts are
// usually ready by the time the first part's cards have been read.
function prepareStills(file, secs) {
  const all = windowsFor(secs).map((w) => stills(file, w.from, w.len));
  all.forEach((pr) => pr.catch(() => {})); // a part never reached (stopped) mustn't complain
  return all;
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
  let parts = wins.length; // fewer when the first card names an episode that fills the video
  // How far along this video is, 0..1 (each cartoon's part is an equal share).
  const report = (part, frac) => { if (opts.onProgress) opts.onProgress(Math.min(1, (part + frac) / wins.length)); };
  const allStills = prepareStills(file, secs);
  // One still moment, read for part i. likely: one of the few likeliest (or straight after a black moment),
  // which get every version of the picture; the rest only the quick ones. strict: the title must also be
  // named by one reading on its own (not only by many noisy readings pooled). → the match, or null.
  const readFrame = async (run, i, likely, strict) => {
    frames++;
    const read = [];
    const imgs = await frameVariants(file, run.t, likely);
    if (opts.onPeek && imgs.preview) opts.onPeek({ part: i, t: run.t, image: imgs.preview });
    let hit = null;
    // All versions are read side by side, then judged in order, so the answer is the same as
    // reading them one at a time (a few extra readings at most).
    const tryImgs = async (list, psm) => {
      for (const text of await readMany(list, psm)) {
        if (text.replace(/[^A-Za-z]/g, '').length >= 3) read.push(text.slice(0, 300));
        if (opts.isMatch && read.length && (hit = opts.isMatch(read, i))) return;
      }
    };
    await tryImgs(imgs);
    // The cleaned lettering read as one block of text too: reading for scattered words splits big ones apart.
    if (!hit && likely && imgs.lettering) await tryImgs([imgs.lettering], '6');
    // Small lettering: the likeliest frames also get a look at full size.
    if (!hit && likely) await tryImgs(await frameVariants(file, run.t, false, 960));
    // Cards often fade in: near the end of the still moment the lettering is at its clearest.
    if (!hit && likely && run.secs >= 1.5) await tryImgs(await frameVariants(file, run.start + run.secs - 0.4, true));
    if (hit && strict && !read.some((x) => { const m = opts.isMatch([x], i); return m && (!hit.entry || m.entry === hit.entry); })) hit = null;
    if (read.length) texts.push({ part: i, t: Math.round(run.t * 10) / 10, start: Math.round(run.start * 10) / 10, secs: run.secs, texts: read });
    if (opts.onFrame) opts.onFrame();
    if (hit && opts.onFound) opts.onFound({ part: i, t: run.t, hit });
    return hit;
  };
  for (let i = 0; i < wins.length; i++) {
    if (opts.cancelled && opts.cancelled()) break;
    report(i, 0.02);
    const runs = await allStills[i];
    report(i, 0.2);
    // Most likely spots first; at most 30 still moments per cartoon.
    const tryRuns = rankRuns(runs, wins[i].likely).slice(0, i ? 45 : 30);
    let k = 0, found = false, foundHit = null;
    // Title cards come straight after a black fade, often fading in: besides the still moments, look
    // a moment after the black fades nearest to where a card is expected.
    const probeBlacks = fadeOrder(runs.blacks, wins[i].likely).slice(0, 2);
    const probes = [].concat(...probeBlacks.map((b) => [0.8, 1.6].map((d) => ({ t: b.b + d, start: b.b, secs: 0, probe: true, rightAfterBlack: true }))));
    if (tryRuns.length > 4) tryRuns.splice(4, 0, ...probes); else tryRuns.push(...probes);
    for (const run of tryRuns) {
      if (opts.cancelled && opts.cancelled()) break;
      report(i, 0.2 + 0.8 * (k++ / tryRuns.length));
      // The likeliest few frames (and any straight after a black moment) get every version of the picture.
      const hit = await readFrame(run, i, k <= 4 || run.rightAfterBlack);
      if (hit) { found = true; foundHit = hit; break; } // found this cartoon's card
    }
    // The second cartoon's card isn't where it usually is: a long first cartoon, or a show segment before it
    // (Patchy the Pirate's), pushes it later. Look further on, at the moments straight after a fade to black.
    // (Only in a half-hour holding two cartoons, and a title found there must be read clearly on its own.)
    if (!found && i === 1 && wins.length === 2 && !(opts.cancelled && opts.cancelled())) {
      const from = wins[i].from + wins[i].len, len = Math.min(360, (secs || 1320) - 40 - from);
      const later = len >= 30 ? await stills(file, from, len).catch(() => null) : null;
      if (later) {
        const cands = rankRuns(later, from).filter((r) => r.rightAfterBlack).slice(0, 6);
        fadeOrder(later.blacks, from).filter((b) => b.b - b.a >= 0.8).slice(0, 3)
          .forEach((b) => cands.push({ t: b.b + 1, start: b.b, secs: 0, probe: true, rightAfterBlack: true }));
        for (const run of cands) {
          if (opts.cancelled && opts.cancelled()) break;
          const hit = await readFrame(run, i, true, true);
          if (hit) { found = true; foundHit = hit; break; }
        }
      }
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
              if (opts.cancelled && opts.cancelled()) break deep;
              for (const text of await readMany(imgs, psm)) {
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
          if (hit) { found = true; foundHit = hit; if (opts.onFound) opts.onFound({ part: i, t: tt, hit }); break deep; }
        }
      }
    }
    // No card read for a later cartoon: is one starting here at all? A new cartoon shows its
    // credits ("storyboard directors", "written by") a few seconds after a black moment; one long
    // episode doesn't. Shelf notes what it sees so the file isn't wrongly called one episode.
    // The card names an episode as long as the whole video (a double-length special): there's no second
    // cartoon to look for, so stop here. (Before, Shelf searched the rest of the video for one, which was
    // slow and could turn up a false second episode.)
    if (found && opts.fillsVideo && opts.fillsVideo(foundHit)) { parts = i + 1; break; }
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
  return { texts, frames, parts };
}

module.exports = { scanFile, stopOcr, stopOcrSoon, readersRunning: () => readers.length, windowsFor, readText, readMany, ffmpegPath, stills, frameVariants, letteringLayers, levelled, OCR_READERS };
