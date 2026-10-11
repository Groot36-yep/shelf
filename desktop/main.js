/*
 * Shelf desktop — main process.
 * Privacy & security: no telemetry, no auto-update calls, no spellcheck downloads,
 * no permissions (camera, mic, location, notifications...), no navigation away from the app,
 * and the window can only ask for the few file actions defined below.
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, safeStorage, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const fileops = require('./fileops');
const probe = require('./probe');
const P = require('../app/js/parser.js');

const APP_ROOT = path.join(__dirname, '..', 'app');
const ORIGIN = 'app://shelf';
const SERVED = new Set(['index.html', 'css', 'js', 'assets']); // the only things the window can load

// A tiny local log of startup steps and errors (never file names or keys), so a launch that
// fails can be diagnosed: %APPDATA%\Shelf\startup.log. It is overwritten on every launch.
let logLines = [];
function log(msg) {
  logLines.push(new Date().toISOString() + ' ' + msg);
  try {
    const p = path.join(app.getPath('userData'), 'startup.log');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, logLines.slice(-200).join('\r\n') + '\r\n');
  } catch (e) { /* logging must never stop the app */ }
}
let started = false; // after the window is up, problems are logged, not shown as "couldn't start"
function fatal(where, err) {
  const text = (err && (err.stack || err.message)) || String(err);
  log('ERROR ' + where + ': ' + text);
  if (started) return;
  try {
    dialog.showErrorBox('Shelf couldn’t start', 'Something went wrong while opening Shelf (' + where + ').\n\n' +
      String((err && err.message) || err).slice(0, 400) + '\n\nDetails were saved to:\n' + path.join(app.getPath('userData'), 'startup.log'));
  } catch (e) { /* ignore */ }
}
process.on('uncaughtException', (e) => fatal('main', e));
process.on('unhandledRejection', (e) => fatal('main', e));
log('Starting Shelf ' + app.getVersion() + ' on ' + process.platform + ' ' + process.getSystemVersion() + ' (Electron ' + process.versions.electron + ')');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
  // The split window's player: plays only the one video you opened it for (by a random token).
  { scheme: 'shelf-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: false } }
]);

// Only one copy of Shelf at a time. A second launch brings the first window to the front.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { log('Another copy is already running; asking it to come to the front.'); app.exit(0); }

let win = null;
const mediaTokens = new Map(); // token → video path, only while its split window is open
const allowedSources = new Set(); // files the user picked; nothing else can be touched
const prefsPath = () => path.join(app.getPath('userData'), 'shelf-prefs.json');
const journalPath = () => path.join(app.getPath('userData'), 'last-rename.json');
// Each key lives in its own encrypted file. Only these names exist.
const SECRETS = { tmdb: 'tmdb-key.bin', tvdb: 'tvdb-key.bin', tvdbPin: 'tvdb-pin.bin' };
const secretPath = (name) => path.join(app.getPath('userData'), SECRETS[name] || SECRETS.tmdb);

function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); } catch (e) { return {}; } }
function writePrefs(p) { fs.mkdirSync(path.dirname(prefsPath()), { recursive: true }); fs.writeFileSync(prefsPath(), JSON.stringify(p)); }

// On Windows the minimise / maximise / close buttons sit inside Shelf's own toolbar.
function overlayColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#232326', symbolColor: '#F2F2F7', height: 52 }
    : { color: '#FBFBFD', symbolColor: '#1D1D1F', height: 52 };
}

