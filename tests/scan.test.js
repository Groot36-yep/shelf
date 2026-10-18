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
  console.log('scan test passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
