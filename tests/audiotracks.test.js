// A video's sound tracks: read, kept or removed, which plays first, one added from another file and lined up
// (desktop/audiotracks.js), with Rename Now and Undo. node tests/audiotracks.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const A = require('../desktop/audiotracks');
const L = require('../desktop/loudstart');
const fileops = require('../desktop/fileops');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
const FF = require('ffmpeg-static');
const ff = (args) => execFileSync(FF, ['-loglevel', 'error', '-y'].concat(args));

// Sound that never repeats (three tones switching on and off at unrelated rates), so lining up has one answer.
const SOUND = (f) => `aevalsrc='0.4*sin(2*PI*${f}*t)*gt(sin(2*PI*0.9*t)+sin(2*PI*1.37*t)+sin(2*PI*0.21*t),0.4)':s=48000:d=180`;

(async () => {
  await check('reads the tracks, their languages (or from their titles), which plays first, and cover pictures', () => {
    const log = [
      "Input #0, matroska,webm, from 'x.mkv':",
      '  Duration: 00:22:10.50, start: 0.000000, bitrate: 1000 kb/s',
      '  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080, 23.98 fps (default)',
      '  Stream #0:1(hin): Audio: aac (LC), 48000 Hz, 5.1, fltp (default)',
      '    Metadata:',
      '      title           : Hindi 5.1',
      '  Stream #0:2(eng): Audio: eac3, 48000 Hz, stereo, fltp',
      '  Stream #0:3: Audio: ac3, 48000 Hz, stereo, fltp',
      '    Metadata:',
      '      title           : Spanish (Latino)',
      '  Stream #0:4(eng): Subtitle: subrip',
      '  Stream #0:5: Attachment: ttf',
      '    Metadata:',
      '      filename        : font.ttf',
      '  Stream #0:6: Video: mjpeg (Progressive), yuvj444p, 217x118, 90k tbn (attached pic)',
      '    Metadata:',
      '      filename        : cover.jpg',
      '      mimetype        : image/jpeg'
    ].join('\n');
    const f = A.parseFile(log);
    assert.deepStrictEqual(f.tracks.map((t) => [t.n, t.stream, t.lang, t.channels, t.def]), [[0, 1, 'hin', '5.1', true], [1, 2, 'eng', 'stereo', false], [2, 3, 'spa', 'stereo', false]]);
    assert.deepStrictEqual(f.tracks.map((t) => t.langName), ['Hindi', 'English', 'Spanish']);
    assert.strictEqual(A.playsFirst(f.tracks), 0);
    assert.deepStrictEqual(f.pics, [{ stream: 6, filename: 'cover.jpg', mimetype: 'image/jpeg', pic: true }]);
    assert.strictEqual(f.attachments, 1);
    assert.strictEqual(A.langCode('en'), 'eng'); assert.strictEqual(A.langCode('fra'), 'fre'); assert.strictEqual(A.langCode('und'), '');
  });

  await check('only a sane plan is used, and the copy is made the right way', () => {
    assert.throws(() => A.checkPlan({ keep: [], first: 0 }, 2));
    assert.throws(() => A.checkPlan({ keep: [5], first: 5 }, 2));
    assert.throws(() => A.checkPlan({ keep: [0], first: 1 }, 2), 'what plays first must be kept');
    assert.throws(() => A.checkPlan({ keep: [0], first: 0, add: { file: 'relative.mkv', n: 0, offset: 0 } }, 2));
    const info = { tracks: [], pics: [], attachments: 1 };
    const plan = A.checkPlan({ keep: [0, 1], first: 1 }, 3);
    const args = A.buildArgs('in.mkv', 'out.mkv', info, plan, null, [{ file: 'c.jpg', filename: 'cover.jpg', mimetype: 'image/jpeg' }]).join(' ');
    assert.ok(args.includes('-map 0:V? -map 0:a:1 -map 0:a:0 -map 0:s? -map 0:t?'), 'English first, Hindi second, Spanish gone; no cover as a video track: ' + args);
    assert.ok(args.includes('-disposition:a:0 default -disposition:a:1 0'), 'only the first is marked to play');
    assert.ok(args.includes('-c copy') && !args.includes('-c:a'), 'nothing re-encoded');
    assert.ok(args.includes('-attach c.jpg -metadata:s:t:1 mimetype=image/jpeg -metadata:s:t:1 filename=cover.jpg'), 'the cover is put back as an attachment (after the font)');
    assert.ok(A.buildArgs('in.mp4', 'out.mp4', info, plan, null, []).includes('0:v?'), 'MP4 keeps its cover as it is');
    const add = A.checkPlan({ keep: [0], first: 'add', add: { file: path.resolve('es.mkv'), n: 0, offset: -0.71, lang: 'es' } }, 1);
    const a2 = A.buildArgs('in.mkv', 'out.mkv', info, add, null, []).join(' ');
    assert.ok(a2.includes('-map 1:a:0 -map 0:a:0') && a2.includes('-c:a:0 aac') && a2.includes('-filter:a:0 atrim=start=0.71,asetpts=PTS-STARTPTS,atrim=start_sample=1024'), 'only the added track re-encoded, its first 0.71 s skipped: ' + a2);
    assert.ok(!a2.includes('-c:a:1'), 'the track you had is copied as it is');
    assert.ok(A.buildArgs('in.mkv', 'out.mkv', info, A.checkPlan({ keep: [0], first: 0, add: { file: path.resolve('es.mkv'), n: 0, offset: 2, lang: 'es' } }, 1), null, []).join(' ').includes('-filter:a:1 adelay=2000:all=1'));
    assert.ok(a2.includes('-metadata:s:a:0 language=spa -metadata:s:a:0 title=Spanish'), a2);
  });

  // A real (made-up) 3-minute video: English, Hindi and Spanish sound, Hindi playing first, and a cover picture.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sound-'));
  const src = path.join(tmp, 'in', 'Show S01E01.mkv'); fs.mkdirSync(path.dirname(src));
  const cover = path.join(tmp, 'cover.jpg');
  ff(['-f', 'lavfi', '-i', 'color=c=0x804020:s=64x36:d=1', '-frames:v', '1', cover]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x204060:s=160x90:r=10:d=180', '-f', 'lavfi', '-i', SOUND(330), '-f', 'lavfi', '-i', SOUND(440), '-f', 'lavfi', '-i', SOUND(550),
    '-map', '0', '-map', '2', '-map', '1', '-map', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '64k',
    '-metadata:s:a:0', 'language=hin', '-metadata:s:a:1', 'language=eng', '-metadata:s:a:2', 'language=spa',
    '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:a:2', '0',
    '-attach', cover, '-metadata:s:t:0', 'mimetype=image/jpeg', '-metadata:s:t:0', 'filename=cover.jpg', src]);
  let info;
  await check('reads a real video’s tracks', async () => {
    info = await A.list(src);
    assert.deepStrictEqual(info.tracks.map((t) => t.lang + (t.def ? '*' : '')), ['hin*', 'eng', 'spa']);
    assert.strictEqual(info.pics.length, 1, 'and its cover');
    assert.ok(Math.abs(info.secs - 180) < 1);
  });
  await check('a copy with English playing first and Hindi removed: nothing re-encoded, the cover kept, the original untouched', async () => {
    const before = fs.statSync(src).size, out = path.join(tmp, 'eng.mkv');
    await A.apply(src, out, { keep: [1, 2], first: 1 });
    const got = await A.list(out);
    assert.deepStrictEqual(got.tracks.map((t) => t.lang + (t.def ? '*' : '')), ['eng*', 'spa']);
    assert.deepStrictEqual(got.tracks.map((t) => t.codec), ['aac', 'aac']);
    assert.strictEqual(got.pics.length, 1, 'still a cover picture, not a second video track');
    const t = await A.align(src, out, 0);
    assert.ok(t.ok && Math.abs(t.offset) < 0.03, 'still in time: ' + JSON.stringify(t));
    assert.strictEqual(fs.statSync(src).size, before);
    await assert.rejects(A.apply(src, out, { keep: [1], first: 1 }), /exists/i, 'never over a file that’s there');
  });

  // Another copy of the same video: its sound 1.25 s later (another release, in French).
  const other = path.join(tmp, 'other.mkv');
  ff(['-i', src, '-map', '0:a:1', '-af', 'adelay=1250|1250,volume=0.5', '-c:a', 'aac', '-b:a', '64k', '-metadata:s:a:0', 'language=fre', other]);
  let lined;
  await check('lines up another copy’s sound (1.25 s later there), exactly enough to add', async () => {
    lined = await A.align(src, other, 0);
    assert.ok(lined.ok, JSON.stringify(lined));
    assert.ok(Math.abs(lined.offset - -1.25) < 0.05, 'offset ' + lined.offset);
  });
  await check('refuses a European copy (4% faster) and a different cut', async () => {
    const pal = path.join(tmp, 'pal.mka');
    ff(['-i', other, '-af', 'atempo=1.0427', '-c:a', 'aac', '-b:a', '64k', pal]);
    const p = await A.align(src, pal, 0);
    assert.ok(!p.ok && p.pal, JSON.stringify(p));
    const cut = path.join(tmp, 'cut.mka');
    ff(['-i', src, '-filter_complex', '[0:a:1]atrim=0:50,asetpts=PTS-STARTPTS[x];[0:a:1]atrim=90,asetpts=PTS-STARTPTS[y];[x][y]concat=n=2:v=0:a=1[o]', '-map', '[o]', '-c:a', 'aac', '-b:a', '64k', cut]);
    const c = await A.align(src, cut, 0);
    assert.ok(!c.ok, 'a different cut: ' + JSON.stringify(c));
  });
  await check('adds the French track, lined up, playing first', async () => {
    const out = path.join(tmp, 'fre.mkv');
    await A.apply(src, out, { keep: [1], first: 'add', add: { file: other, n: 0, offset: lined.offset, lang: 'fre' } });
    const got = await A.list(out);
    assert.deepStrictEqual(got.tracks.map((t) => t.lang + (t.def ? '*' : '')), ['fre*', 'eng']);
    // Its French track against the original's English, and its English against the original's: both in time.
    const fr = await A.align(src, out, 0), en = await A.align(src, out, 1);
    assert.ok(fr.ok && Math.abs(fr.offset) < 0.05, 'French in time: ' + JSON.stringify(fr));
    assert.ok(en.ok && Math.abs(en.offset) < 0.03, 'English where it was: ' + JSON.stringify(en));
    assert.ok(Math.abs(got.secs - info.secs) < 0.5, 'the same length');
  });
  await check('a loud start turned down and the tracks changed in one copy', async () => {
    const out = path.join(tmp, 'both.mkv');
    await L.apply(src, out, { start: 1, end: 4, gain: -6 }, { keep: [1], first: 1 });
    const got = await A.list(out);
    assert.deepStrictEqual(got.tracks.map((t) => t.lang + (t.def ? '*' : '')), ['eng*']);
    assert.strictEqual(got.pics.length, 1);
  });
  await check('Rename Now: copy keeps the original, move sends it to the bin, Undo removes the new copy', async () => {
    const lib = path.join(tmp, 'lib'); fs.mkdirSync(lib);
    const allowed = new Set([path.resolve(src)]);
    const op = { source: src, folder: ['TV Shows', 'Show', 'Season 01'], file: 'Show - S01E01.mkv', tracks: { keep: [1, 2], first: 1 } };
    const retrack = (a, b, t) => A.apply(a, b, t);
    const j1 = path.join(tmp, 'j1.json');
    let r = await fileops.run([op], { library: lib, mode: 'copy', allowed, retrack, quieten: () => { throw new Error('not this'); }, journalPath: j1 });
    const to = path.join(lib, 'TV Shows', 'Show', 'Season 01', 'Show - S01E01.mkv');
    assert.ok(r.results[0].ok && r.results[0].retracked && fs.existsSync(to) && fs.existsSync(src), JSON.stringify(r.results));
    assert.deepStrictEqual((await A.list(to)).tracks.map((t) => t.lang), ['eng', 'spa']);
    const u = await fileops.undo(j1);
    assert.ok(u.undone === 1 && !fs.existsSync(to) && fs.existsSync(src));
    const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
    r = await fileops.run([op], { library: lib, mode: 'move', allowed, retrack, journalPath: path.join(tmp, 'j2.json'), trash: (p) => fs.promises.rename(p, path.join(bin, path.basename(p))) });
    assert.ok(r.results[0].ok && r.results[0].trashed && fs.existsSync(to) && !fs.existsSync(src), JSON.stringify(r.results));
    r = await fileops.run([Object.assign({}, op, { source: to, tracks: { keep: 'all' } })], { library: path.join(tmp, 'lib2'), mode: 'copy', allowed: new Set([to]), retrack });
    assert.ok(!r.results[0].ok && /Bad sound tracks/.test(r.results[0].error), 'a bad plan from the window is refused');
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(passed + ' sound track checks passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
