// Checks the PACKAGED app can read a title card (catches files left out of the installer).
// Run with the app's own runtime, after building:
//   ELECTRON_RUN_AS_NODE=1 dist/win-unpacked/Shelf.exe tests/packaged-scan.test.js
//   ELECTRON_RUN_AS_NODE=1 dist/linux-unpacked/shelf tests/packaged-scan.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const asar = ['win-unpacked', 'linux-unpacked', 'mac/Shelf.app/Contents']
  .map((d) => path.join(ROOT, 'dist', d, 'resources', 'app.asar')).find((p) => fs.existsSync(p));
assert.ok(asar, 'no packaged app found in dist/ (build it first)');
const scan = require(path.join(asar, 'desktop', 'scan.js'));
const P = require(path.join(asar, 'app', 'js', 'parser.js'));

(async () => {
  const titles = ['Help Wanted', 'Jellyfishing', 'Plankton!'].map((name, i) => ({ name, number: i + 1, season: 1 }));
  const r = await scan.scanFile(path.join(__dirname, 'fixtures', 'fake-title-card.mkv'), 30, { isMatch: (texts) => !!P.matchCardText(texts, titles) });
  await scan.stopOcr();
  const found = r.texts.map((t) => P.matchCardText(t.texts, titles)).filter(Boolean).map((m) => m.entry.name);
  assert.deepStrictEqual(found, ['Jellyfishing']);
  console.log('packaged scan test passed (' + path.relative(ROOT, asar) + ')');
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
