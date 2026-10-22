/*
 * Shelf desktop — split one video into one file per cartoon, without re-encoding.
 *
 * Where to cut: each cartoon's title card was found earlier (its time is the hint). Just before
 * it there's almost always a moment of black and/or silence between cartoons; Shelf cuts there.
 * A lossless cut can only start a file on a keyframe, so Shelf picks the keyframe closest to
 * that gap (encoders usually put one right where the new picture starts).
 *
 * Every piece is checked (its length must be what was asked for) before it counts as done.
 * The original file is never changed or deleted.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const probe = require('./probe');

const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const ffmpegPath = () => unpacked(require('ffmpeg-static'));

function ffmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin'].concat(args), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Took too long')); }, timeoutMs || 600000);
    child.stderr.on('data', (d) => { err += d; if (err.length > 4e6) err = err.slice(-2e6); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(err) : reject(new Error(err.split('\n').filter(Boolean).pop() || 'ffmpeg failed')); });
  });
}

/** Black stretches, silent stretches and keyframes between `from` and `to` seconds (absolute times). */
async function quietAndKeys(file, from, to) {
  const len = Math.max(1, to - from);
  const out = await ffmpeg(['-loglevel', 'info', '-copyts', '-ss', String(Math.max(0, from)), '-t', String(len), '-i', file,
    '-vf', 'blackdetect=d=0.06:pix_th=0.12', '-af', 'silencedetect=noise=-38dB:d=0.2', '-sn', '-dn', '-f', 'null', '-'], 300000);
  const black = [], silence = [];
  for (const m of out.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) black.push({ a: +m[1], b: +m[2] });
  let sStart = null;
  for (const line of out.split('\n')) {
    let m = line.match(/silence_start:\s*([\d.]+)/); if (m) sStart = +m[1];
    m = line.match(/silence_end:\s*([\d.]+)/); if (m && sStart != null) { silence.push({ a: sStart, b: +m[1] }); sStart = null; }
  }
  const keyOut = await ffmpeg(['-loglevel', 'info', '-copyts', '-skip_frame', 'nokey', '-ss', String(Math.max(0, from)), '-t', String(len), '-i', file,
    '-an', '-sn', '-dn', '-vf', 'showinfo', '-f', 'null', '-'], 300000);
  const keys = [];
  for (const m of keyOut.matchAll(/pts_time:([\d.]+)/g)) keys.push(+m[1]);
  return { black, silence, keys: keys.sort((x, y) => x - y) };
}

/**
 * Where to cut before a cartoon whose title card shows at `cardT`.
 * Returns { at (seconds, on a keyframe), gapAt, why, off (seconds between keyframe and gap) }.
 */
async function cutBefore(file, cardT) {
  const from = Math.max(0, cardT - 50), to = cardT + 2;
  const q = await quietAndKeys(file, from, to);
  // The gap: black (best), else silence, closest before the card.
  const before = (list) => list.filter((g) => g.a <= cardT + 0.5).sort((x, y) => (cardT - x.b) - (cardT - y.b))[0];
  const blk = before(q.black), sil = before(q.silence);
  let gap = null, why = 'title card';
  if (blk && sil && Math.abs(blk.a - sil.a) < 3) { gap = { a: Math.min(blk.a, sil.a), b: Math.max(blk.b, sil.b) }; why = 'black + silence'; }
  else if (blk) { gap = blk; why = 'black'; }
  else if (sil) { gap = sil; why = 'silence'; }
  const target = gap ? gap.b : cardT - 0.5;
  // A keyframe inside the gap (or right at its end) is perfect; otherwise the nearest one before.
  const inGap = gap && q.keys.filter((k) => k >= gap.a - 0.05 && k <= gap.b + 0.7);
  let at = inGap && inGap.length ? inGap[inGap.length - 1] : null;
  if (at == null) {
    const prior = q.keys.filter((k) => k <= target + 0.05);
    at = prior.length ? prior[prior.length - 1] : (q.keys[0] != null ? q.keys[0] : target);
  }
  return { at: Math.round(at * 1000) / 1000, gapAt: Math.round(target * 100) / 100, why, off: Math.round(Math.abs(at - target) * 10) / 10 };
}

/** No title card to go by: the quiet moment nearest an estimated time (from episode lengths). */
async function cutNear(file, est) {
  const q = await quietAndKeys(file, Math.max(0, est - 75), est + 75);
  const gaps = q.black.map((g) => Object.assign({ kind: 'black' }, g)).concat(q.silence.map((g) => Object.assign({ kind: 'silence' }, g)));
  gaps.sort((x, y) => Math.abs((x.a + x.b) / 2 - est) - Math.abs((y.a + y.b) / 2 - est));
  const gap = gaps[0] || null;
  const target = gap ? gap.b : est;
  const near = q.keys.slice().sort((x, y) => Math.abs(x - target) - Math.abs(y - target))[0];
  const at = near != null ? near : target;
  return { at: Math.round(at * 1000) / 1000, gapAt: Math.round(target * 100) / 100, why: gap ? gap.kind : 'estimate', off: Math.round(Math.abs(at - target) * 10) / 10 };
}

/**
 * Work out all the cuts for one video.
 * cardTimes: when each cartoon's title card shows, in order (first may be null: starts at 0).
 * Returns [{ start, end }] covering the whole video, plus details for each cut.
 */
