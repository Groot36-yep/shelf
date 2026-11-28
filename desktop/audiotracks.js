/*
 * Shelf desktop — a video's sound tracks: which there are (English, Hindi…), which plays first, and a copy that keeps
 * only the ones you want, plays the one you want first, or has another language added from another file.
 *
 * list(): the tracks, from ffmpeg's description of the file (nothing is decoded).
 * apply(): a new copy. Nothing is re-encoded: the picture, the sound tracks kept, subtitles and chapters are copied
 *   as they are, so it's quick and loses nothing. The copy is checked (its length and its tracks) before it counts.
 * align(): where another file's sound lines up with this video's (the same episode from another release, in another
 *   language), by comparing how loud the two are moment by moment. Refused when they don't match (a different cut,
 *   or a European copy that plays about 4% faster).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { spawn } = require('child_process');
const probe = require('./probe');

const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const ffmpegPath = () => unpacked(require('ffmpeg-static'));

// ffmpeg, with what it printed. (Describing a file "fails" with no output named: that's expected.)
function ffmpeg(args, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin'].concat(args), { windowsHide: true, stdio: ['ignore', o.pcm ? 'pipe' : 'ignore', 'pipe'] });
    let err = '';
    const out = [];
    let outLen = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Took too long')); }, o.timeoutMs || 600000);
    if (o.pcm) child.stdout.on('data', (d) => { if (outLen < 64e6) { out.push(d); outLen += d.length; } });
    child.stderr.on('data', (d) => { err += d; if (err.length > 4e6) err = err.slice(-2e6); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || o.anyExit) resolve({ log: err, out: o.pcm ? Buffer.concat(out) : null });
      else reject(new Error(err.split('\n').filter(Boolean).pop() || 'ffmpeg failed'));
    });
  });
}

// ---- Languages ----
// The usual three-letter codes in video files, with their names (ISO 639-2; both B and T forms where they differ).
const LANGS = {
  eng: 'English', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German', ita: 'Italian', por: 'Portuguese',
  jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', hin: 'Hindi', tam: 'Tamil', tel: 'Telugu', rus: 'Russian',
  ara: 'Arabic', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish', nor: 'Norwegian', nob: 'Norwegian', dan: 'Danish', fin: 'Finnish',
  pol: 'Polish', tur: 'Turkish', gre: 'Greek', ell: 'Greek', heb: 'Hebrew', tha: 'Thai', vie: 'Vietnamese', ind: 'Indonesian',
  may: 'Malay', msa: 'Malay', cze: 'Czech', ces: 'Czech', hun: 'Hungarian', rum: 'Romanian', ron: 'Romanian', ukr: 'Ukrainian',
  fil: 'Filipino', tgl: 'Tagalog', ben: 'Bengali', urd: 'Urdu', per: 'Persian', fas: 'Persian', cat: 'Catalan'
};
// Two-letter codes some files use instead.
const TWO = { en: 'eng', es: 'spa', fr: 'fre', de: 'ger', it: 'ita', pt: 'por', ja: 'jpn', ko: 'kor', zh: 'chi', hi: 'hin', ta: 'tam', te: 'tel',
  ru: 'rus', ar: 'ara', nl: 'dut', sv: 'swe', no: 'nor', nb: 'nor', da: 'dan', fi: 'fin', pl: 'pol', tr: 'tur', el: 'gre', he: 'heb', th: 'tha',
  vi: 'vie', id: 'ind', ms: 'may', cs: 'cze', hu: 'hun', ro: 'rum', uk: 'ukr', bn: 'ben', ur: 'urd', fa: 'per', ca: 'cat' };
// One code per language (French is "fre" and "fra"), so two tracks in the same language count as one language.
const SAME = { fra: 'fre', deu: 'ger', zho: 'chi', nld: 'dut', nob: 'nor', ell: 'gre', msa: 'may', ces: 'cze', ron: 'rum', fas: 'per' };
function langCode(x) {
  let c = String(x || '').trim().toLowerCase();
  if (TWO[c]) c = TWO[c];
  if (!/^[a-z]{3}$/.test(c) || c === 'und' || c === 'unk' || c === 'mis' || c === 'zxx') return '';
  return SAME[c] || c;
}
function langName(code) { return LANGS[code] || (code ? code.toUpperCase() : 'Unknown language'); }
// A track's language from its title when its label is missing ("Hindi 5.1", "English (Original)").
function langFromTitle(title) {
  const t = String(title || '').toLowerCase();
  for (const [code, name] of Object.entries(LANGS)) if (new RegExp('\\b' + name.toLowerCase() + '\\b').test(t)) return SAME[code] || code;
  return '';
}

/**
 * Pure: what's in a file, from ffmpeg's description of it ("Stream #0:1(hin): Audio: aac (LC), 48000 Hz, stereo, fltp
 * (default)" and the lines under each stream). → {
 *   tracks: [{ n (0, 1… among the sound tracks), stream (its number in the file), lang, langName, title, codec, channels, def }],
 *   pics: [{ stream, filename, mimetype }] (cover pictures), attachments: how many other attachments (fonts…) }
 */
