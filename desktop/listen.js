'use strict';
/**
 * Listening to an episode: what's said in a stretch of it, as text with times.
 * ffmpeg takes the sound of that stretch (16 kHz mono, into a temporary file that's deleted straight away),
 * and whisper.cpp (shipped with Shelf, see scripts/get-whisper.js) turns it into words, on this computer.
 * Nothing is uploaded. Used for shows whose episodes don't show their name (Mythbusters, documentaries,
 * many preschool shows): the words are matched against each episode's description (parser.js matchHeard).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function create(o) {
  // o: { whisperDir, ffmpeg (path), threads? }
  o = Object.assign({}, o, { whisperDir: path.resolve(o.whisperDir) }); // (the engine runs in its own folder)
  const cli = () => path.join(o.whisperDir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  const model = () => path.join(o.whisperDir, 'ggml-base.en-q5_1.bin');
  const ready = () => fs.existsSync(cli()) && fs.existsSync(model());
  const threads = o.threads || Math.max(2, Math.min(8, os.cpus().length - 2));
  let running = new Set();

  function run(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: path.dirname(cmd) });
      running.add(p);
      let err = '';
      p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
      const timer = setTimeout(() => p.kill(), timeoutMs);
      p.on('error', (e) => { clearTimeout(timer); running.delete(p); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer); running.delete(p);
        code === 0 ? resolve() : reject(new Error((err.trim().split('\n').pop() || 'stopped') + ' (' + code + ')'));
      });
    });
  }

  /**
   * src: a file path or a URL ffmpeg can read (a video on the Plex server, through remoteread.js).
   * from, secs: the stretch to listen to. → { text, lines: [{ t, text }] } (t: seconds into the video).
   */
  async function listen(src, from, secs) {
    if (!ready()) throw new Error('Listening isn’t available in this copy of Shelf.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-listen-'));
    try {
      const wav = path.join(dir, 'a.wav'), base = path.join(dir, 'a');
      await run(o.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(Math.max(0, from)), '-t', String(secs), '-i', src,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav], 120000);
      if (!fs.existsSync(wav) || fs.statSync(wav).size < 32000) return { text: '', lines: [] }; // no sound there
      // Its first guess at each word (-bs 1 -bo 1): two to three times quicker than weighing several, and the
      // words come out practically the same, which is all matching needs. -mc 0: each stretch on its own, so it
      // can't get stuck repeating a line.
      await run(cli(), ['-m', model(), '-f', wav, '-t', String(threads), '-l', 'en', '-bs', '1', '-bo', '1', '-mc', '0', '-np', '-oj', '-of', base], Math.max(60000, secs * 2000));
      const j = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
      const lines = (j.transcription || []).map((x) => ({
        t: Math.round((from + ((x.offsets && x.offsets.from) || 0) / 1000) * 10) / 10,
        text: String(x.text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
      })).filter((x) => /[a-z]{2}/i.test(x.text));
      return { text: lines.map((x) => x.text).join(' '), lines };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  function stop() { for (const p of running) { try { p.kill(); } catch (e) { /* gone */ } } running = new Set(); }
  return { ready, listen, stop };
}

module.exports = { create };