async function planCuts(file, cardTimes) {
  const secs = await probe.duration(file);
  if (!secs) throw new Error('Couldn’t read how long this video is');
  const cuts = [];
  for (let i = 1; i < cardTimes.length; i++) {
    if (cardTimes[i] == null) throw new Error('A title card is missing, so Shelf can’t tell where to cut');
    cuts.push(await cutBefore(file, cardTimes[i]));
  }
  const points = [0].concat(cuts.map((c) => c.at), [secs]);
  for (let i = 1; i < points.length; i++) {
    if (points[i] - points[i - 1] < 60) throw new Error('A piece would be under a minute long, so Shelf didn’t cut');
  }
  return { secs, cuts, pieces: points.slice(1).map((end, i) => ({ start: points[i], end })) };
}

/** Copy one piece of `file` (from start to end seconds) into `dest`, losslessly. */
// ffmpeg's name for each container (the piece keeps the original's).
const FORMAT = { mkv: 'matroska', mp4: 'mp4', m4v: 'mp4', mov: 'mov', avi: 'avi', ts: 'mpegts', m2ts: 'mpegts', webm: 'webm', mpg: 'mpeg', mpeg: 'mpeg', wmv: 'asf' };

async function writePiece(file, start, end, dest) {
  // ffmpeg's segment mode cuts a copied stream exactly at keyframes. (Simply trimming with -ss/-t
  // can drop the keyframe at the cut, because frames are stored in a slightly different order
  // than they're shown; the piece would then start seconds late and lose its title card.)
  const ext = path.extname(dest).slice(1).toLowerCase();
  const fmt = FORMAT[ext] || ext;
  const secs = await probe.duration(file);
  const times = [];
  if (start > 0.05) times.push(start);
  if (!secs || end < secs - 0.05) times.push(end);
  const want = start > 0.05 ? 1 : 0; // which segment is this piece
  const pattern = dest + '.part%d.' + ext;
  const made = (k) => dest + '.part' + k + '.' + ext;
  const args = ['-loglevel', 'error', '-y', '-i', file,
    '-map', '0:v?', '-map', '0:a?', '-map', '0:s?'].concat(fmt === 'matroska' ? ['-map', '0:t?'] : [], [
    '-c', 'copy', '-map_metadata', '0', '-map_chapters', '-1',
    '-f', 'segment', '-segment_format', fmt, '-reset_timestamps', '1']);
  // A hair early (less than a frame): a keyframe at 660.667 may be stored as 660.6669, and the
  // segment mode would then skip to the next keyframe.
  if (times.length) args.push('-segment_times', times.map((t) => Math.max(0, t - 0.02).toFixed(3)).join(','));
  args.push(pattern);
  try {
    await ffmpeg(args, 900000);
    await fsp.rename(made(want), dest);
  } finally {
    for (let k = 0; k < 4; k++) if (k !== want || !(await fsp.stat(dest).catch(() => null))) await fsp.unlink(made(k)).catch(() => {});
  }
  const got = await probe.duration(dest);
  const len = end - start;
  if (!got || Math.abs(got - len) > Math.max(3, len * 0.02)) {
    await fsp.unlink(dest).catch(() => {});
    throw new Error('A piece came out the wrong length (' + Math.round(got || 0) + ' s instead of ' + Math.round(len) + ' s), so it was removed');
  }
  return got;
}

/**
 * Several pieces of `input` in one pass, into `dir` (for a video on your server, `input` is its address on the
 * reader in remoteread.js, so it crosses the network once). secs: its length. pieces: [{ start, end }].
 * Returns the files, in the pieces' order. Each is checked for length, as in writePiece.
 */
async function writePieces(input, secs, pieces, dir, ext) {
  const fmt = FORMAT[ext] || ext;
  const bounds = [];
  pieces.forEach((p) => { if (p.start > 0.05) bounds.push(p.start); if (!secs || p.end < secs - 0.05) bounds.push(p.end); });
  const times = [...new Set(bounds.map((t) => +t.toFixed(3)))].sort((a, b) => a - b);
  const args = ['-loglevel', 'error', '-y', '-i', input,
    '-map', '0:v?', '-map', '0:a?', '-map', '0:s?'].concat(fmt === 'matroska' ? ['-map', '0:t?'] : [], [
    '-c', 'copy', '-map_metadata', '0', '-map_chapters', '-1',
    '-f', 'segment', '-segment_format', fmt, '-reset_timestamps', '1']);
  if (times.length) args.push('-segment_times', times.map((t) => Math.max(0, t - 0.02).toFixed(3)).join(','));
  args.push(path.join(dir, 'part%d.' + ext));
  await ffmpeg(args, 3600000);
  const out = [];
  for (const p of pieces) {
    const file = path.join(dir, 'part' + times.filter((t) => t <= p.start + 0.01).length + '.' + ext);
    const got = await probe.duration(file);
    const len = p.end - p.start;
    if (!got || Math.abs(got - len) > Math.max(3, len * 0.02)) throw new Error('A piece came out the wrong length (' + Math.round(got || 0) + ' s instead of ' + Math.round(len) + ' s)');
    out.push(file);
  }
  return out;
}

module.exports = { planCuts, writePiece, writePieces, cutBefore, cutNear, quietAndKeys };