function parseFile(log) {
  const lines = String(log).split(/\r?\n/);
  const tracks = [], pics = [];
  let attachments = 0, cur = null;
  for (const line of lines) {
    const m = /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (\w+): (.*)$/.exec(line);
    if (m) {
      cur = null;
      const rest = m[4];
      if (m[3] === 'Audio') {
        const codec = (/^(\w+)/.exec(rest) || [])[1] || '';
        const ch = /\b(mono|stereo|2\.1|3\.0|4\.0|quad|5\.0|5\.1|6\.1|7\.1|\d+ channels)\b/.exec(rest);
        cur = { n: tracks.length, stream: +m[1], lang: langCode(m[2]), title: '', codec, channels: ch ? ch[1] : '', def: /\(default\)/.test(rest) };
        tracks.push(cur);
      } else if (m[3] === 'Video' && /\(attached pic\)/.test(rest)) {
        cur = { stream: +m[1], filename: '', mimetype: /png/.test(rest) ? 'image/png' : 'image/jpeg', pic: true };
        pics.push(cur);
      } else if (m[3] === 'Attachment') attachments++;
      continue;
    }
    const kv = /^\s{4,}(\w+)\s*:\s*(.*)$/.exec(line);
    if (cur && kv) {
      if (kv[1] === 'title' && !cur.pic) cur.title = kv[2].trim();
      if (kv[1] === 'filename' && cur.pic) cur.filename = kv[2].trim();
      if (kv[1] === 'mimetype' && cur.pic) cur.mimetype = kv[2].trim();
    } else if (cur && !/^\s{4,}/.test(line)) cur = null;
  }
  for (const t of tracks) {
    if (!t.lang) t.lang = langFromTitle(t.title);
    t.langName = langName(t.lang);
  }
  return { tracks, pics, attachments };
}
function parseTracks(log) { return parseFile(log).tracks; }

/** What's in a video (see parseFile), and how long it is. */
async function list(file) {
  const { log } = await ffmpeg(['-i', file], { anyExit: true, timeoutMs: 60000 });
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(log);
  return Object.assign(parseFile(log), { secs: dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : null });
}

// The track that plays first now: the one marked to (default), else the first.
function playsFirst(tracks) { const d = tracks.find((t) => t.def); return d ? d.n : tracks.length ? tracks[0].n : -1; }

/** Only a sane plan is ever used. plan: { keep: [n…], first: n | 'add', add: { file, n, offset, lang } | null }. */
function checkPlan(plan, count) {
  const p = plan || {};
  const keep = Array.isArray(p.keep) ? [...new Set(p.keep.map(Number))] : [];
  if (!keep.length && !p.add) throw new Error('Bad sound tracks');
  if (keep.some((n) => !Number.isInteger(n) || n < 0 || n >= Math.min(count, 64))) throw new Error('Bad sound tracks');
  let add = null;
  if (p.add) {
    const a = p.add;
    if (typeof a.file !== 'string' || !path.isAbsolute(a.file) || !Number.isInteger(a.n) || a.n < 0 || a.n > 63 || !(Math.abs(+a.offset) < 600)) throw new Error('Bad sound tracks');
    add = { file: a.file, n: a.n, offset: Math.round(+a.offset * 1000) / 1000, lang: langCode(a.lang) };
  }
  const first = p.first === 'add' && add ? 'add' : Number(p.first);
  if (first !== 'add' && !keep.includes(first)) throw new Error('Bad sound tracks');
  return { keep, first, add };
}

