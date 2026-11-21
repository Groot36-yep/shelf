// Fetches whisper.cpp (speech recognition: how Shelf listens to the start of an episode to tell which one it
// is) and its small English voice model, for the Windows build. Both come from their official homes:
//   - the engine: the whisper.cpp project's own GitHub release b5454 (the build of version 1.9.5, made by
//     the project's GitHub Actions), file whisper-bin-x64.zip;
//   - the model: ggml-base.en-q5_1.bin from the project author's Hugging Face page (ggerganov/whisper.cpp),
//     at a fixed revision.
// Every file is refused unless it's byte-for-byte the one checked when this version was chosen (SHA-256,
// matching GitHub's and Hugging Face's own records; the engine was also scanned by Windows Defender).
// Puts what Shelf needs in build/bin/whisper/. Run with: node scripts/get-whisper.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ZIP_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
const ZIP_SHA256 = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb';
// Only what the command-line listener needs (the zip also holds demos and tests, which aren't shipped).
const FILES = {
  'whisper-cli.exe': '331dba46d6427105d2b802cdbc7eae916ea1c5abf9b0d3b5cfe460d8db8e4366',
  'whisper.dll': '034396d75bb5720c1851674ff64a96192b58f6927b68d334ebd254ce6cad9674',
  'ggml.dll': '31fe18616d872af9b6134b47a6dff8072ae4ecbe5df0273f4f8dc36766c9db8e',
  'ggml-base.dll': 'bede0d6b2d387236ecd2b5dd676d51c8984b5b6e0ae461a12174e9c01345c5f0',
  // One of these is picked at run time, to suit the computer's processor.
  'ggml-cpu-alderlake.dll': 'd8f5c56ea490394eeae8b271650f2647aecd039a542d6df9e0140726e62a4603',
  'ggml-cpu-cannonlake.dll': '74127b40abd4f595d9db6af0fa313a02e18ff42fc228bfa05281e7c788dd4507',
  'ggml-cpu-cascadelake.dll': '4b11c427b844eeac87529af9a8d94b35aad2024666beb2a35e59fe3077e4b81e',
  'ggml-cpu-haswell.dll': '1306b1014c8118d27234d8ddc0e66ced1f8c8476bf85071595fd182ea9b7263b',
  'ggml-cpu-icelake.dll': '2b4dc4c66e7d8fe2807283816e9cf3b7f7d0556f59df34069871e37eab8aed40',
  'ggml-cpu-sandybridge.dll': '04edbdebc01a1d421062a960881a4f34d520d99693999518243f332406444c6e',
  'ggml-cpu-skylakex.dll': '1774714cf93621406ff35344b54715619a83242ae3e331e44d98a3b35ce801be',
  'ggml-cpu-sse42.dll': 'f060318772c4c2dbac312bbfff6ea700b85dbc502bb38585a7186d06d549301a',
  'ggml-cpu-x64.dll': '4b4b05caba40d4309b5d710ef74c59ba190516b8489f27bdb1ba11ae33c6e9d3'
};
const MODEL = 'ggml-base.en-q5_1.bin';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/' + MODEL;
const MODEL_SHA256 = '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f';
const OUT = path.join(__dirname, '..', 'build', 'bin', 'whisper');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const good = (name, want) => { const f = path.join(OUT, name); return fs.existsSync(f) && sha(fs.readFileSync(f)) === want; };
async function get(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('Download failed (' + r.status + '): ' + url);
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!Object.keys(FILES).every((n) => good(n, FILES[n]))) {
    const zip = await get(ZIP_URL);
    if (sha(zip) !== ZIP_SHA256) throw new Error('whisper.cpp’s download isn’t the expected file (checksum differs). Not used.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
    try {
      const z = path.join(tmp, 'w.zip');
      fs.writeFileSync(z, zip);
      execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'unzip',
        process.platform === 'win32' ? ['-xf', z, '-C', tmp] : ['-q', z, '-d', tmp]);
      for (const [name, want] of Object.entries(FILES)) {
        const bytes = fs.readFileSync(path.join(tmp, 'Release', name));
        if (sha(bytes) !== want) throw new Error(name + ' isn’t the expected file (checksum differs). Not used.');
        fs.writeFileSync(path.join(OUT, name), bytes);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('whisper.cpp 1.9.5 checked and saved to ' + path.relative(process.cwd(), OUT));
  } else console.log('whisper.cpp 1.9.5 already in place');
  if (!good(MODEL, MODEL_SHA256)) {
    const m = await get(MODEL_URL);
    if (sha(m) !== MODEL_SHA256) throw new Error('The voice model isn’t the expected file (checksum differs). Not used.');
    fs.writeFileSync(path.join(OUT, MODEL), m);
    console.log('Voice model checked and saved');
  } else console.log('Voice model already in place');
})().catch((e) => { console.error(e.message); process.exit(1); });
