// Music tags: written into a checked copy, read back exactly, the sound itself untouched, and the old values
// returned so Undo can put them back. Short test songs are made with ffmpeg in a temporary folder.
// Run with: node tests/tags.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const tags = require('../desktop/tags.js');
const ff = require('ffmpeg-static');

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-tags-'));
const run = (args) => execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { windowsHide: true });
// The sound, as a fingerprint of its packets (tags aren't part of it).
const sound = (f) => execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-i', f, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-'], { windowsHide: true }).toString().trim();

const FORMATS = { mp3: ['-c:a', 'libmp3lame', '-b:a', '64k'], flac: ['-c:a', 'flac'], m4a: ['-c:a', 'aac', '-b:a', '64k'], ogg: ['-c:a', 'libvorbis', '-q:a', '1'], opus: ['-c:a', 'libopus', '-b:a', '32k'] };

(async () => {
  const jpg = path.join(tmp, 'cover.jpg');
  run(['-f', 'lavfi', '-i', 'color=c=orange:s=64x64', '-frames:v', '1', jpg]);
  const coverBytes = fs.readFileSync(jpg);
  const values = {
    title: 'Dancing Queen', artists: ['ABBA'], albumArtists: ['ABBA'], album: 'Gold: Greatest Hits', genres: ['Pop'],
    track: 1, trackTotal: 19, disc: 1, discTotal: 1, year: 1992, compilation: false, artistsSort: ['ABBA'],
    'mb.release': '9daa9d6e-7780-487f-9ef8-885755b73125', 'mb.recording': 'a502f559-f70c-4e0d-a5e5-e0cc319d0bd7',
    'mb.releaseGroup': 'c2c2b5b6-5a5c-3d70-8c4f-4f3f3b8e5b3e', 'mb.albumArtist': 'd87e52c5-bb8d-4da8-b941-9f4928627dc8',
    cover: { mime: 'image/jpeg', data: coverBytes }
  };
  for (const [ext, codec] of Object.entries(FORMATS)) {
    const f = path.join(tmp, 'song.' + ext);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-metadata', 'title=Track 01', '-metadata', 'artist=Unknown'].concat(codec, [f]));
    const before = tags.read(f), soundBefore = sound(f);
    assert.ok(before.ok, ext + ': reads a fresh file: ' + before.error);
    assert.strictEqual(before.title, 'Track 01');
    const sizeBefore = fs.statSync(f).size;

    // Into a new file (copy mode): the original is left exactly as it was.
    const copy = path.join(tmp, 'tagged.' + ext);
    const old = await tags.writeTo(f, copy, values);
    assert.strictEqual(fs.statSync(f).size, sizeBefore, ext + ': the original is untouched');
    assert.strictEqual(old.title, 'Track 01', ext + ': old title handed back');
    assert.deepStrictEqual(old.artists, ['Unknown']);
    assert.strictEqual(old.cover, null);
    const r = tags.read(copy);
    for (const k of ['title', 'album', 'track', 'trackTotal', 'disc', 'year']) assert.strictEqual(r[k], values[k], ext + ': ' + k + ' = ' + r[k]);
    assert.deepStrictEqual(r.artists, ['ABBA']); assert.deepStrictEqual(r.albumArtists, ['ABBA']); assert.deepStrictEqual(r.genres, ['Pop']);
    assert.strictEqual(r.mb.release, values['mb.release'], ext + ': MusicBrainz release id');
    assert.strictEqual(r.mb.recording, values['mb.recording'], ext + ': MusicBrainz recording id');
    assert.ok(r.cover && r.cover.size === coverBytes.length, ext + ': cover written');
    assert.ok(tags.cover(copy).data.equals(coverBytes), ext + ': cover bytes exact');
    assert.strictEqual(sound(copy), soundBefore, ext + ': the sound itself is untouched');
    assert.ok(r.duration > 2.5 && r.duration < 3.5, ext + ': length ' + r.duration);

    // In place (move mode), then put back.
    const old2 = await tags.writeTo(copy, copy, { title: 'Changed', cover: null });
    assert.strictEqual(old2.title, 'Dancing Queen'); assert.ok(old2.cover && old2.cover.data);
    assert.strictEqual(tags.read(copy).cover, null, ext + ': cover removed');
    await tags.writeTo(copy, copy, old2);
    const back = tags.read(copy);
    assert.strictEqual(back.title, 'Dancing Queen', ext + ': title put back');
    assert.ok(tags.cover(copy).data.equals(coverBytes), ext + ': cover put back');
    assert.strictEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('.shelf-tags-')).length, 0, ext + ': no temporary files left');
    ok(ext + ': every field and the cover written and read back, sound untouched, old values put back');
  }

  // Never overwrites another file; a damaged file says so in plain words.
  const a = path.join(tmp, 'song.mp3'), b = path.join(tmp, 'song.flac');
  await assert.rejects(tags.writeTo(a, b, { title: 'x' }), (e) => e.code === 'EXISTS' || /already there/.test(e.message));
  assert.ok(tags.read(b).ok, 'the other file is unharmed');
  const bad = path.join(tmp, 'bad.mp3'); fs.writeFileSync(bad, Buffer.alloc(4096, 7));
  const rb = tags.read(bad);
  assert.ok(!rb.ok && /damaged|isn’t really audio/.test(rb.error), 'damaged file: ' + rb.error);
  ok('never overwrites another file; a damaged file is explained, not a crash');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(passed + ' tag checks passed');
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
