/*
 * Shelf desktop — read a video's running time from its file header.
 * Only a few kilobytes of the container's header are read (never the picture or sound),
 * and only for files the user picked AND asked Shelf to check.
 * Supports MP4/M4V/MOV, MKV/WebM and AVI. Returns seconds, or null if it can't tell.
 */
'use strict';

const fsp = require('fs').promises;

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

// ---- MP4 / MOV: the "mvhd" box inside "moov" holds timescale + duration ----
async function mp4Duration(fh, size) {
  let pos = 0;
  for (let guard = 0; pos + 8 <= size && guard < 200; guard++) {
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) return null;
    let boxSize = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let headerLen = 8;
    if (boxSize === 1) { boxSize = Number(h.readBigUInt64BE(8)); headerLen = 16; }
    else if (boxSize === 0) boxSize = size - pos;
    if (boxSize < headerLen) return null;
    if (type === 'moov') {
      const moov = await readAt(fh, pos + headerLen, Math.min(boxSize - headerLen, 1 << 20));
      const at = moov.indexOf('mvhd', 0, 'latin1');
      if (at < 4) return null;
      const d = at + 4; // version (1) + flags (3)
      const v = moov[d];
      const timescale = v === 1 ? moov.readUInt32BE(d + 20) : moov.readUInt32BE(d + 12);
      const duration = v === 1 ? Number(moov.readBigUInt64BE(d + 24)) : moov.readUInt32BE(d + 16);
      return timescale ? duration / timescale : null;
    }
    pos += boxSize;
  }
  return null;
}

// ---- Matroska / WebM: Segment → Info → TimecodeScale + Duration ----
function vint(buf, i, keepMarker) {
  const first = buf[i];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || i + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  for (let k = 1; k < len; k++) value = value * 256 + buf[i + k];
  return { value, len };
}
async function mkvDuration(fh) {
  const buf = await readAt(fh, 0, 1 << 20); // the Info section sits near the start
  // Walk the structure: EBML header, then Segment, then its children until Info.
  const hId = vint(buf, 0, true), hSz = hId && vint(buf, hId.len);
  if (!hSz) return null;
  let p = hId.len + hSz.len + hSz.value;
  const sId = vint(buf, p, true), sSz = sId && vint(buf, p + sId.len);
  if (!sSz || sId.value !== 0x18538067) return null;
  p += sId.len + sSz.len;
  let size = null, at = -1;
  for (let guard = 0; p < buf.length && guard < 50; guard++) {
    const cId = vint(buf, p, true), cSz = cId && vint(buf, p + cId.len);
    if (!cSz) return null;
    if (cId.value === 0x1549a966) { at = p + cId.len; size = cSz; break; } // Info
    p += cId.len + cSz.len + cSz.value;
  }
  if (at < 0) return null;
  let i = at + size.len;
  const end = Math.min(buf.length, i + size.value);
  let scale = 1000000, dur = null;
  while (i < end) {
    const id = vint(buf, i, true); if (!id) break;
    const sz = vint(buf, i + id.len); if (!sz) break;
    const data = i + id.len + sz.len;
    if (id.value === 0x2ad7b1) { let v = 0; for (let k = 0; k < sz.value; k++) v = v * 256 + buf[data + k]; scale = v || scale; }
    if (id.value === 0x4489) dur = sz.value === 4 ? buf.readFloatBE(data) : sz.value === 8 ? buf.readDoubleBE(data) : null;
    i = data + sz.value;
  }
  return dur ? dur * scale / 1e9 : null;
}

// ---- AVI: the "avih" header holds microseconds-per-frame and the frame count ----
async function aviDuration(fh) {
  const buf = await readAt(fh, 0, 64 * 1024);
  const at = buf.indexOf('avih', 0, 'latin1');
  if (at < 0 || at + 8 + 20 > buf.length) return null;
  const d = at + 8;
  const usPerFrame = buf.readUInt32LE(d);
  const frames = buf.readUInt32LE(d + 16);
  return usPerFrame && frames ? usPerFrame * frames / 1e6 : null;
}

/** Running time in seconds, or null. fh: an open file handle to read instead (a video on your server). */
async function duration(file, fh0) {
  let fh;
  try {
    fh = fh0 || await fsp.open(file, 'r');
    const st = await fh.stat();
    const head = await readAt(fh, 0, 12);
    let secs = null;
    if (head.length >= 8 && head.toString('latin1', 4, 8).match(/^(ftyp|moov|mdat|free|wide|skip)$/)) secs = await mp4Duration(fh, st.size);
    else if (head.readUInt32BE(0) === 0x1a45dfa3) secs = await mkvDuration(fh);
    else if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'AVI ') secs = await aviDuration(fh);
    return secs && isFinite(secs) && secs > 0 && secs < 6 * 3600 ? Math.round(secs) : null;
  } catch (e) {
    return null;
  } finally {
    if (fh && !fh0) await fh.close().catch(() => {});
  }
}

module.exports = { duration };
