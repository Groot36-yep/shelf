// Decoding on the graphics card for the title-card scan: when it's used, and that it finds the same
// still moments as the processor (or quietly falls back when there's no card it can use).
//   node tests/hwaccel.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const H = require('../desktop/hwaccel.js');
const scan = require('../desktop/scan.js');

(async () => {
  let n = 0;
  const ok = (msg) => { n++; console.log('  ✓ ' + msg); };

  const hevc = H.parseInfo('  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 24 fps\n');
  assert.deepStrictEqual(hevc, { codec: 'hevc', width: 1920, height: 1080, bits: 10 });
  const sb = H.parseInfo('  Stream #0:0: Video: h264 (High), yuv420p(progressive), 948x720, SAR 1:1 DAR 79:60, 23.98 fps\n  Stream #0:3: Video: mjpeg (Progressive), yuvj444p(pc), 217x118, 90k tbr (attached pic)\n');
  assert.deepStrictEqual(sb, { codec: 'h264', width: 948, height: 720, bits: 8 });
  const uhd = H.parseInfo('  Stream #0:0(eng): Video: h264 (High), yuv420p, 3840x2160, 24 fps\n');
  assert.ok(H.heavy(hevc) && H.heavy(uhd) && !H.heavy(sb));
  ok('reads the codec and size; HEVC and 4K count as heavy, a 720p H.264 TV rip doesn’t');

  // A short HEVC clip with still moments (made with the bundled ffmpeg).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-hw-'));
  const clip = path.join(tmp, 'clip.mkv');
  execFileSync(scan.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=1280x720:rate=24:duration=6,format=yuv420p[a];color=c=navy:size=1280x720:rate=24:duration=4,drawtext=text=TITLE:fontsize=120:fontcolor=white:x=400:y=300[b];[a][b]concat=n=2:v=1',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', clip], { stdio: 'ignore' });

  H.setMode('off');
  assert.strictEqual(await H.thumbPlan(clip, 2, 96, 72), null);
  const cpu = await scan.stills(clip, 0, 10);
  H.setMode('auto');
  const plan = await H.thumbPlan(clip, 2, 96, 72);
  const gpu = await scan.stills(clip, 0, 10);
  const st = await H.status();
  const near = (a, b) => a.length === b.length && a.every((r, i) => Math.abs(r.t - b[i].t) <= 0.5);
  assert.ok(cpu.length >= 1, 'the still title card is found');
  assert.ok(near(cpu, gpu), 'same still moments: ' + JSON.stringify(cpu) + ' vs ' + JSON.stringify(gpu));
  if (plan && st.used) ok('graphics card (' + st.used + ') finds the same still moments as the processor');
  else ok('no graphics card usable here (' + (st.available.join(', ') || 'none') + '): the processor did it, same result');

  // Every way to use the card fails: the scan still works, on the processor.
  H.failed('cuda'); H.failed('d3d11va');
  assert.strictEqual(await H.thumbPlan(clip, 2, 96, 72), null);
  assert.ok(near(cpu, await scan.stills(clip, 0, 10)));
  ok('when the card fails, the processor takes over');

  // Reading text side by side gives the same texts, in order.
  const img = (await scan.frameVariants(clip, 8, false)).slice(0, 3);
  const one = []; for (const im of img) one.push(await scan.readText(im));
  assert.deepStrictEqual(await scan.readMany(img), one);
  assert.ok(one.some((t) => /TITLE/.test(t)), 'reads the title: ' + JSON.stringify(one));
  await scan.stopOcr();
  ok('text read side by side (' + scan.OCR_READERS + ' readers) matches reading one at a time');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(n + ' graphics card / speed checks passed');
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
