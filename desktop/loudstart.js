/*
 * Shelf desktop — a loud start, turned down (the Nickelodeon logo before a SpongeBob episode, say).
 *
 * measure(): how loud the first seconds of a video are next to the episode itself. A short burst near the start that
 * ends in silence and is clearly louder than the episode is "a loud start": its place and how much to turn it down.
 * apply(): a copy of the video with only that stretch of sound turned down. The picture, subtitles and everything else
 * are copied as they are; the sound is re-encoded once (the same kind and about the same quality as before).
 * The copy is checked (its length must match) before it's used. The original is never changed here.
 */
'use strict';

const { spawn } = require('child_process');

const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const ffmpegPath = () => unpacked(require('ffmpeg-static'));

function ffmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin'].concat(args), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Took too long')); }, timeoutMs || 600000);
    child.stderr.on('data', (d) => { err += d; if (err.length > 8e6) err = err.slice(-4e6); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(err) : reject(new Error(err.split('\n').filter(Boolean).pop() || 'ffmpeg failed')); });
  });
}

// What to look for. A start this much louder than the episode (in LU, as loudness meters count) is turned down…
const LOUDER_BY = 5;
// …to this much above the episode's own level (a logo a touch louder than the show still sounds like a logo).
const LEAVE_ABOVE = 1;
const LOOK_SECS = 30; // the first half minute
const START_WITHIN = 12; // the burst starts in the first 12 seconds
const MAX_LEN = 15; // and lasts at most 15 (longer is the episode itself)

/** The loudness meter's readings, every 0.1 s: [{ t, m }] (m: momentary loudness, LUFS, over the 0.4 s up to t). */
function readings(log) {
  const out = [];
  // (Digital silence reads "nan" or "-inf": as quiet as it gets.)
  for (const m of log.matchAll(/\bt:\s*([\d.]+)\s+TARGET:[^M]*M:\s*(-?[\d.]+|-?inf|nan)/g)) out.push({ t: +m[1], m: /inf|nan/.test(m[2]) ? -120 : +m[2] });
  return out;
}
const integrated = (log) => { const m = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+)\s*LUFS/.exec(log); return m ? +m[1] : null; };
// The average loudness of a stretch (by energy, as the meter adds them up).
const meanLufs = (ms) => 10 * Math.log10(ms.reduce((s, m) => s + Math.pow(10, m / 10), 0) / Math.max(1, ms.length));

/**
 * Pure: from the first seconds' readings and the episode's own loudness, the loud start, or null.
 * → { start, end, loud, body, gain } (seconds; LUFS; gain in dB, negative).
 */
function findLoudStart(rs, body) {
  if (!rs.length || body == null || !isFinite(body)) return null;
  const quiet = (r) => r.m < Math.min(-40, body - 15);
  const first = rs.findIndex((r) => !quiet(r));
  if (first < 0 || rs[first].t > START_WITHIN + 0.4) return null;
  // Until the first moment of quiet (three readings in a row: 0.3 s).
  let last = -1;
  for (let k = first; k < rs.length; k++) {
    if (quiet(rs[k]) && rs[k + 1] && quiet(rs[k + 1]) && rs[k + 2] && quiet(rs[k + 2])) { last = k - 1; break; }
  }
  if (last < first) return null; // no quiet after it: the sound just carries on
  const start = Math.max(0, rs[first].t - 0.4), end = rs[last].t + 0.1;
  if (end - start < 0.8 || end - start > MAX_LEN) return null;
  const loud = meanLufs(rs.slice(first, last + 1).map((r) => r.m));
  if (loud - body < LOUDER_BY) return null;
  const gain = -Math.min(18, Math.round((loud - body - LEAVE_ABOVE) * 2) / 2);
  return { start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, loud: Math.round(loud * 10) / 10, body: Math.round(body * 10) / 10, gain };
}

/** Measure a video on this computer: its loud start, or null. secs: its length (to know where the episode is). */
async function measure(file, secs) {
  const d = secs || 0;
  if (d && d < 120) return null; // a clip, not an episode
  // The episode's own loudness: a few minutes from a little way in (past any opening).
  const from = d ? Math.min(120, d * 0.15) : 90, len = d ? Math.min(240, Math.max(60, d - from - 30)) : 240;
  const [head, bodyLog] = await Promise.all([
    ffmpeg(['-loglevel', 'info', '-t', String(LOOK_SECS), '-i', file, '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-'], 120000),
    ffmpeg(['-loglevel', 'info', '-ss', String(from), '-t', String(len), '-i', file, '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-'], 240000)
  ]);
  return findLoudStart(readings(head), integrated(bodyLog));
}

