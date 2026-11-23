// Checks the bundled ffmpeg + OCR read a (fake) title card on this machine. Run: node tests/scan.test.js
const path = require('path');
const assert = require('assert');
const scan = require('../desktop/scan.js');
const probe = require('../desktop/probe.js');
const P = require('../app/js/parser.js');

(async () => {
  const file = path.join(__dirname, 'fixtures', 'fake-title-card.mkv'); // 30 s, made by us: "Jellyfishing" at 10–14 s
  const secs = await probe.duration(file);
  assert.strictEqual(secs, 30, 'length from the header');
  const titles = ['Help Wanted', 'Jellyfishing', 'Plankton!', 'Jellyfish Jam'].map((name, i) => ({ name, number: i + 1, season: 1 }));
  const t0 = Date.now();
  const r = await scan.scanFile(file, secs, { isMatch: (texts) => !!P.matchCardText(texts, titles) });
  const cold = Date.now() - t0;
  // After a batch the readers stay ready (for a minute in the app), so the next batch starts at once.
  scan.stopOcrSoon();
  assert.ok(scan.readersRunning() > 0, 'readers kept ready after a batch');
  const t1 = Date.now();
  const r2 = await scan.scanFile(file, secs, { isMatch: (texts) => !!P.matchCardText(texts, titles) });
  const warm = Date.now() - t1;
  assert.deepStrictEqual(r2.texts, r.texts, 'same reading with ready readers');
  scan.stopOcrSoon(50);
  await new Promise((res) => setTimeout(res, 300));
  assert.strictEqual(scan.readersRunning(), 0, 'readers stop once the wait is over');
  const found = r.texts.map((t) => P.matchCardText(t.texts, titles)).filter(Boolean).map((m) => m.entry.name);
  console.log('read', r.frames, 'frames in', cold, 'ms (again with ready readers:', warm, 'ms):', JSON.stringify(r.texts.map((t) => t.texts)), '→', found);
  assert.deepStrictEqual(found, ['Jellyfishing']);
  // A part with no fade to black, once the show's card timing is known, used to stop the whole video with an error
  // (nothing read, not a word said).
  const two = await scan.scanFile(file, secs, { maxParts: 2, cardAfterBlack: 1, cardAt: 12, isMatch: (texts) => P.matchCardText(texts, titles) });
  assert.ok(two.texts.some((x) => x.texts.some((t) => /Jellyfishing/i.test(t))), 'still read with a learned card time and no fade');
  // The quick look: the same video with sound, silent from 7.5 to 9 s. A show whose cards come 3 s after a silence has
  // this card read straight away, from one frame, without thumbnails of the video.
  const fs = require('fs'), os = require('os'), { execFileSync } = require('child_process');
  const loud = path.join(os.tmpdir(), 'shelf-test-quiet-' + process.pid + '.mkv');
  execFileSync(scan.ffmpegPath(), ['-v', 'error', '-y', '-i', file, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
    '-af', "volume=enable='between(t,7.5,9)':volume=0", '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', loud]);
  try {
    const gaps = await scan.quietGaps(loud, 0, 30);
    assert.ok(gaps.some((g) => Math.abs(g.a - 7.5) < 0.3 && Math.abs(g.b - 9) < 0.3), 'the silence: ' + JSON.stringify(gaps));
    let fd = null;
    const q = await scan.scanFile(loud, secs, { cardAfterQuiet: [3], isMatch: (texts) => P.matchCardText(texts, titles), onFound: (x) => { fd = x; } });
    assert.ok(q.quickHits === 1 && q.frames === 1, 'read by the quick look, from one frame: ' + JSON.stringify(q));
    assert.ok(fd && Math.abs(fd.afterQuiet - 3) < 0.3, 'how long after the silence the card was: ' + JSON.stringify(fd && fd.afterQuiet));
  } finally { fs.rmSync(loud, { force: true }); }
  await scan.stopOcr(); // (the readers would keep this test running)
  console.log('scan test passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
