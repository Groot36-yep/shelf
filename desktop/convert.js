/*
 * Shelf desktop — making lossless songs (FLAC, WAV, AIFF, ALAC…) smaller: Ogg Vorbis (quality 6, about 190 kbps)
 * or Opus (160 kbps). At these settings they sound the same as the original to practically everyone, at about
 * a sixth of the size. Done with the ffmpeg Shelf already has; every tag and the cover go along.
 *
 * Safety: the new file is written under a temporary name, its length checked against the original, its tags
 * copied, and only then given its name (never over an existing file). The original is never changed here.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const tags = require('./tags.js');

const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const ffmpegPath = () => unpacked(require('ffmpeg-static'));

const LOSSLESS_EXT = ['flac', 'wav', 'aif', 'aiff', 'ape', 'wv', 'dsf'];
const FORMATS = {
  vorbis: { ext: 'ogg', args: ['-c:a', 'libvorbis', '-q:a', '6'], kbps: 192, name: 'Ogg Vorbis' },
  opus: { ext: 'opus', args: ['-c:a', 'libopus', '-b:a', '160k', '-vbr', 'on'], kbps: 160, name: 'Opus' }
};

/** Is this song lossless (worth making smaller)? ALAC hides in .m4a: a bitrate far above any lossy file's says so. */
function isLossless(file, info) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return LOSSLESS_EXT.includes(ext) || ((ext === 'm4a' || ext === 'mp4') && info && info.bitrate > 500);
}

function run(args, ms) {
  return new Promise((resolve, reject) => {
    let err = '';
    const p = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} }, ms || 600000);
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(); else reject(new Error('ffmpeg: ' + (err.trim().split('\n').pop() || 'exit ' + code))); });
  });
}

/**
 * Make `target` (ending .ogg / .opus) a smaller copy of `source`, with all its tags and cover.
 * format: 'vorbis' | 'opus'. Returns { size }.
 */
async function toSmaller(source, target, format) {
  const f = FORMATS[format];
  if (!f) throw new Error('Unknown format');
  if (path.extname(target).toLowerCase() !== '.' + f.ext) throw new Error('Wrong file type for ' + f.name);
  if (fs.existsSync(target)) throw Object.assign(new Error('A file with that name is already there.'), { code: 'EXISTS' });
  const before = tags.read(source);
  if (!before.ok) throw new Error(before.error);
  const tmp = path.join(path.dirname(target), '.shelf-convert-' + process.pid + '-' + Date.now() + '.' + f.ext);
  try {
    // Sound only (tags and cover are copied afterwards, exactly).
    await run(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source, '-map', '0:a:0', '-map_metadata', '-1', '-vn'].concat(f.args, [tmp]));
    const after = tags.read(tmp);
    if (!after.ok || Math.abs(after.duration - before.duration) > 1.5) throw new Error('The converted song came out a different length, so it wasn’t used.');
    await tags.copyAll(source, tmp);
    if (fs.existsSync(target)) throw Object.assign(new Error('A file with that name is already there.'), { code: 'EXISTS' });
    await fsp.rename(tmp, target);
    return { size: (await fsp.stat(target)).size };
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

module.exports = { toSmaller, isLossless, FORMATS, LOSSLESS_EXT };