const MATROSKA = /\.(mkv|mka|webm)$/i;
/**
 * Pure: ffmpeg's arguments to copy `from` to `to`.
 *   info: what's in `from` (see list). plan: which sound tracks, in which order (null: all, as they are; see checkPlan).
 *   quiet: { cut, audio } to turn a loud start down (desktop/loudstart.js), which re-encodes the sound; else nothing is.
 *   covers: [{ file, filename, mimetype }] cover pictures saved beside (Matroska only: see coversOf).
 * The picture, subtitles, chapters, fonts and the file's details are copied as they are. With a plan, the first sound
 * track is the one that plays first: first in the file, and the only one marked default (what Plex and players go by).
 */
function buildArgs(from, to, info, plan, quiet, covers) {
  const mkv = MATROSKA.test(to);
  const ins = ['-i', from];
  if (plan && plan.add) ins.push('-i', plan.add.file);
  const order = plan ? [plan.first].concat(plan.keep.filter((n) => n !== plan.first), plan.add && plan.first !== 'add' ? ['add'] : []) : null;
  // (A Matroska cover picture would come out as a second video track: it's put back as an attachment instead.)
  const maps = ['-map', mkv ? '0:V?' : '0:v?'];
  if (order) for (const x of order) maps.push('-map', x === 'add' ? '1:a:' + plan.add.n : '0:a:' + x);
  else maps.push('-map', '0:a?');
  maps.push('-map', '0:s?', '-map', '0:t?');
  const extra = [];
  if (order) {
    order.forEach((x, i) => extra.push('-disposition:a:' + i, i === 0 ? 'default' : '0'));
    const ai = order.indexOf('add');
    if (ai >= 0 && plan.add.lang) extra.push('-metadata:s:a:' + ai, 'language=' + plan.add.lang, '-metadata:s:a:' + ai, 'title=' + langName(plan.add.lang));
  }
  (mkv ? covers || [] : []).forEach((c, k) => {
    const at = (info.attachments || 0) + k;
    extra.push('-attach', c.file, '-metadata:s:t:' + at, 'mimetype=' + c.mimetype, '-metadata:s:t:' + at, 'filename=' + c.filename);
  });
  // Everything is copied as it is, except: an added track, moved to line up (it's re-encoded once, as moving a copied
  // track moves the whole file's timeline with it), and every track when a loud start is turned down.
  const codec = ['-c', 'copy'];
  const L = require('./loudstart');
  const cut = quiet ? L.checkCut(quiet.cut) : null;
  const per = (args, i) => args.map((x) => (x === '-c:a' || x === '-b:a' ? x + ':' + i : x));
  // (Only the loud start, no tracks changed: every sound track the same way, as loudstart.js always did.)
  if (!order && cut) codec.push.apply(codec, L.encoderArgs(quiet.audio).concat(['-af', L.filterOf(cut, quiet.audio, to)]));
  (order || []).forEach((x, i) => {
    const added = x === 'add';
    if (!added && !cut) return;
    const a = added ? { codec: (info.addTrack && info.addTrack.codec) || 'aac', kbps: info.addTrack && /5\.1|6\.1|7\.1/.test(info.addTrack.channels) ? 320 : 160 } : quiet.audio;
    const f = [];
    if (added) {
      const off = plan.add.offset;
      if (off < 0) f.push('atrim=start=' + (-off), 'asetpts=PTS-STARTPTS');
      else if (off > 0) f.push('adelay=' + Math.round(off * 1000) + ':all=1');
    }
    f.push(cut ? L.filterOf(cut, a, to) : L.leadIn(a, to).join(','));
    codec.push.apply(codec, per(L.encoderArgs(a), i).concat(['-filter:a:' + i, f.filter(Boolean).join(',') || 'anull']));
  });
  return ['-loglevel', 'error'].concat(ins, maps, codec, extra, ['-map_metadata', '0', '-map_chapters', '0', '-n', to]);
}
function applyArgs(from, to, plan, info) { return buildArgs(from, to, info || { tracks: [], pics: [], attachments: 0 }, plan, null, null); }

