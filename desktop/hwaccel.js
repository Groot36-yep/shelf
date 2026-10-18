/*
 * Shelf desktop — decoding video on the graphics card, for the title-card scan's thumbnails.
 *
 * Measured on real files: light video (H.264 up to 1080p, like most TV rips) decodes faster on the
 * processor, because handing every frame back from the graphics card costs more than it saves.
 * Heavy video (HEVC / x265, AV1, VP9, or bigger than 1080p) decodes 1.5–2× faster on the card.
 * So "Auto" (the default) uses the card only for heavy video. Frames are dropped to two a second
 * and (on NVIDIA) shrunk while still on the card, so only tiny pictures come back.
 *
 * Whatever goes wrong on the card, the processor takes over: the scan never fails because of it.
 */
'use strict';

const { spawn } = require('child_process');

const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const ffmpegPath = () => unpacked(require('ffmpeg-static'));

const MODES = ['auto', 'on', 'off'];
let mode = 'auto';
// Ways to use the card, best first: NVIDIA's own (CUDA), then Windows' (Direct3D 11: AMD, Intel, NVIDIA).
const ORDER = ['cuda', 'd3d11va'];
const broken = new Set(); // ways that failed on this PC (until Shelf restarts)
let used = '';            // the way that last worked

function setMode(m) { mode = MODES.includes(m) ? m : 'auto'; }
function getMode() { return mode; }

function ffmpegErr(args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', child;
    try { child = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve(''); }
    const timer = setTimeout(() => child.kill(), timeoutMs || 10000);
    const add = (d) => { if (out.length < 20000) out += d; };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

// What this copy of ffmpeg can use (asked once).
let methodsP = null;
function methods() {
  if (!methodsP) {
    methodsP = ffmpegErr(['-hide_banner', '-hwaccels']).then((out) => {
      const have = out.split(/\r?\n/).map((l) => l.trim());
      return ORDER.filter((m) => have.includes(m));
    });
  }
  return methodsP;
}

/** The video's codec, height and bit depth, from ffmpeg's description (no decoding). */
const infoCache = new Map();
async function videoInfo(file) {
  if (infoCache.has(file)) return infoCache.get(file);
  const out = await ffmpegErr(['-hide_banner', '-nostdin', '-i', file]);
  const info = parseInfo(out);
  if (infoCache.size > 200) infoCache.clear();
  infoCache.set(file, info);
  return info;
}
function parseInfo(out) {
  // The first video stream that isn't a cover picture.
  const line = String(out).split(/\r?\n/).find((l) => /Stream #.*Video:/.test(l) && !/attached pic|mjpeg|png/i.test(l)) || '';
  const codec = (/Video:\s*([a-z0-9_]+)/i.exec(line) || [])[1] || '';
  const size = /,\s*(\d{2,5})x(\d{2,5})/.exec(line);
  const pix = (/,\s*(yuv\w+|nv12|p010\w*|gray\w*)/i.exec(line) || [])[1] || '';
  return { codec: codec.toLowerCase(), width: size ? +size[1] : 0, height: size ? +size[2] : 0, bits: /10|12/.test(pix) ? 10 : 8 };
}
/** Heavy video: worth decoding on the card. */
function heavy(info) {
  return /^(hevc|h265|av1|vp9)$/.test(info.codec) || info.height > 1088 || info.width > 1920;
}

/**
 * How to make the scan's tiny grey thumbnails of this file: null (on the processor) or
 * { method, input: [args before -i], vf } — the filter ends with format=gray at w×h.
 */
async function thumbPlan(file, rate, w, h) {
  if (mode === 'off') return null;
  const ways = (await methods()).filter((m) => !broken.has(m));
  if (!ways.length) return null;
  const info = await videoInfo(file);
  if (!info.codec || (mode === 'auto' && !heavy(info))) return null;
  // H.264 above 8 bits, and old codecs, aren't decoded by graphics cards.
  if (!/^(h264|hevc|h265|av1|vp9|mpeg2video|vc1)$/.test(info.codec) || (info.codec === 'h264' && info.bits > 8)) return null;
  const method = ways[0];
  if (method === 'cuda') {
    return { method, input: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], vf: `fps=${rate},scale_cuda=${w}:${h}:format=nv12,hwdownload,format=nv12,format=gray` };
  }
  return { method, input: ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11'], vf: `fps=${rate},hwdownload,format=${info.bits > 8 ? 'p010le' : 'nv12'},scale=${w}:${h},format=gray` };
}
function failed(method) { if (method) broken.add(method); }
function worked(method) { used = method; }

/** For Settings: what Shelf can use on this PC. */
async function status() {
  const ways = await methods();
  return { mode, available: ways.filter((m) => !broken.has(m)), broken: [...broken], used };
}

module.exports = { setMode, getMode, thumbPlan, failed, worked, status, parseInfo, heavy, MODES };
