/*
 * Shelf desktop — reading and writing the tags inside music files (title, artist, album, track number,
 * cover picture, MusicBrainz ids…), for MP3, FLAC, M4A/AAC, Ogg Vorbis/Opus, WMA, WAV, AIFF and more.
 *
 * Safety rules:
 *  - A file is never changed in place: tags are written into a copy next to it, read back to check, and only
 *    then does the copy take the file's place (so a crash or a full disk leaves the file as it was).
 *  - Only the fields Shelf manages are touched; everything else in the file stays as it is.
 *  - Before writing, the old values of those fields are returned, so Undo can put them back.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const T = require('node-taglib-sharp');

// Keep each MP3's own ID3 version (many players read 2.3 better than 2.4).
T.Id3v2Settings.forceDefaultVersion = false;

const { AUDIO_EXT } = require('../app/js/parser.js');

// The fields Shelf reads and may write, and where each lives in the library's tag.
const TEXT = { title: 'title', album: 'album', titleSort: 'titleSort', albumSort: 'albumSort' };
const LISTS = { artists: 'performers', albumArtists: 'albumArtists', genres: 'genres', artistsSort: 'performersSort', albumArtistsSort: 'albumArtistsSort' };
const NUMS = { track: 'track', trackTotal: 'trackCount', disc: 'disc', discTotal: 'discCount', year: 'year' };
const MB = {
  release: 'musicBrainzReleaseId', releaseGroup: 'musicBrainzReleaseGroupId', recording: 'musicBrainzTrackId',
  artist: 'musicBrainzArtistId', albumArtist: 'musicBrainzReleaseArtistId', country: 'musicBrainzReleaseCountry',
  status: 'musicBrainzReleaseStatus', type: 'musicBrainzReleaseType'
};
const FIELDS = Object.keys(TEXT).concat(Object.keys(LISTS), Object.keys(NUMS), ['compilation'], Object.keys(MB).map((k) => 'mb.' + k), ['cover']);

function open(file) { return T.File.createFromPath(file); }
function frontOf(tag) {
  const pics = tag.pictures || [];
  return pics.find((p) => p.type === T.PictureType.FrontCover) || pics[0] || null;
}

/** What a file says about itself. Never throws: { ok: false, error } for a file that can't be read. */
function read(file) {
  let f;
  try { f = open(file); } catch (e) { return { ok: false, error: plain(e) }; }
  try {
    const t = f.tag, p = f.properties, out = { ok: true, mb: {} };
    for (const [k, v] of Object.entries(TEXT)) out[k] = t[v] || '';
    for (const [k, v] of Object.entries(LISTS)) out[k] = (t[v] || []).filter(Boolean);
    for (const [k, v] of Object.entries(NUMS)) out[k] = t[v] || 0;
    for (const [k, v] of Object.entries(MB)) out.mb[k] = t[v] || '';
    out.compilation = !!t.isCompilation;
    const pic = frontOf(t);
    out.cover = pic ? { mime: pic.mimeType || 'image/jpeg', size: pic.data.length } : null;
    out.duration = p ? Math.round(p.durationMilliseconds) / 1000 : 0;
    out.bitrate = p ? p.audioBitrate || 0 : 0;
    out.format = path.extname(file).slice(1).toLowerCase();
    out.originalYear = originalYear(f);
    return out;
  } catch (e) {
    return { ok: false, error: plain(e) };
  } finally {
    try { f.dispose(); } catch (e) {}
  }
}

// The year the album first came out (Picard writes it beside the edition's own date): Ogg/FLAC ORIGINALDATE or
// ORIGINALYEAR, MP3 TDOR or "originalyear". 0 when the file doesn't say.
function originalYear(f) {
  const y = (s) => { const m = /^(\d{4})/.exec(String(s || '').trim()); return m ? +m[1] : 0; };
  try {
    const x = f.getTag(T.TagTypes.Xiph, false);
    if (x) { const v = y(x.getFieldFirstValue('ORIGINALDATE')) || y(x.getFieldFirstValue('ORIGINALYEAR')); if (v) return v; }
  } catch (e) {}
  try {
    const id = f.getTag(T.TagTypes.Id3v2, false);
    if (id) {
      const v = y(id.getTextAsString(T.Id3v2FrameIdentifiers.TDOR));
      if (v) return v;
      const u = id.getFramesByClassType(T.Id3v2FrameClassType.UserTextInformationFrame).find((fr) => /^original ?(year|date)$/i.test(fr.description || ''));
      if (u) return y((u.text || [])[0]);
    }
  } catch (e) {}
  return 0;
}

/** The front cover's bytes (or null). */
function cover(file) {
  let f;
  try { f = open(file); const pic = frontOf(f.tag); return pic ? { mime: pic.mimeType || 'image/jpeg', data: Buffer.from(pic.data.toByteArray()) } : null; } catch (e) { return null; } finally { try { f && f.dispose(); } catch (e) {} }
}