// A Matroska file's cover pictures, saved in `dir` (so the copy can have them as attachments again).
async function coversOf(from, info, dir) {
  const out = [];
  for (const [k, p] of info.pics.entries()) {
    const ext = /png/.test(p.mimetype) ? '.png' : '.jpg';
    const file = path.join(dir, 'cover-' + k + ext);
    await ffmpeg(['-loglevel', 'error', '-i', from, '-map', '0:' + p.stream, '-c', 'copy', '-frames:v', '1', '-f', 'image2', file], { timeoutMs: 60000 });
    out.push({ file, filename: p.filename || 'cover' + (k ? '-' + k : '') + ext, mimetype: p.mimetype });
  }
  return out;
}

/**
 * Write `to` (which must not exist): `from` with these sound tracks (plan) and/or its loud start turned down (quiet).
 * Checked (length, sound tracks) before it counts; never over a file that's there.
 */
async function remake(from, to, plan, quiet) {
  const info = await list(from);
  if (plan && plan.add) info.addTrack = (await list(plan.add.file)).tracks[plan.add.n] || null;
  const count = plan ? plan.keep.length + (plan.add ? 1 : 0) : info.tracks.length;
  const ext = path.extname(to);
  const tag = crypto.randomBytes(4).toString('hex');
  const tmp = path.join(path.dirname(to), '.shelf-remake-' + tag + ext);
  let coverDir = null;
  try {
    let covers = [];
    if (MATROSKA.test(to) && info.pics.length) {
      coverDir = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'shelf-covers-'));
      covers = await coversOf(from, info, coverDir).catch(() => []); // (a cover that can't be saved is left out)
    }
    await ffmpeg(buildArgs(from, tmp, info, plan, quiet, covers), { timeoutMs: 1800000 });
    const [want, got] = await Promise.all([probe.duration(from).catch(() => null), list(tmp)]);
    if (want && !(got.secs && Math.abs(got.secs - want) <= 1.5)) throw new Error('The new copy came out the wrong length');
    if (got.tracks.length !== count) throw new Error('The new copy doesn’t have the sound tracks it should');
    try { await fsp.link(tmp, to); } catch (e) {
      if (e.code === 'EEXIST') throw e;
      if (await fsp.stat(to).then(() => true, () => false)) { const x = new Error('A file with this name already exists'); x.code = 'EEXIST'; throw x; }
      await fsp.rename(tmp, to);
    }
  } finally {
    await fsp.unlink(tmp).catch(() => {});
    if (coverDir) await fsp.rm(coverDir, { recursive: true, force: true }).catch(() => {});
  }
}
/** `from` → `to` with only these sound tracks (see checkPlan). Nothing is re-encoded. */
async function apply(from, to, plan0) {
  const info = await list(from);
  const plan = checkPlan(plan0, info.tracks.length);
  await remake(from, to, plan, null);
  return plan;
}

// ---- Lining up another file's sound ----
const RATE = 8000, HOP = 80; // 8 kHz, a loudness reading every 10 ms
// The sound of a stretch, as 8 kHz mono samples.
async function pcm(file, from, secs, track) {
  const { out } = await ffmpeg(['-loglevel', 'error', '-ss', String(Math.max(0, from)), '-t', String(secs), '-i', file,
    '-map', '0:a:' + (track || 0), '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { pcm: true, timeoutMs: 120000 });
  return new Float32Array(out.buffer, out.byteOffset, Math.floor(out.length / 4));
}
// How loud each 10 ms is (log), with the average taken off: what's compared, so the languages needn't match.
function envelope(x) {
  const n = Math.floor(x.length / HOP), e = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * HOP; k < (i + 1) * HOP; k++) s += x[k] * x[k]; e[i] = Math.log10(s / HOP + 1e-9); }
  let m = 0; for (let i = 0; i < n; i++) m += e[i]; m /= n || 1;
  for (let i = 0; i < n; i++) e[i] -= m;
  return e;
}
/**
 * Pure: where `b` lines up with `a` (a's moment i matches b's moment i − lag, in readings), and how well (−1…1).
 * lo…hi: the lags to try.
 */
