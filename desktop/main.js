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
const { Readable } = require('stream');
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
  let frameJobs = 0; const frameWaiters = [];
  async function frameJpeg(file, t, w) {
    if (frameJobs >= 3) await new Promise((r) => frameWaiters.push(r));
    frameJobs++;
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
    } finally { frameJobs--; const n = frameWaiters.shift(); if (n) n(); }
  }
  protocol.handle('shelf-media', async (request) => {
    const u = new URL(request.url);
    const file = mediaTokens.get(u.pathname.replace(/^\/+/, ''));
    if (!file) return new Response('Not found', { status: 404 });
    if (u.host === 'f') { // one still frame: shelf-media://f/<token>?t=12.5&w=320
      const t = Math.max(0, Number(u.searchParams.get('t')) || 0), w = Math.min(1280, Math.max(64, Number(u.searchParams.get('w')) || 320));
      const jpg = await frameJpeg(file, t, Math.round(w / 2) * 2);
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
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status, headers });
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
    results.forEach((r) => { if (r.ok && r.to && mode === 'move') { allowedSources.delete(path.resolve(r.source)); allowedSources.add(r.to); } });
    return results;
  });

  handle('shelf:canUndo', async () => { const j = await fileops.readJournal(journalPath()); return !!(j && j.done && j.done.length); });
  handle('shelf:undo', async () => {
    const r = await fileops.undo(journalPath());
    (r.restored || []).forEach((p) => allowedSources.add(path.resolve(p))); // files put back can be renamed again
    return { undone: r.undone, kept: r.kept, nothing: !!r.nothing };
  });
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

  let cardCancel = false;
  handle('shelf:cancelCards', async () => { cardCancel = true; return true; });
  // jobs: [{ path, titles: [episode titles of that show] }]
  handle('shelf:readCards', async (jobs) => {
    if (!Array.isArray(jobs)) return {};
    const titlesFor = new Map(jobs.filter((j) => j && typeof j.path === 'string').map((j) => [path.resolve(j.path), Array.isArray(j.titles) ? j.titles.map(String).slice(0, 3000) : []]));
    const files = pickedVideos([...titlesFor.keys()]);
    if (!files.length) return {};
    const yes = await askFirst(files, 'Read the title cards of ' + (files.length === 1 ? 'this video' : 'these ' + files.length + ' videos') + '?',
      'Shelf looks at a few still frames from each video and reads the words on them, here on this computer, to find out which episodes it holds. Nothing is uploaded, and the frames are deleted straight away. It takes roughly 5–30 seconds per video.', 'Read Title Cards');
    if (!yes) return null;
    const scan = require('./scan'); // loaded only when you use it
    cardCancel = false;
    const send = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('shelf:cardProgress', msg); };
    const out = {};
    send({ kind: 'queue', paths: files, total: files.length });
    try {
      for (let i = 0; i < files.length && !cardCancel; i++) {
        const f = files[i];
        const entries = titlesFor.get(f).map((name, n) => ({ name, number: n + 1, season: 1 }));
        const secs = await probe.duration(f);
        send({ kind: 'start', path: f, index: i, total: files.length, file: path.basename(f) });
        let last = 0;
        try {
          const r = await scan.scanFile(f, secs, {
            isMatch: (texts) => !!P.matchCardText(texts, entries),
            cancelled: () => cardCancel,
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
  handle('shelf:openSplit', async (p) => {
    const files = pickedVideos([p]);
    if (!files.length) throw new Error('Not a video you picked');
    const yes = await askFirst(files, 'Open this video to choose where to split it?',
      'Shelf plays the video in its own window and looks for the quiet, black moment between cartoons to suggest a cut. Nothing is changed until you click Rename Now, and your original file is always kept. Nothing leaves this computer.', 'Open Video');
    if (!yes) return null;
    const token = crypto.randomBytes(16).toString('hex');
    mediaTokens.set(token, files[0]);
    return { token, secs: await probe.duration(files[0]) };
  });
  handle('shelf:closeSplit', async (token) => { mediaTokens.delete(String(token)); return true; });
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
