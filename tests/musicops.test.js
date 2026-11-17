// Rename Now for songs: tags and cover written (copy: into the copy only; move: in place after the move), the
// album's cover.jpg saved once, and Undo putting back names, tags and covers. Test songs are made with ffmpeg.
// Run with: node tests/musicops.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const fileops = require('../desktop/fileops.js');
const tags = require('../desktop/tags.js');
const ff = require('ffmpeg-static');

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const run = (args) => execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { windowsHide: true });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-musicops-'));
  const src = path.join(tmp, 'Downloads', 'ABBA'), lib = path.join(tmp, 'Plex'), hist = path.join(tmp, 'history');
  fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(lib); fs.mkdirSync(hist);
  const jpg = path.join(tmp, 'c.jpg'), oldJpg = path.join(tmp, 'old.jpg');
  run(['-f', 'lavfi', '-i', 'color=c=orange:s=64x64', '-frames:v', '1', jpg]);
  run(['-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', oldJpg]);
  const coverBytes = fs.readFileSync(jpg), oldCover = fs.readFileSync(oldJpg);
  const mk = (name) => {
    const f = path.join(src, name);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-metadata', 'title=Track 1', '-c:a', 'libmp3lame', '-b:a', '64k', f]);
    return f;
  };
  const coverFor = async (ref, size) => (ref.release === 'R1' ? { mime: 'image/jpeg', data: coverBytes, size } : null);
  const values = { title: 'Dancing Queen', artists: ['ABBA'], albumArtists: ['ABBA'], album: 'Gold: Greatest Hits', track: 1, trackTotal: 19, 'mb.release': 'R1', cover: { mime: 'x', data: 'bm90IGEgY292ZXI=' } };
  const op = (f) => ({ source: f, folder: ['Music', 'ABBA', 'Gold - Greatest Hits (1992)'], file: '01 - Dancing Queen.mp3', music: { tags: values, cover: { release: 'R1', group: 'G1', embed: true, folder: true } } });

  // 1. Copy: the copy has the new tags + cover; the original is untouched; cover.jpg saved; Undo removes both.
  const a = mk('01 Dancing Queen.mp3');
  await tags.writeTo(a, a, { cover: { mime: 'image/jpeg', data: oldCover } });
  const sizeA = fs.statSync(a).size;
  let j = path.join(hist, '1.json');
  let { results } = await fileops.run([op(a)], { library: lib, mode: 'copy', allowed: new Set([a]), journalPath: j, coverFor });
  const to = path.join(lib, 'Music', 'ABBA', 'Gold - Greatest Hits (1992)', '01 - Dancing Queen.mp3');
  assert.ok(results[0].ok && results[0].to === to, JSON.stringify(results[0]));
  assert.strictEqual(fs.statSync(a).size, sizeA, 'original untouched');
  assert.strictEqual(tags.read(a).title, 'Track 1');
  const t = tags.read(to);
  assert.strictEqual(t.title, 'Dancing Queen'); assert.strictEqual(t.album, 'Gold: Greatest Hits'); assert.strictEqual(t.mb.release, 'R1');
  assert.ok(tags.cover(to).data.equals(coverBytes), 'the album cover (fetched by Shelf, not the one the window sent)');
  const pic = path.join(path.dirname(to), 'cover.jpg');
  assert.ok(fs.readFileSync(pic).equals(coverBytes), 'cover.jpg in the album folder');
  let u = await fileops.undo(j);
  assert.strictEqual(u.undone, 1);
  assert.ok(!fs.existsSync(to) && !fs.existsSync(pic), 'copy and cover.jpg removed');
  assert.ok(!fs.existsSync(path.join(lib, 'Music')), 'empty folders tidied');
  ok('copy: the copy gets the tags and cover, the original is untouched, cover.jpg saved; Undo removes them');

  // 2. Move: moved, tags changed in place; Undo moves it back with its old tags and old cover.
  j = path.join(hist, '2.json');
  ({ results } = await fileops.run([op(a)], { library: lib, mode: 'move', allowed: new Set([a]), journalPath: j, coverFor }));
  assert.ok(results[0].ok && results[0].tagged, JSON.stringify(results[0]));
  assert.ok(!fs.existsSync(a) && fs.existsSync(to));
  assert.strictEqual(tags.read(to).title, 'Dancing Queen');
  const journal = JSON.parse(fs.readFileSync(j, 'utf8'));
  assert.ok(journal.done[0].oldTags && journal.done[0].oldTags.cover.ref, 'old cover kept beside the journal, not in it');
  assert.ok(fs.statSync(j).size < 4000, 'the journal stays small: ' + fs.statSync(j).size);
  u = await fileops.undo(j);
  assert.strictEqual(u.undone, 1);
  assert.ok(fs.existsSync(a) && !fs.existsSync(to), 'moved back');
  const back = tags.read(a);
  assert.strictEqual(back.title, 'Track 1', 'old title back'); assert.strictEqual(back.album, '', 'old (empty) album back');
  assert.ok(tags.cover(a).data.equals(oldCover), 'old cover back');
  assert.ok(!fs.existsSync(j + '.covers'), 'the kept covers are cleared with the journal');
  ok('move: tags changed after the move; Undo moves it back with its old tags and cover');

  // 3. Hard links: the link is the original, so its tags are left alone (and it says so).
  j = path.join(hist, '3.json');
  ({ results } = await fileops.run([op(a)], { library: lib, mode: 'link', allowed: new Set([a]), journalPath: j, coverFor }));
  assert.ok(results[0].ok && /left as they are/.test(results[0].note || ''), JSON.stringify(results[0]));
  assert.strictEqual(tags.read(a).title, 'Track 1');
  await fileops.undo(j);
  ok('hard links: tags left alone, and the result says so');

  // 4. Lyrics go along with a song like any file; a cover.jpg that's there already is never replaced.
  const lrc = path.join(src, '01 Dancing Queen.lrc'); fs.writeFileSync(lrc, '[00:01.00]You can dance');
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(pic, 'MINE');
  j = path.join(hist, '4.json');
  ({ results } = await fileops.run([op(a), { source: lrc, folder: op(a).folder, file: '01 - Dancing Queen.lrc' }], { library: lib, mode: 'move', allowed: new Set([a, lrc]), journalPath: j, coverFor }));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.strictEqual(fs.readFileSync(pic, 'utf8'), 'MINE', 'your own cover.jpg is kept');
  assert.ok(fs.existsSync(path.join(path.dirname(to), '01 - Dancing Queen.lrc')));
  await fileops.undo(j);
  assert.ok(fs.existsSync(lrc) && fs.existsSync(a) && fs.readFileSync(pic, 'utf8') === 'MINE');
  ok('lyrics move with their song; a cover.jpg already there is never replaced');

  // 5. Made smaller: a FLAC becomes an Ogg Vorbis with its tags (copy: the FLAC stays; move: it goes to the
  //    Recycle Bin, only once the Ogg is checked); Undo removes the Ogg and says where the original is.
  const flac = path.join(src, '02 Knowing Me.flac');
  run(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', '-c:a', 'flac', flac]);
  await tags.writeTo(flac, flac, { title: 'Knowing Me, Knowing You', artists: ['ABBA'], 'mb.recording': 'rec-2', cover: { mime: 'image/jpeg', data: oldCover } });
  const flacSize = fs.statSync(flac).size;
  const shrinkOp = { source: flac, folder: ['Music', 'ABBA', 'Gold - Greatest Hits (1992)'], file: '02 - Knowing Me, Knowing You.ogg', music: { convert: 'vorbis', tags: { title: 'Knowing Me, Knowing You', track: 2, album: 'Gold: Greatest Hits' }, cover: null } };
  const ogg = path.join(lib, 'Music', 'ABBA', 'Gold - Greatest Hits (1992)', '02 - Knowing Me, Knowing You.ogg');
  j = path.join(hist, '5.json');
  ({ results } = await fileops.run([shrinkOp], { library: lib, mode: 'copy', allowed: new Set([flac]), journalPath: j, coverFor }));
  assert.ok(results[0].ok && results[0].converted === 'vorbis', JSON.stringify(results[0]));
  assert.strictEqual(fs.statSync(flac).size, flacSize, 'copy: the FLAC is untouched');
  const o = tags.read(ogg);
  assert.ok(o.ok && o.format === 'ogg' && o.title === 'Knowing Me, Knowing You' && o.album === 'Gold: Greatest Hits' && o.track === 2 && o.mb.recording === 'rec-2', JSON.stringify(o));
  assert.ok(tags.cover(ogg).data.equals(oldCover), 'its cover came along');
  assert.ok(fs.statSync(ogg).size < flacSize / 2, 'smaller: ' + fs.statSync(ogg).size + ' vs ' + flacSize);
  u = await fileops.undo(j);
  assert.ok(u.undone === 1 && !fs.existsSync(ogg) && fs.existsSync(flac));
  // Move: the original goes to the (pretend) Recycle Bin.
  const binned = [];
  const trash = async (p) => { binned.push(p); fs.renameSync(p, p + '.binned'); };
  j = path.join(hist, '6.json');
  ({ results } = await fileops.run([shrinkOp], { library: lib, mode: 'move', allowed: new Set([flac]), journalPath: j, coverFor, trash }));
  assert.ok(results[0].ok && results[0].trashed, JSON.stringify(results[0]));
  assert.deepStrictEqual(binned, [flac]); assert.ok(fs.existsSync(ogg));
  u = await fileops.undo(j);
  assert.ok(u.undone === 1 && !fs.existsSync(ogg) && u.inTrash.length === 1, JSON.stringify(u));
  // Something going wrong never costs the original: a "FLAC" that isn't audio stays where it is.
  const bad = path.join(src, '03 Bad.flac'); fs.writeFileSync(bad, Buffer.alloc(4000, 3));
  ({ results } = await fileops.run([Object.assign({}, shrinkOp, { source: bad, file: '03 - Bad.ogg' })], { library: lib, mode: 'move', allowed: new Set([bad]), journalPath: path.join(hist, '7.json'), coverFor, trash }));
  assert.ok(!results[0].ok && fs.existsSync(bad) && binned.length === 1, JSON.stringify(results[0]));
  ok('made smaller (FLAC → Ogg Vorbis): tags and cover along; copy keeps the FLAC, move bins it only once the Ogg is checked; Undo');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(passed + ' music rename checks passed');
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