function bestLag(a, b, lo, hi) {
  let best = -Infinity, at = 0;
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i - lag;
      if (j < 0 || j >= b.length) continue;
      s += a[i] * b[j]; na += a[i] * a[i]; nb += b[j] * b[j];
    }
    const r = na && nb ? s / Math.sqrt(na * nb) : 0;
    if (r > best) { best = r; at = lag; }
  }
  return { lag: at, score: best };
}
// About 4% apart: a European (PAL) copy plays 25 frames a second instead of 23.976.
const PAL = 25 / 23.976;

/**
 * Where `other`'s sound lines up with `video`'s: → { ok, offset (seconds to move other's sound later by), score, why }.
 * Two places are compared (a quarter and two thirds of the way in); they must agree, or it's a different cut.
 */
async function align(video, other, otherTrack) {
  const [a, b] = await Promise.all([list(video), list(other)]);
  if (!b.tracks.length) return { ok: false, why: 'That file has no sound track.' };
  const sa = a.secs, sb = b.secs;
  if (!sa || !sb) return { ok: false, why: 'Couldn’t tell how long the videos are.' };
  const ratio = sb / sa;
  if (Math.abs(ratio - 1 / PAL) < 0.012 || Math.abs(ratio - PAL) < 0.012) {
    return { ok: false, pal: true, why: 'That copy plays about 4% ' + (ratio < 1 ? 'faster' : 'slower') + ' (a European copy, made for 25 frames a second), so its sound would drift away from the picture.' };
  }
  if (Math.abs(sb - sa) > Math.max(60, sa * 0.06)) return { ok: false, why: 'That video is ' + Math.round(Math.abs(sb - sa) / 60) + ' minutes ' + (sb > sa ? 'longer' : 'shorter') + ': it doesn’t look like the same episode or the same cut.' };
  const WIN = Math.min(60, sa / 6), REACH = Math.min(30, Math.max(8, Math.abs(sb - sa) + 8));
  const spots = [0.25, 0.66].map((f) => Math.max(0, sa * f));
  const offs = [];
  for (const t of spots) {
    const [x, y] = await Promise.all([pcm(video, t, WIN), pcm(other, Math.max(0, t - REACH), WIN + 2 * REACH, otherTrack)]);
    const ea = envelope(x), eb = envelope(y), h = HOP / RATE;
    // The video's moment t + i·h is the other's startB + (i − lag)·h, so the other's sound must move later by
    // (t − startB) + lag·h: up to REACH seconds either way. (To 10 ms: well inside what anyone can see.)
    const startB = Math.max(0, t - REACH), lead = t - startB;
    const c = bestLag(ea, eb, Math.round((-REACH - lead) / h), Math.round((REACH - lead) / h));
    offs.push({ offset: lead + c.lag * h, score: c.score });
  }
  const score = Math.min(offs[0].score, offs[1].score);
  if (score < 0.25) return { ok: false, why: 'Its sound doesn’t match this video’s: is it the same episode?', score };
  if (Math.abs(offs[0].offset - offs[1].offset) > 0.08) return { ok: false, why: 'Its sound lines up in one place but not another: it looks like a different cut (scenes added or taken out).', score };
  const offset = Math.round((offs[0].offset + offs[1].offset) / 2 * 1000) / 1000;
  return { ok: true, offset, score: Math.round(score * 100) / 100 };
}

module.exports = { list, apply, remake, align, parseFile, parseTracks, checkPlan, buildArgs, applyArgs, playsFirst, langCode, langName, bestLag, envelope, LANGS };