function createWindow() {
  const isWin = process.platform === 'win32';
  win = new BrowserWindow({
    ...(isWin ? { titleBarStyle: 'hidden', titleBarOverlay: overlayColors() } : {}),
    width: 1320,
    height: 840,
    minWidth: 760,
    minHeight: 560,
    title: 'Shelf',
    backgroundColor: '#1E1E20',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });
  // Show the window as soon as it's painted — and no matter what after 4 seconds,
  // so Shelf can never be running invisibly.
  const reveal = (why) => {
    if (win && !win.isDestroyed() && !win.isVisible()) { log('Showing window (' + why + ')'); win.show(); win.focus(); }
  };
  win.once('ready-to-show', () => reveal('ready'));
  setTimeout(() => reveal('timeout'), 4000);
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain) { log('Page failed to load: ' + code + ' ' + desc); reveal('load failed'); }
  });
  win.webContents.on('render-process-gone', (e, d) => {
    log('Window process stopped: ' + d.reason + ' (' + d.exitCode + ')');
    if (d.reason !== 'clean-exit' && win && !win.isDestroyed()) win.reload();
  });
  win.webContents.on('did-finish-load', () => log('Page loaded'));
  if (isWin) nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setTitleBarOverlay(overlayColors()); });
  win.loadURL(ORIGIN + '/index.html').catch((e) => log('loadURL: ' + e.message));

  // Never navigate away; open approved web links in the normal browser instead.
  const OK_LINKS = /^https:\/\/(www\.)?(themoviedb\.org|tvmaze\.com|thetvdb\.com|creativecommons\.org|github\.com)\//;
  // (The About screen's "Check for Updates" opens the GitHub releases page here, in your browser.)
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN + '/')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (OK_LINKS.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function fromApp(event) {
  const url = (event.senderFrame && event.senderFrame.url) || '';
  return url.startsWith(ORIGIN + '/');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromApp(event)) throw new Error('Not allowed');
    return fn(...args);
  });
}

