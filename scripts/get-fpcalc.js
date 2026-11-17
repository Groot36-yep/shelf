// Fetches Chromaprint's fpcalc (the tool that turns a song's sound into an AcoustID fingerprint) for the
// Windows build, from the official AcoustID project on GitHub, and refuses it unless it's byte-for-byte the
// file checked when this version was chosen. Puts fpcalc.exe in build/bin/.
// Run with: node scripts/get-fpcalc.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VERSION = '1.6.2';
const URL = 'https://github.com/acoustid/chromaprint/releases/download/v' + VERSION + '/chromaprint-fpcalc-' + VERSION + '-windows-x86_64.zip';
// Checked by hand when this version was chosen (and the same as GitHub's record of the file):
const ZIP_SHA256 = 'b74369726676670af3ab0eadff45f960cf969fdf4a87a971ba37eaf8d530e874';
const EXE_SHA256 = '1fff0e00387ae96eb461f9913511e3adfd4f634cf80c67c761fc88f69027251e';
const OUT = path.join(__dirname, '..', 'build', 'bin', 'fpcalc.exe');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  if (fs.existsSync(OUT) && sha(fs.readFileSync(OUT)) === EXE_SHA256) { console.log('fpcalc ' + VERSION + ' already in place'); return; }
  const r = await fetch(URL);
  if (!r.ok) throw new Error('Download failed: ' + r.status);
  const zip = Buffer.from(await r.arrayBuffer());
  if (sha(zip) !== ZIP_SHA256) throw new Error('The download isn’t the expected file (checksum differs). Not used.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpcalc-'));
  try {
    const z = path.join(tmp, 'fpcalc.zip');
    fs.writeFileSync(z, zip);
    // Windows' own tar reads zip files.
    execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'unzip', process.platform === 'win32' ? ['-xf', z, '-C', tmp] : ['-q', z, '-d', tmp]);
    const exe = path.join(tmp, 'chromaprint-fpcalc-' + VERSION + '-windows-x86_64', 'fpcalc.exe');
    const bytes = fs.readFileSync(exe);
    if (sha(bytes) !== EXE_SHA256) throw new Error('fpcalc.exe isn’t the expected file (checksum differs). Not used.');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, bytes);
    console.log('fpcalc ' + VERSION + ' checked and saved to ' + path.relative(process.cwd(), OUT));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
