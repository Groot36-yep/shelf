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
  await scan.stopOcr();
  const found = r.texts.map((t) => P.matchCardText(t.texts, titles)).filter(Boolean).map((m) => m.entry.name);
  console.log('read', r.frames, 'frames in', Date.now() - t0, 'ms:', JSON.stringify(r.texts.map((t) => t.texts)), '→', found);
  assert.deepStrictEqual(found, ['Jellyfishing']);
  console.log('scan test passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
