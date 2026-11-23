// A loud start (a channel's logo before an episode) found and turned down: desktop/loudstart.js and Rename Now.
// node tests/loudstart.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const L = require('../desktop/loudstart');
const fileops = require('../desktop/fileops');
const probe = require('../desktop/probe');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
const FF = require('ffmpeg-static');

(async () => {
  // Readings like a real SpongeBob file's: quiet, a 4-second logo ~10 LU over the show, quiet, then the show.
  const rs = [];
  for (let t = 0.1; t < 30; t += 0.1) rs.push({ t: Math.round(t * 10) / 10, m: t < 1.9 ? -120 : t < 5.6 ? -13 : t < 7.5 ? -60 : -21 });
  await check('a logo much louder than the show is found, with how much to turn it down', () => {
    const q = L.findLoudStart(rs, -23);
    assert.ok(q, 'found');
    assert.ok(Math.abs(q.start - 1.5) <= 0.2 && Math.abs(q.end - 5.6) <= 0.2, JSON.stringify(q));
    assert.strictEqual(q.gain, -9);
  });
  await check('a start about as loud as the show, or one that never goes quiet, is left alone', () => {
    assert.strictEqual(L.findLoudStart(rs, -15), null);
    assert.strictEqual(L.findLoudStart(rs.map((r) => ({ t: r.t, m: r.t < 1.9 ? -120 : -13 })), -23), null);
    assert.strictEqual(L.findLoudStart(rs.map((r) => ({ t: r.t + 14, m: r.m })), -23), null); // starts too late
  });
  await check('only a sane cut is ever applied', () => {
    assert.throws(() => L.checkCut({ start: 2, end: 1, gain: -5 }));
    assert.throws(() => L.checkCut({ start: 0, end: 5, gain: 4 }));
    assert.throws(() => L.checkCut({ start: 0, end: 90, gain: -5 }));
    const args = L.applyArgs('in.mkv', 'out.mkv', { start: 1.5, end: 5.6, gain: -9 }, { codec: 'aac', kbps: 96 });
    assert.ok(args.includes('copy') && args.includes('-n'), 'picture copied, never over a file');
    assert.ok(args.join(' ').includes("volume=volume=-9dB:enable='between(t,1.5,5.6)'"));
  });

  // A real (made-up) video: 1.5 s quiet, a loud 3-second tone, quiet, then a quieter "show" for 2.5 minutes.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-loud-'));
  const src = path.join(tmp, 'in', 'Show S01E01.mkv'); fs.mkdirSync(path.dirname(src));
  execFileSync(FF, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x204060:s=160x90:r=10:d=160',
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,1.5,4.5),0.8*sin(2*PI*600*t),if(gt(t,6.5),0.07*sin(2*PI*330*t),0))':s=48000:d=160",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '96k', '-shortest', src]);
  const secs = await probe.duration(src);
  let cut;
  await check('measured in a real video', async () => {
    cut = await L.measure(src, secs);
    assert.ok(cut, 'found');
    assert.ok(Math.abs(cut.start - 1.5) <= 0.5 && Math.abs(cut.end - 4.6) <= 0.6 && cut.gain <= -5, JSON.stringify(cut));
  });
  await check('turned down in a new copy: same length, the logo no longer loud, the original untouched', async () => {
    const before = fs.statSync(src).size, out = path.join(tmp, 'quiet.mkv');
    await L.apply(src, out, cut);
    assert.strictEqual(fs.statSync(src).size, before);
    assert.ok(Math.abs((await probe.duration(out)) - secs) <= 1);
    assert.strictEqual(await L.measure(out, secs), null);
    await assert.rejects(L.apply(src, out, cut), /exists/i, 'never over a file that’s there');
  });
  await check('Rename Now: copy keeps the original, move sends it to the bin, Undo removes the new copy', async () => {
    const lib = path.join(tmp, 'lib'); fs.mkdirSync(lib);
    const allowed = new Set([path.resolve(src)]);
    const op = { source: src, folder: ['TV Shows', 'Show', 'Season 01'], file: 'Show - S01E01.mkv', quiet: { start: cut.start, end: cut.end, gain: cut.gain } };
    const quieten = (a, b, c) => L.apply(a, b, c);
    const j1 = path.join(tmp, 'j1.json');
    let r = await fileops.run([op], { library: lib, mode: 'copy', allowed, quieten, journalPath: j1 });
    const to = path.join(lib, 'TV Shows', 'Show', 'Season 01', 'Show - S01E01.mkv');
    assert.ok(r.results[0].ok && r.results[0].quieted === cut.gain && fs.existsSync(to) && fs.existsSync(src), JSON.stringify(r.results));
    const u = await fileops.undo(j1);
    assert.ok(u.undone === 1 && !fs.existsSync(to) && fs.existsSync(src));
    const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
    r = await fileops.run([op], { library: lib, mode: 'move', allowed, quieten, journalPath: path.join(tmp, 'j2.json'), trash: (p) => fs.promises.rename(p, path.join(bin, path.basename(p))) });
    assert.ok(r.results[0].ok && r.results[0].trashed && fs.existsSync(to) && !fs.existsSync(src) && fs.existsSync(path.join(bin, 'Show S01E01.mkv')));
    // A bad cut from the window is refused, never applied.
    fs.renameSync(path.join(bin, 'Show S01E01.mkv'), src); fs.unlinkSync(to);
    r = await fileops.run([Object.assign({}, op, { quiet: { start: 0, end: 500, gain: -40 } })], { library: lib, mode: 'copy', allowed, quieten });
    assert.ok(!r.results[0].ok && /Bad loud start/.test(r.results[0].error));
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(passed + ' loud start checks passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
