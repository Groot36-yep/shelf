/*
 * Shelf desktop — cut a text subtitle file (SRT, WebVTT, ASS/SSA) into pieces that match a split
 * video: each piece keeps the lines shown during its stretch, with times moved so the piece starts at 0.
 */
'use strict';

function parseTime(s) {
  // 01:02:03,456  01:02:03.456  1:02:03.45 (ASS)  02:03.456 (VTT without hours)
  const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  const frac = m[4].length === 3 ? +m[4] / 1000 : m[4].length === 2 ? +m[4] / 100 : +m[4] / 10;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + frac;
}
function pad(n, w) { return String(n).padStart(w, '0'); }
function srtTime(t) { t = Math.max(0, t); const ms = Math.round(t * 1000); return pad(Math.floor(ms / 3600000), 2) + ':' + pad(Math.floor(ms / 60000) % 60, 2) + ':' + pad(Math.floor(ms / 1000) % 60, 2) + ',' + pad(ms % 1000, 3); }
function vttTime(t) { return srtTime(t).replace(',', '.'); }
function assTime(t) { t = Math.max(0, t); const cs = Math.round(t * 100); return Math.floor(cs / 360000) + ':' + pad(Math.floor(cs / 6000) % 60, 2) + ':' + pad(Math.floor(cs / 100) % 60, 2) + '.' + pad(cs % 100, 2); }

// Keep a cue if it shows during [start, end); trim it to that stretch and shift it to start at 0.
function place(a, b, start, end) {
  if (b <= start || a >= end) return null;
  return [Math.max(a, start) - start, Math.min(b, end) - start];
}

function splitSrt(text, pieces) {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const blk of blocks) {
    const lines = blk.split('\n').filter((l, i, arr) => !(i === 0 && /^\d+$/.test(l.trim()) && arr.length > 1));
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [x, y] = lines[ti].split('-->');
    const a = parseTime(x), b = parseTime(y.trim().split(/\s+/)[0]);
    if (a == null || b == null) continue;
    cues.push({ a, b, text: lines.slice(ti + 1).join('\n').replace(/\n+$/, '') });
  }
  return pieces.map((p) => {
    let n = 0;
    const text = cues.map((c) => { const t = place(c.a, c.b, p.start, p.end); return t ? (++n) + '\n' + srtTime(t[0]) + ' --> ' + srtTime(t[1]) + '\n' + c.text + '\n' : null; })
      .filter(Boolean).join('\n');
    return { text, cues: n };
  });
}

function splitVtt(text, pieces) {
  const norm = text.replace(/\r\n?/g, '\n');
  const blocks = norm.split(/\n{2,}/);
  const head = blocks[0].startsWith('WEBVTT') ? blocks.shift() : 'WEBVTT';
  const keep = [], cues = [];
  for (const blk of blocks) {
    const lines = blk.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) { if (/^(STYLE|REGION)/.test(blk)) keep.push(blk); continue; }
    const [x, rest] = lines[ti].split('-->');
    const parts = rest.trim().split(/\s+/);
    const a = parseTime(x), b = parseTime(parts[0]);
    if (a == null || b == null) continue;
    cues.push({ a, b, settings: parts.slice(1).join(' '), id: ti > 0 ? lines.slice(0, ti).join('\n') : '', text: lines.slice(ti + 1).join('\n').replace(/\n+$/, '') });
  }
  return pieces.map((p) => {
    const kept = cues.map((c) => {
      const t = place(c.a, c.b, p.start, p.end);
      return t ? (c.id ? c.id + '\n' : '') + vttTime(t[0]) + ' --> ' + vttTime(t[1]) + (c.settings ? ' ' + c.settings : '') + '\n' + c.text : null;
    }).filter(Boolean);
    return { text: [head].concat(keep, kept).join('\n\n') + '\n', cues: kept.length };
  });
}

function splitAss(text, pieces) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let fmt = null, inEvents = false;
  return pieces.map((p) => { let n = 0; const text = lines.map((line) => {
    if (/^\[Events\]/i.test(line)) { inEvents = true; return line; }
    if (/^\[/.test(line)) { inEvents = false; return line; }
    if (inEvents && /^Format:/i.test(line)) { fmt = line.slice(7).split(',').map((s) => s.trim().toLowerCase()); return line; }
    const m = inEvents && line.match(/^(Dialogue|Comment):\s*(.*)$/i);
    if (!m || !fmt) return line;
    const fields = []; let rest = m[2];
    for (let i = 0; i < fmt.length - 1; i++) { const k = rest.indexOf(','); fields.push(rest.slice(0, k)); rest = rest.slice(k + 1); }
    fields.push(rest);
    const si = fmt.indexOf('start'), ei = fmt.indexOf('end');
    const a = parseTime(fields[si]), b = parseTime(fields[ei]);
    if (a == null || b == null) return line;
    const t = place(a, b, p.start, p.end);
    if (!t) return null;
    fields[si] = assTime(t[0]); fields[ei] = assTime(t[1]);
    if (/^dialogue$/i.test(m[1])) n++;
    return m[1] + ': ' + fields.join(',');
  }).filter((l) => l !== null).join('\n'); return { text, cues: n }; });
}

/** Like splitSubtitle, but each piece is { text, cues } (cues = how many lines it kept). */
function splitSubtitleDetailed(text, ext, pieces) {
  text = String(text).replace(/^\uFEFF/, '');
  ext = String(ext).toLowerCase().replace(/^\./, '');
  if (ext === 'srt') return splitSrt(text, pieces);
  if (ext === 'vtt') return splitVtt(text, pieces);
  if (ext === 'ass' || ext === 'ssa') return splitAss(text, pieces);
  return null;
}
/** Split subtitle text for pieces [{ start, end }]. ext: 'srt' | 'vtt' | 'ass' | 'ssa'. Returns strings, or null if unsupported. */
function splitSubtitle(text, ext, pieces) {
  const r = splitSubtitleDetailed(text, ext, pieces);
  return r && r.map((x) => x.text);
}

/**
 * Bytes in, bytes out, without changing the text's encoding: times are plain ASCII, so the text is
 * handled byte-for-byte (latin1) unless it's UTF-16. A UTF-8 marker at the start is kept on every piece.
 */
function splitSubtitleBytes(buf, ext, pieces) {
  let enc = 'latin1', bom = Buffer.alloc(0), body = buf;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { bom = buf.subarray(0, 3); body = buf.subarray(3); }
  else if (buf[0] === 0xff && buf[1] === 0xfe) { enc = 'utf16le'; bom = buf.subarray(0, 2); body = buf.subarray(2); }
  else if (buf[0] === 0xfe && buf[1] === 0xff) return null; // big-endian UTF-16: very rare, left alone
  const r = splitSubtitleDetailed(body.toString(enc), ext, pieces);
  return r && r.map((x) => ({ data: Buffer.concat([bom, Buffer.from(x.text, enc)]), cues: x.cues }));
}

const CAN_SPLIT = ['srt', 'vtt', 'ass', 'ssa'];
module.exports = { splitSubtitle, splitSubtitleDetailed, splitSubtitleBytes, CAN_SPLIT, parseTime };
