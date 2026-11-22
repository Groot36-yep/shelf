// Listening to an episode (desktop/listen.js, whisper.cpp): a short video with a spoken intro (made with
// Windows' own speech voice) is heard and matched to the right episode. Needs build/bin/whisper (from
// scripts/get-whisper.js); skipped (and says so) where that or the speech voice isn't there.
// Run with: node tests/listen.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const P = require('../app/js/parser.js');

const WHISPER = path.join(__dirname, '..', 'build', 'bin', 'whisper');
const ffmpeg = require('ffmpeg-static');
const L = require('../desktop/listen.js').create({ whisperDir: WHISPER, ffmpeg });

(async () => {
  if (!L.ready()) { console.log('Listening not set up here (run node scripts/get-whisper.js): skipped'); return; }
  if (process.platform !== 'win32') { console.log('No speech voice to make the test video with here: skipped'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-listen-test-'));
  try {
    const wav = path.join(dir, 'intro.wav'), video = path.join(dir, 'Show S01 E01.mkv');
    const said = 'On this episode, the team finds out whether a penny dropped from the top of the Empire State Building can kill a person. ' +
      'Then they cook a raw egg in a tanning booth, and test if dental fillings can pick up radio stations.';
    // Windows' own speech voice says it into a file.
    const ps = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; ' +
      '$s.SetOutputToWaveFile($env:SHELF_WAV); $s.Speak($env:SHELF_SAY); $s.Dispose()';
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: Object.assign({}, process.env, { SHELF_WAV: wav, SHELF_SAY: said }), stdio: 'ignore', timeout: 60000 }); } catch (e) { /* below */ }
    if (!fs.existsSync(wav)) { console.log('Windows’ speech voice isn’t available here: skipped'); return; }
    // A video: 3 seconds of quiet, then the intro, over a black picture.
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x180:r=10', '-i', wav,
      '-filter_complex', '[1:a]adelay=3000|3000,apad=pad_dur=2[a]', '-map', '0:v', '-map', '[a]', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-y', video]);
    const t0 = Date.now();
    const heard = await L.listen(video, 0, 150);
    console.log('  heard in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s: ' + heard.text.slice(0, 120) + '…');
    assert.match(heard.text, /penny/i); assert.match(heard.text, /tanning/i);
    assert.ok(heard.lines.length > 1 && heard.lines.every((l, k) => l.t >= 0 && (!k || l.t >= heard.lines[k - 1].t)), 'each line has its time: ' + JSON.stringify(heard.lines));
    const list = [
      { season: 2, number: 3, name: 'Barrel of Bricks', about: 'Can a bricklayer hoisting a barrel of bricks with a pulley fall and hit a man multiple times? Can urinating on the third rail electrocute you?' },
      { season: 2, number: 4, name: 'Penny Drop, Microwave Madness!, Radio Fillings', about: 'Will a penny dropped from the top of the Empire State Building kill a person? Can a person be cooked from the inside by a tanning booth? Can dental fillings receive radio signals?' },
      { season: 2, number: 5, name: 'Buried Alive, 101 Uses for Cola', about: 'Can a person survive being buried alive? Does cola clean like a household cleaner?' }
    ];
    const m = P.matchHeard(heard, list);
    assert.ok(m && m.entry.number === 4, 'matched: ' + JSON.stringify(m && m.entry));
    console.log('  ✓ recognised as S02E04 “' + m.entry.name + '” from “' + (m.line && m.line.text) + '”');
    // Quiet video: nothing heard, no answer.
    const quiet = path.join(dir, 'quiet.mkv');
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x180:r=10:d=20', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '20', '-c:v', 'libx264', '-c:a', 'aac', '-y', quiet]);
    const q = await L.listen(quiet, 0, 150);
    assert.strictEqual(P.matchHeard(q, list), null, 'nothing said: no answer (' + q.text + ')');
    console.log('  ✓ a quiet video gives no answer');
    console.log('Listening test passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