if (gotLock) app.whenReady().then(() => {
  log('Electron ready');
  Menu.setApplicationMenu(null);

  // Serve the app's own files, and only those.
  protocol.handle('app', (request) => {
    const u = new URL(request.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const full = path.normalize(path.join(APP_ROOT, rel));
    const top = rel.split('/')[0];
    if (u.host !== 'shelf' || !SERVED.has(top) || !fileops.inside(APP_ROOT, full)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(full).toString());
  });

  // ---- The split window's player: one video, by token, only after you said yes ----
  const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', ts: 'video/mp2t', m2ts: 'video/mp2t', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg' };
  // Picture jobs run a few at a time, in two lanes: single frames (what you're looking at right now)
  // never wait behind film strips. A newer request for the same kind of picture replaces an older one
  // that hasn't started yet (zooming quickly doesn't pile up strips for views you've already left).
  function lane(limit) {
    let running = 0; const queue = [];
    function next() { while (running < limit && queue.length) { const j = queue.shift(); running++; j.go(); } }
    return function run(slot, job) {
      return new Promise((resolve) => {
        if (slot) queue.filter((q) => q.slot === slot).forEach((q) => { queue.splice(queue.indexOf(q), 1); q.resolve(Buffer.alloc(0)); });
        queue.push({ slot, resolve, go: () => job().then(resolve, () => resolve(Buffer.alloc(0))).finally(() => { running--; next(); }) });
        next();
      });
    };
  }
  const frameLane = lane(2), stripLane = lane(2);
  async function frameJpeg(file, t, w) {
    try {
      const { spawn } = require('child_process');
      const ff = require('ffmpeg-static').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      return await new Promise((resolve, reject) => {
        const c = spawn(ff, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-an', '-sn',
          '-vf', 'scale=' + w + ':-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const chunks = []; c.stdout.on('data', (d) => chunks.push(d));
        const timer = setTimeout(() => c.kill(), 20000);
        c.on('error', reject); c.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      });
    } finally { /* lanes handle the limits */ }
  }
  // n evenly spaced frames from `from` to `to`, tiled in one row. key=true decodes only keyframes
  // (much faster for long stretches; each tile is then the nearest keyframe before its time).
  async function stripJpeg(file, from, to, n, w, keyOnly) {
    try {
      const { spawn } = require('child_process');
      const ff = require('ffmpeg-static').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      const fps = n / (to - from);
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'].concat(keyOnly ? ['-skip_frame', 'nokey'] : [],
        ['-ss', String(from), '-t', String(to - from), '-i', file, '-an', '-sn', '-dn',
          // After a seek on the input, timestamps start again at 0, so the frame grid starts at 0 too.
          '-vf', 'fps=' + fps.toFixed(6) + ':start_time=0,scale=' + w + ':-2,tile=' + n + 'x1', '-frames:v', '1',
          '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '6', '-']);
      return await new Promise((resolve, reject) => {
        const c = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const chunks = []; c.stdout.on('data', (d) => chunks.push(d));
        const timer = setTimeout(() => c.kill(), 90000);
        c.on('error', reject); c.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      });
    } finally { /* lanes handle the limits */ }
  }
  // Bytes start..end of a file, read only as fast as the player takes them. (After every jump the
  // player asks for "from here to the end" and soon lets go; reading ahead eagerly would pull the
  // whole rest of the file into memory each time and make every jump slow.)
  function fileStream(file, start, end) {
    let fh = null, pos = start;
    return new ReadableStream({
      type: 'bytes',
      async pull(ctrl) {
        try {
          if (!fh) fh = await fs.promises.open(file, 'r');
          const want = Math.min(256 * 1024, end - pos + 1);
          if (want <= 0) { await fh.close(); fh = null; ctrl.close(); return; }
          const buf = Buffer.alloc(want);
          const { bytesRead } = await fh.read(buf, 0, want, pos);
          if (!bytesRead) { await fh.close(); fh = null; ctrl.close(); return; }
          pos += bytesRead;
          ctrl.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
        } catch (e) { if (fh) { fh.close().catch(() => {}); fh = null; } ctrl.error(e); }
      },
      cancel() { if (fh) { fh.close().catch(() => {}); fh = null; } }
    }, { highWaterMark: 0 });
  }
  protocol.handle('shelf-media', async (request) => {
    const u = new URL(request.url);
    const file = mediaTokens.get(u.pathname.replace(/^\/+/, ''));
    if (!file) return new Response('Not found', { status: 404 });
    if (u.host === 's') { // a film strip: n frames side by side, shelf-media://s/<token>?from=0&to=60&n=12&w=160&key=0
      const from = Math.max(0, Number(u.searchParams.get('from')) || 0), to = Math.max(from + 0.5, Number(u.searchParams.get('to')) || from + 60);
      const n = Math.min(240, Math.max(1, Math.round(Number(u.searchParams.get('n')) || 12)));
      const w = Math.min(320, Math.max(48, Math.round((Number(u.searchParams.get('w')) || 160) / 2) * 2));
      const slot = /^[a-z]{1,8}$/.test(u.searchParams.get('slot') || '') ? u.pathname + ':' + u.searchParams.get('slot') : null;
      const jpg = await stripLane(slot, () => stripJpeg(file, from, to, n, w, u.searchParams.get('key') === '1'));
      return jpg.length ? new Response(jpg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' } }) : new Response('', { status: 404 });
    }
    if (u.host === 'f') { // one still frame: shelf-media://f/<token>?t=12.5&w=320
      const t = Math.max(0, Number(u.searchParams.get('t')) || 0), w = Math.min(1280, Math.max(64, Number(u.searchParams.get('w')) || 320));
      const slot = /^[a-z]{1,8}$/.test(u.searchParams.get('slot') || '') ? u.pathname + ':' + u.searchParams.get('slot') : null;
      const jpg = await frameLane(slot, () => frameJpeg(file, t, Math.round(w / 2) * 2));
      return jpg.length ? new Response(jpg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } }) : new Response('', { status: 404 });
    }
    if (u.host !== 'v') return new Response('Not found', { status: 404 });
    const size = (await fs.promises.stat(file)).size;
    let start = 0, end = size - 1, status = 200;
    const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
    if (m) {
      status = 206;
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); } else { start = Number(m[1]) || 0; if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
      if (start > end || start >= size) return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
    }
    const headers = { 'Content-Type': MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
    if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    return new Response(fileStream(file, start, end), { status, headers });
  });

  // Deny every permission request (camera, microphone, location, notifications, ...).
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  handle('shelf:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose videos', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Videos and subtitles', extensions: ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'webm', 'srt', 'ass', 'ssa', 'sub', 'idx', 'vtt'] }, { name: 'All files', extensions: ['*'] }]
    });
    return r.canceled ? [] : remember(await fileops.expand(r.filePaths));
  });

  handle('shelf:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder of videos', properties: ['openDirectory'] });
    return r.canceled ? [] : remember(await fileops.expand(r.filePaths));
  });

  // Dropped files: the window only knows paths the system handed it for the drop.
  handle('shelf:expandDropped', async (paths) => {
    if (!Array.isArray(paths)) return [];
    return remember(await fileops.expand(paths.filter((p) => typeof p === 'string' && path.isAbsolute(p)).slice(0, 500)));
  });

  handle('shelf:version', async () => app.getVersion());
  handle('shelf:getLibrary', async () => readPrefs().library || '');
  handle('shelf:pickLibrary', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose your Plex library folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    const p = readPrefs(); p.library = r.filePaths[0]; writePrefs(p);
    return p.library;
  });

  handle('shelf:rename', async (ops, mode) => {
    const library = readPrefs().library;
    if (!library || !fs.existsSync(library)) throw new Error('Choose your library folder first.');
    if (!Array.isArray(ops)) throw new Error('Nothing to rename.');
    const { results } = await fileops.run(ops.slice(0, 20000), {
      library, mode, allowed: allowedSources, journalPath: journalPath(),
      writePiece: (from, start, end, to) => require('./split').writePiece(from, start, end, to),
      onProgress: (p) => { if (win && !win.isDestroyed()) win.webContents.send('shelf:progress', p); }
    });
    // A moved file's old path is gone; its new path can be renamed again later.
    // A moved file's old path is gone; its new path can be renamed again later.
    // (A split leaves the original where it was, so it stays allowed.)
    results.forEach((r) => { if (r.ok && r.to && mode === 'move' && !r.split) { allowedSources.delete(path.resolve(r.source)); allowedSources.add(r.to); } });
    return results;
  });

  handle('shelf:canUndo', async () => { const j = await fileops.readJournal(journalPath()); return !!(j && j.done && j.done.length); });
  handle('shelf:undo', async () => {
    const r = await fileops.undo(journalPath());
    (r.restored || []).forEach((p) => allowedSources.add(path.resolve(p))); // files put back can be renamed again
    return { undone: r.undone, kept: r.kept, nothing: !!r.nothing };
  });
  // Frames per second (for frame-by-frame stepping), from ffmpeg's description of the file.
  async function frameRate(file) {
    try {
      const { spawn } = require('child_process');
      const ff = require('ffmpeg-static').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      const err = await new Promise((resolve) => {
        const c = spawn(ff, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let e = ''; c.stderr.on('data', (d) => { if (e.length < 20000) e += d; });
        c.on('close', () => resolve(e)); c.on('error', () => resolve(''));
      });
      const m = err.match(/,\s*([\d.]+)\s*fps/) || err.match(/,\s*([\d.]+)\s*tbr/);
      const f = m ? parseFloat(m[1]) : 0;
      return f > 5 && f < 121 ? f : 24;
    } catch (e) { return 24; }
  }

  // ---- Looking inside videos: only files you picked, only after you say yes in a system prompt ----
  function pickedVideos(paths) {
    if (!Array.isArray(paths)) return [];
    const seen = new Set();
    return paths.map((p) => (typeof p === 'string' ? path.resolve(p) : ''))
      .filter((p) => p && allowedSources.has(p) && P.VIDEO_EXT.includes(path.extname(p).slice(1).toLowerCase()) && !seen.has(p) && seen.add(p))
      .slice(0, 2000);
  }
  async function askFirst(files, title, detail, okLabel) {
    const names = files.slice(0, 12).map((f) => '•  ' + path.basename(f)).join('\n') + (files.length > 12 ? '\n…and ' + (files.length - 12) + ' more' : '');
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: [okLabel, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'Shelf', message: title, detail: detail + '\n\n' + names
    });
    return r.response === 0;
  }

  handle('shelf:checkLengths', async (paths) => {
    const files = pickedVideos(paths);
    if (!files.length) return {};
    const yes = await askFirst(files, 'Check how long ' + (files.length === 1 ? 'this video is' : 'these ' + files.length + ' videos are') + '?',
      'Shelf reads only the small part of each file that says how long it is, not the picture or sound. Nothing leaves this computer.', 'Check Lengths');
    if (!yes) return null;
    const out = {};
    for (let i = 0; i < files.length; i += 8) {
      const chunk = files.slice(i, i + 8);
      const secs = await Promise.all(chunk.map((f) => probe.duration(f)));
      chunk.forEach((f, k) => { out[f] = secs[k]; });
    }
    return out;
  });

  // Videos you agreed Shelf may look inside (to read title cards), this session only. For these,
  // Shelf can also show you the frame of a title card it read, and find where to split.
  const lookApproved = new Set();
  // The frame of a title card Shelf read (a small JPEG, straight to this window; never saved).
  handle('shelf:cardFrame', async (p, t, w) => {
    const f = path.resolve(String(p));
    if (!lookApproved.has(f) || !pickedVideos([f]).length) return null;
    const jpg = await frameLane(null, () => frameJpeg(f, Math.max(0, Number(t) || 0), Math.min(640, Math.max(160, Math.round((Number(w) || 320) / 2) * 2))));
    return jpg && jpg.length ? new Uint8Array(jpg) : null;
  });
  // Where to split a video Shelf already looked inside (hints as in splitSuggest). Asks first otherwise.
  handle('shelf:suggestCuts', async (p, hints) => {
    const files = pickedVideos([p]);
    if (!files.length || !Array.isArray(hints)) throw new Error('Not a video you picked');
    const f = files[0];
    if (!lookApproved.has(f) && !approvedMedia.has(f)) {
      const yes = await askFirst([f], 'Find where to split this video?', 'Shelf looks for the black, silent moment between the episodes, here on this computer. Nothing is changed until you click Rename Now, and your original file is always kept.', 'Find Split');
      if (!yes) return null;
      lookApproved.add(f);
    }
    const split = require('./split');
    const out = [];
    for (const h of hints.slice(0, 5)) {
      if (h && Number.isFinite(h.card)) out.push(Object.assign({ from: 'card' }, await split.cutBefore(f, h.card)));
      else if (h && Number.isFinite(h.est)) out.push(Object.assign({ from: 'estimate' }, await split.cutNear(f, h.est)));
      else out.push(null);
    }
    return { cuts: out, secs: await probe.duration(f) };
  });
  let cardCancel = false;
  handle('shelf:cancelCards', async () => { cardCancel = true; return true; });
  // jobs: [{ path, titles: [episode titles of that show] }]
  handle('shelf:readCards', async (jobs, how) => {
    if (!Array.isArray(jobs)) return {};
    const deep = !!(how && how.deep);
    const titlesFor = new Map(jobs.filter((j) => j && typeof j.path === 'string').map((j) => [path.resolve(j.path), Array.isArray(j.titles) ? j.titles.map(String).slice(0, 3000) : []]));
    const nearFor = new Map(jobs.filter((j) => j && typeof j.path === 'string').map((j) => [path.resolve(j.path), new Set(Array.isArray(j.near) ? j.near.map(String).slice(0, 200) : [])]));
    const files = pickedVideos([...titlesFor.keys()]);
    if (!files.length) return {};
    const yes = deep
      ? await askFirst(files, 'Deep scan ' + (files.length === 1 ? 'this video' : 'these ' + files.length + ' videos') + ' for title cards?',
        'Shelf takes a much closer look at the still frames where a title card could be, reading each one many ways, here on this computer. Nothing is uploaded, and the frames are deleted straight away. It can take a few minutes per video.', 'Deep Scan')
      : await askFirst(files, 'Read the title cards of ' + (files.length === 1 ? 'this video' : 'these ' + files.length + ' videos') + '?',
        'Shelf looks at a few still frames from each video and reads the words on them, here on this computer, to find out which episodes it holds. Nothing is uploaded, and the frames are deleted straight away. It takes roughly 5–30 seconds per video.', 'Read Title Cards');
    if (!yes) return null;
    files.forEach((f) => lookApproved.add(f)); // you said yes to Shelf looking inside these
    const scan = require('./scan'); // loaded only when you use it
    cardCancel = false;
    const send = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('shelf:cardProgress', msg); };
    const out = {};
    send({ kind: 'queue', paths: files, total: files.length });
    try {
      for (let i = 0; i < files.length && !cardCancel; i++) {
        const f = files[i];
        const entries = titlesFor.get(f).map((name, n) => ({ name, number: n + 1, season: 1 }));
        const near = entries.filter((e) => nearFor.get(f).has(e.name));
        const secs = await probe.duration(f);
        send({ kind: 'start', path: f, index: i, total: files.length, file: path.basename(f) });
        let last = 0;
        try {
          const r = await scan.scanFile(f, secs, {
            deep,
            isMatch: (texts) => P.matchCardText(texts, entries, near),
            cancelled: () => cardCancel,
            // What Shelf is looking at right now (a small picture, only sent to this window) and what it found.
            onPeek: (pk) => send({ kind: 'peek', path: f, index: i, total: files.length, t: pk.t, part: pk.part, image: { w: pk.image.w, h: pk.image.h, data: pk.image.data } }),
            onFound: (fd) => send({ kind: 'found', path: f, index: i, total: files.length, t: fd.t, part: fd.part, title: fd.hit.entry.name }),
            onProgress: (frac) => { const now = Date.now(); if (now - last > 150 || frac >= 1) { last = now; send({ kind: 'step', path: f, index: i, total: files.length, frac }); } }
          });
          out[f] = { secs, parts: scan.windowsFor(secs).length, texts: r.texts };
        } catch (e) {
          out[f] = { secs, error: String(e.message || e).slice(0, 200) };
        }
        send({ kind: 'file', path: f, index: i, total: files.length, result: out[f], stopped: cardCancel });
      }
    } finally {
      await scan.stopOcr();
      send({ kind: 'end', total: files.length, stopped: cardCancel });
    }
    return out;
  });

  // ---- Split window ----
  // also: other videos you'll step through with "Save & Next" — asked about together, once.
  const approvedMedia = new Set();
  handle('shelf:openSplit', async (p, also) => {
    const files = pickedVideos([p]);
    if (!files.length) throw new Error('Not a video you picked');
    if (approvedMedia.has(files[0])) {
      const token0 = crypto.randomBytes(16).toString('hex');
      mediaTokens.set(token0, files[0]);
      return { token: token0, secs: await probe.duration(files[0]), fps: await frameRate(files[0]) };
    }
    const batch = pickedVideos([p].concat(Array.isArray(also) ? also.slice(0, 500) : []));
    const yes = await askFirst(batch, batch.length > 1 ? 'Open these ' + batch.length + ' videos to check their episodes?' : 'Open this video to check its episodes?',
      'Shelf plays the video in its own window so you can see which episodes it holds, check where each one starts, and split it if you want. Nothing is changed until you click Rename Now, your original file is always kept, and nothing leaves this computer.', 'Open Video');
    if (!yes) return null;
    batch.forEach((f) => approvedMedia.add(f)); // "Save & Next" won't ask again for these
    const token = crypto.randomBytes(16).toString('hex');
    mediaTokens.set(token, files[0]);
    return { token, secs: await probe.duration(files[0]), fps: await frameRate(files[0]) };
  });
  // endBatch: you closed the window (not "Save & Next"), so the next video asks again.
  handle('shelf:closeSplit', async (token, endBatch) => { mediaTokens.delete(String(token)); if (endBatch !== false) approvedMedia.clear(); return true; });
  // Suggested cuts. hints: [{ card: seconds } | { est: seconds }], one per cut.
  handle('shelf:splitSuggest', async (token, hints) => {
    const file = mediaTokens.get(String(token));
    if (!file || !Array.isArray(hints)) throw new Error('This split window has closed');
    const split = require('./split');
    const out = [];
    for (const h of hints.slice(0, 5)) {
      if (h && Number.isFinite(h.card)) out.push(Object.assign({ from: 'card' }, await split.cutBefore(file, h.card)));
      else if (h && Number.isFinite(h.est)) out.push(Object.assign({ from: 'estimate' }, await split.cutNear(file, h.est)));
      else out.push(null);
    }
    return out;
  });
  // Lossless cuts land on keyframes: the keyframes and quiet moments around a time.
  handle('shelf:splitAround', async (token, t) => {
    const file = mediaTokens.get(String(token));
    if (!file) throw new Error('This split window has closed');
    t = Number(t) || 0;
    return require('./split').quietAndKeys(file, Math.max(0, t - 20), t + 20);
  });

  handle('shelf:showInFolder', async () => { const lib = readPrefs().library; if (lib) shell.openPath(lib); });

  // Keys (TMDB, TheTVDB) are encrypted with your Windows account (DPAPI) / macOS Keychain before they're saved.
  const keyName = (n) => (Object.prototype.hasOwnProperty.call(SECRETS, n) ? n : 'tmdb');
  handle('shelf:getKey', async (name) => {
    try {
      const buf = fs.readFileSync(secretPath(keyName(name)));
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : '';
    } catch (e) { return ''; }
  });
  handle('shelf:setKey', async (name, key) => {
    const file = secretPath(keyName(name));
    key = typeof key === 'string' ? key.trim().slice(0, 600) : '';
    if (!key) { fs.rmSync(file, { force: true }); return true; }
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, safeStorage.encryptString(key));
    return true;
  });
  handle('shelf:eraseAll', async () => {
    for (const p of Object.keys(SECRETS).map(secretPath).concat([prefsPath(), journalPath()])) fs.rmSync(p, { force: true });
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    return true;
  });

  createWindow();
  started = true;
  log('Window created');
}).catch((e) => fatal('startup', e));

function remember(list) {
  list.forEach((f) => allowedSources.add(path.resolve(f.fullPath)));
  return list;
}

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
app.on('window-all-closed', () => app.quit());