// The sound tracks' kind and quality: each track read once without decoding it (a second or two), so its real
// size gives its bit rate (Matroska files don't state one).
async function audioOf(file) {
  const log = await ffmpeg(['-loglevel', 'info', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'null', '-'], 300000);
  const codecs = [...log.matchAll(/Stream #0:\d+[^\n]*?: Audio: (\w+)/g)].map((m) => m[1]);
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(log), secs = dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0;
  const size = /audio:\s*([\d.]+)\s*(k|M)i?B/i.exec(log), bytes = size ? +size[1] * (size[2].toLowerCase() === 'm' ? 1048576 : 1024) : 0;
  const tracks = Math.max(1, codecs.length / 2 | 0 || codecs.length); // (input and output streams are both listed)
  return { codec: codecs[0] || 'aac', kbps: secs && bytes ? Math.round(bytes * 8 / secs / 1000 / tracks) : 0 };
}
// The same kind of sound again, at a little over its bit rate (a second encoding at the same rate loses a touch),
// never below what sounds clean.
const ENCODERS = { aac: 'aac', ac3: 'ac3', eac3: 'eac3', mp3: 'libmp3lame', opus: 'libopus', vorbis: 'libvorbis', flac: 'flac' };
function encoderArgs(a) {
  const enc = ENCODERS[a.codec] || 'aac';
  if (enc === 'flac') return ['-c:a', 'flac'];
  const floor = { aac: 96, ac3: 192, eac3: 128, libmp3lame: 128, libopus: 64, libvorbis: 96 }[enc] || 128;
  return ['-c:a', enc, '-b:a', Math.max(floor, Math.min(640, Math.round((a.kbps || 128) * 1.2))) + 'k'];
}

function checkCut(cut) {
  const c = cut || {};
  if (!(c.start >= 0 && c.end > c.start && c.end <= LOOK_SECS + 1 && c.end - c.start <= MAX_LEN + 1 && c.gain < 0 && c.gain >= -24)) throw new Error('Bad loud start');
  return { start: +c.start, end: +c.end, gain: +c.gain };
}
// The silent lead-in an encoder puts before the sound (AAC: 1024 samples, 21 ms). MP4 files say so and players skip
// it; Matroska files don't, so the sound would play that much behind the picture: as much is taken off the start.
const LEAD_IN = { aac: 1024 };
/** The sound filter: cut.start–cut.end turned down by cut.gain dB (the pitch and timing stay exactly as they were). */
function filterOf(c, a, to) {
  const on = ':enable=\'between(t,' + c.start + ',' + c.end + ')\'';
  return leadIn(a, to).concat(['volume=volume=' + c.gain + 'dB' + on]).join(',');
}
// The filters that take the encoder's lead-in off the start (Matroska only; see LEAD_IN).
function leadIn(a, to) {
  const pad = /\.(mkv|mka|webm)$/i.test(to) ? LEAD_IN[ENCODERS[a.codec] || 'aac'] || 0 : 0;
  return pad ? ['atrim=start_sample=' + pad, 'asetpts=PTS-STARTPTS'] : [];
}
/**
 * ffmpeg's arguments to copy `from` to `to` with only cut.start–cut.end of its sound turned down by cut.gain dB
 * (the picture and everything else copied as they are: see audiotracks.js buildArgs, which both copies share).
 */
function applyArgs(from, to, cut, a, info) {
  return require('./audiotracks').buildArgs(from, to, info || { tracks: [], pics: [], attachments: 0 }, null, { cut: checkCut(cut), audio: a }, null);
}

/**
 * Write `to` (which must not exist): `from` with its loud start turned down, and with only these sound tracks if
 * `tracks` says so (see audiotracks.js). Checked before it counts.
 */
async function apply(from, to, cut, tracks) {
  const T = require('./audiotracks');
  const a = await audioOf(from);
  const plan = tracks ? T.checkPlan(tracks, (await T.list(from)).tracks.length) : null;
  await T.remake(from, to, plan, { cut: checkCut(cut), audio: a });
}

module.exports = { measure, apply, findLoudStart, readings, integrated, applyArgs, checkCut, encoderArgs, filterOf, leadIn };