// The current values of the fields in `want` (for Undo), with the cover's bytes when it's among them.
function snapshot(f, want) {
  const t = f.tag, out = {};
  for (const k of want) {
    if (TEXT[k]) out[k] = t[TEXT[k]] || '';
    else if (LISTS[k]) out[k] = (t[LISTS[k]] || []).slice();
    else if (NUMS[k]) out[k] = t[NUMS[k]] || 0;
    else if (k === 'compilation') out[k] = !!t.isCompilation;
    else if (k.startsWith('mb.')) out[k] = t[MB[k.slice(3)]] || '';
    else if (k === 'cover') { const pic = frontOf(t); out.cover = pic ? { mime: pic.mimeType || 'image/jpeg', data: Buffer.from(pic.data.toByteArray()).toString('base64') } : null; }
  }
  return out;
}

// Put `values` (flat: { title, artists, 'mb.release', cover: { mime, data (Buffer or base64) } | null, … }) into an open file.
function apply(f, values) {
  const t = f.tag;
  for (const [k, v] of Object.entries(values)) {
    if (TEXT[k]) t[TEXT[k]] = v ? String(v) : undefined;
    else if (LISTS[k]) t[LISTS[k]] = (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
    else if (NUMS[k]) t[NUMS[k]] = Math.max(0, Math.floor(Number(v) || 0));
    else if (k === 'compilation') t.isCompilation = !!v;
    else if (k.startsWith('mb.') && MB[k.slice(3)]) t[MB[k.slice(3)]] = v ? String(v) : undefined;
    else if (k === 'cover') {
      const others = (t.pictures || []).filter((p) => p.type !== T.PictureType.FrontCover);
      if (v && v.data) {
        const bytes = Buffer.isBuffer(v.data) ? v.data : Buffer.from(String(v.data), 'base64');
        const pic = T.Picture.fromFullData(T.ByteVector.fromByteArray(bytes), T.PictureType.FrontCover, v.mime || 'image/jpeg', '');
        t.pictures = [pic].concat(others);
      } else t.pictures = others;
    }
  }
}

/**
 * Make `target` a copy of `source` with `values` written into its tags. Returns the old values of the
 * fields written (for Undo). `source` itself is never changed (it may be the same path as `target`:
 * then the tagged copy takes its place only once it has been checked).
 */
async function writeTo(source, target, values) {
  const keys = Object.keys(values).filter((k) => FIELDS.includes(k));
  const inPlace = path.resolve(source) === path.resolve(target);
  if (!inPlace && fs.existsSync(target)) throw Object.assign(new Error('A file with that name is already there.'), { code: 'EXISTS' });
  // (Named like the source, so it's read as the same kind of file.)
  const tmp = path.join(path.dirname(target), '.shelf-tags-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + path.extname(source));
  await fsp.copyFile(source, tmp, fs.constants.COPYFILE_EXCL);
  let old;
  try {
    let f = open(tmp);
    try { old = snapshot(f, keys); apply(f, pick(values, keys)); f.save(); } finally { f.dispose(); }
    // Read it back: the file must still open, and say what was written.
    f = open(tmp);
    try {
      if (values.title != null && (f.tag.title || '') !== String(values.title || '')) throw new Error('The tags didn’t save as expected.');
    } finally { f.dispose(); }
    if (!inPlace && fs.existsSync(target)) throw Object.assign(new Error('A file with that name is already there.'), { code: 'EXISTS' });
    await fsp.rename(tmp, target);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
  return old;
}
/**
 * Every tag (and picture) of `source` into `target`, e.g. a FLAC's into the Ogg made from it. Written in place
 * through the same checked copy as writeTo.
 */
async function copyAll(source, target) {
  const tmp = path.join(path.dirname(target), '.shelf-tags-' + process.pid + '-' + Date.now() + path.extname(target));
  await fsp.copyFile(target, tmp, fs.constants.COPYFILE_EXCL);
  try {
    const from = open(source), to = open(tmp);
    try {
      from.tag.copyTo(to.tag, true);
      to.tag.pictures = from.tag.pictures;
      // (MusicBrainz ids live in fields the general copy leaves out.)
      for (const k of Object.values(MB)) if (from.tag[k]) to.tag[k] = from.tag[k];
      if (from.tag.isCompilation) to.tag.isCompilation = true;
      to.save();
    } finally { from.dispose(); to.dispose(); }
    const check = open(tmp); check.dispose(); // still opens
    await fsp.rename(tmp, target);
  } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
}
function pick(o, keys) { const out = {}; keys.forEach((k) => { out[k] = o[k]; }); return out; }

function plain(e) {
  const m = String((e && e.message) || e);
  if (/header not found|not a valid|corrupt|unsupported/i.test(m)) return 'This file looks damaged or isn’t really audio, so its tags can’t be read.';
  if (/ENOENT/.test(m)) return 'This file isn’t there any more.';
  if (/EBUSY|EPERM|EACCES/.test(m)) return 'Another program is using this file.';
  return m;
}

module.exports = { read, cover, writeTo, copyAll, FIELDS, AUDIO_EXT };
