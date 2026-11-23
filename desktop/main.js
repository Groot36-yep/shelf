/*
 * Shelf desktop — main process.
 * Privacy & security: no telemetry, no automatic update checks (only when you click Check for Updates),
 * no spellcheck downloads,
 * no permissions (camera, mic, location, notifications...), no navigation away from the app,
 * and the window can only ask for the few file actions defined below.
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, safeStorage, Menu, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const fileops = require('./fileops');
const appicon = require('./appicon');
const probe = require('./probe');
const P = require('../app/js/parser.js');
// Title-card reading (and its text readers) is loaded the first time you use it.
let scanLoaded = null;
function scanner() { return scanLoaded || (scanLoaded = require('./scan')); }

const APP_ROOT = path.join(__dirname, '..', 'app');
const ORIGIN = 'app://shelf';
const SERVED = new Set(['index.html', 'consent.html', 'css', 'js', 'assets']); // the only things Shelf's windows can load

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
// Undo history: one record per Rename Now, newest last; Undo puts back the newest, then the one before.
// (Shelf 2.1 and earlier kept only last-rename.json; it's read as the oldest record.)
const HISTORY_MAX = 50;
const legacyJournal = () => path.join(app.getPath('userData'), 'last-rename.json');
const historyDir = () => path.join(app.getPath('userData'), 'history');
function historyFiles() {
  let names = [];
  try { names = fs.readdirSync(historyDir()).filter((n) => /^\d{13}-\d{1,6}\.json$/.test(n)).sort(); } catch (e) { /* none yet */ }
  const files = names.map((n) => path.join(historyDir(), n));
  return fs.existsSync(legacyJournal()) ? [legacyJournal()].concat(files) : files;
}
let batchSeq = 0;
function newJournalPath() {
  fs.mkdirSync(historyDir(), { recursive: true });
  const old = historyFiles();
  old.slice(0, Math.max(0, old.length - (HISTORY_MAX - 1))).forEach((f) => { fs.rmSync(f, { force: true }); fs.rmSync(f + '.covers', { recursive: true, force: true }); });
  return path.join(historyDir(), Date.now() + '-' + (++batchSeq % 1e6) + '.json');
}
async function newestUndoable() {
  const files = historyFiles();
  for (let i = files.length - 1; i >= 0; i--) {
    const j = await fileops.readJournal(files[i]);
    if (j && j.done && j.done.length) return files[i];
    fs.rmSync(files[i], { force: true }); // empty or unreadable: nothing to put back
  }
  return null;
}
// Each key lives in its own encrypted file. Only these names exist.
const SECRETS = { tmdb: 'tmdb-key.bin', tvdb: 'tvdb-key.bin', tvdbPin: 'tvdb-pin.bin', acoustid: 'acoustid-key.bin' };
const secretPath = (name) => path.join(app.getPath('userData'), SECRETS[name] || SECRETS.tmdb);

function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); } catch (e) { return {}; } }
function writePrefs(p) { fs.mkdirSync(path.dirname(prefsPath()), { recursive: true }); fs.writeFileSync(prefsPath(), JSON.stringify(p)); }
// What reading title cards taught Shelf about each show (when its cards come, whether it has any), kept between scans:
// the next folder of a show starts already knowing it, and it keeps getting better the more of the show is read.
// Only timings, counts and the show's usual words (said, and on screen), by the show's name; at most the 200 shows read last.
const learnedPath = () => path.join(app.getPath('userData'), 'learned-cards.json');
function readLearned() { try { const j = JSON.parse(fs.readFileSync(learnedPath(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
function writeLearned(all) {
  const keep = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0)).slice(0, 200);
  const tmp = learnedPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]]))));
  fs.renameSync(tmp, learnedPath());
}
// The app icon styles (see appicon.js). Shortcuts are changed only for installed Shelf (or a test's own).
function shortcutsOk() {
  if (process.platform !== 'win32') return false;
  if (!app.isPackaged) return !!(global.__shelfShortcutLinks);
  return !process.env.PORTABLE_EXECUTABLE_DIR;
}
let appIconsMade = null;
function appIcons() {
  return appIconsMade || (appIconsMade = appicon.create({
    shell, nativeImage, dir: app.getPath('userData'), exe: () => process.execPath, canShortcuts: shortcutsOk,
    links: () => (!app.isPackaged && global.__shelfShortcutLinks) || appicon.shortcutPaths(app)
  }));
}

// The look you chose (Studio or Living Room), remembered so the window opens in it.
let theme = 'studio';
try { theme = readPrefs().theme === 'seventies' ? 'seventies' : 'studio'; } catch (e) { /* default */ }
// On Windows the minimise / maximise / close buttons sit inside Shelf's own toolbar.
function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  // Living Room: the buttons sit on the chocolate top bar.
  if (theme === 'seventies') return { color: '#2E1B11', symbolColor: '#F3E2BE', height: 52 };
  return dark ? { color: '#12100E', symbolColor: '#F3EEE7', height: 52 } : { color: '#F4F1EC', symbolColor: '#1F1A15', height: 52 };
}
// The window's own buttons take the colour of whatever is under them (sent by the page).
let barColor = null;
function overlayNow() { return Object.assign(overlayColors(), barColor || {}); }
function windowColor() {
  const dark = nativeTheme.shouldUseDarkColors;
  return theme === 'seventies' ? (dark ? '#17100B' : '#E8DCC6') : (dark ? '#12100E' : '#F4F1EC');
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
    backgroundColor: windowColor(),
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
  // A crashed window is reloaded, but at most twice a minute: a window that crashes as it opens
  // gets an error message instead of a reload loop.
  const crashes = [];
  win.webContents.on('render-process-gone', (e, d) => {
    log('Window process stopped: ' + d.reason + ' (' + d.exitCode + ')');
    if (d.reason === 'clean-exit' || !win || win.isDestroyed()) return;
    const now = Date.now();
    while (crashes.length && now - crashes[0] > 60000) crashes.shift();
    crashes.push(now);
    if (crashes.length <= 2) { win.reload(); return; }
    dialog.showErrorBox('Shelf stopped working', 'Shelf’s window stopped (' + d.reason + ') several times in a row.\n\nDetails were saved to:\n' + path.join(app.getPath('userData'), 'startup.log'));
    app.quit();
  });
  win.webContents.on('did-finish-load', () => log('Page loaded'));
  if (isWin) nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setTitleBarOverlay(overlayNow()); });
  win.loadURL(ORIGIN + '/index.html').catch((e) => log('loadURL: ' + e.message));
  // The icon style you chose (Settings → Look): on the window, and on the shortcuts again in case an update reset them.
  try { const used = readPrefs().appIconUsed; if (used) appIcons().apply(used, win); } catch (e) { log('App icon: ' + e.message); }

  // Never navigate away; open approved web links in the normal browser instead.
  const OK_LINKS = /^https:\/\/(www\.)?(themoviedb\.org|tvmaze\.com|thetvdb\.com|creativecommons\.org|github\.com|support\.plex\.tv|musicbrainz\.org|acoustid\.org)\//;
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
    // Only the main window may ask (not the permission window, not anything else).
    if (!fromApp(event) || !win || win.isDestroyed() || event.sender !== win.webContents) throw new Error('Not allowed');
    return fn(...args);
  });
}

// ---- Asking you first: Shelf's own permission window ----
// It's a separate small window run by the app, not part of the main window: its answer is only
// accepted from it, so nothing in the main window can say yes for you. Tests can stand in for
// your click with global.__shelfConsent (only reachable from inside the app process).
const CONSENT_W = 460;
function askConsent(req) {
  req = Object.assign({}, req, { theme });
  if (typeof global.__shelfConsent === 'function') return Promise.resolve(global.__shelfConsent(req)).then((r) => r === true);
  return new Promise((resolve) => {
    const parent = win && !win.isDestroyed() ? win : null;
    const dark = nativeTheme.shouldUseDarkColors;
    const cw = new BrowserWindow({
      parent, modal: !!parent, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, width: CONSENT_W, height: 260, title: 'Shelf',
      backgroundColor: theme === 'seventies' ? (dark ? '#261A13' : '#FBF5EA') : (dark ? '#2A2A2D' : '#FFFFFF'), roundedCorners: true,
      webPreferences: { preload: path.join(__dirname, 'consent-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: false }
    });
    let done = false;
    const mine = (e) => !cw.isDestroyed() && e.sender === cw.webContents;
    const onSize = (e, h) => {
      if (!mine(e)) return;
      h = Math.max(150, Math.min(680, Math.round(Number(h) || 0)));
      cw.setContentSize(CONSENT_W, h);
      if (!cw.isVisible()) {
        if (parent) {
          const b = parent.getBounds();
          cw.setPosition(Math.round(b.x + (b.width - CONSENT_W) / 2), Math.round(b.y + Math.max(56, (b.height - h) / 2.6)));
        } else cw.center();
        cw.show(); cw.focus();
      }
    };
    const finish = (yes) => {
      if (done) return; done = true;
      ipcMain.removeListener('consent:answer', onAnswer); ipcMain.removeListener('consent:size', onSize);
      if (!cw.isDestroyed()) cw.destroy();
      if (parent && !parent.isDestroyed()) { parent.webContents.send('shelf:modal', false); parent.focus(); }
      resolve(yes);
    };
    const onAnswer = (e, yes) => { if (mine(e)) finish(yes === true); };
    ipcMain.on('consent:answer', onAnswer); ipcMain.on('consent:size', onSize);
    cw.on('closed', () => finish(false));
    cw.webContents.on('will-navigate', (e) => e.preventDefault());
    cw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    cw.webContents.once('did-finish-load', () => cw.webContents.send('consent:show', req));
    cw.webContents.on('did-fail-load', () => finish(false));
    if (parent) parent.webContents.send('shelf:modal', true);
    cw.loadURL(ORIGIN + '/consent.html').catch(() => finish(false));
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
  // Picture jobs still running for a video open in Check Episodes: stopped when it closes, so a
  // closed window never leaves the computer busy.
  const jobsFor = new Map();
  function track(owner, c) {
    if (!owner) return;
    if (!jobsFor.has(owner)) jobsFor.set(owner, new Set());
    jobsFor.get(owner).add(c);
    c.on('close', () => { const set = jobsFor.get(owner); if (set) { set.delete(c); if (!set.size) jobsFor.delete(owner); } });
  }
  function stopJobs(owner) { const set = jobsFor.get(owner); if (set) set.forEach((c) => { try { c.kill(); } catch (e) {} }); jobsFor.delete(owner); }
  async function frameJpeg(file, t, w, owner) {
    try {
      const { spawn } = require('child_process');
      const ff = require('ffmpeg-static').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      return await new Promise((resolve, reject) => {
        const c = spawn(ff, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-an', '-sn',
          '-vf', 'scale=' + w + ':-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        track(owner, c);
        const chunks = []; c.stdout.on('data', (d) => chunks.push(d));
        const timer = setTimeout(() => c.kill(), 20000);
        c.on('error', reject); c.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      });
    } finally { /* lanes handle the limits */ }
  }
  // n evenly spaced frames from `from` to `to`, tiled in one row. key=true decodes only keyframes
  // (much faster for long stretches; each tile is then the nearest keyframe before its time).
  async function stripJpeg(file, from, to, n, w, keyOnly, owner) {
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
        track(owner, c);
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
    const tok = u.pathname.replace(/^\/+/, ''), file = mediaTokens.get(tok);
    if (!file) return new Response('Not found', { status: 404 });
    const open = () => mediaTokens.has(tok); // still open when the job's turn comes
    if (u.host === 's') { // a film strip: n frames side by side, shelf-media://s/<token>?from=0&to=60&n=12&w=160&key=0
      const from = Math.max(0, Number(u.searchParams.get('from')) || 0), to = Math.max(from + 0.5, Number(u.searchParams.get('to')) || from + 60);
      const n = Math.min(240, Math.max(1, Math.round(Number(u.searchParams.get('n')) || 12)));
      const w = Math.min(320, Math.max(48, Math.round((Number(u.searchParams.get('w')) || 160) / 2) * 2));
      const slot = /^[a-z]{1,8}$/.test(u.searchParams.get('slot') || '') ? u.pathname + ':' + u.searchParams.get('slot') : null;
      const jpg = await stripLane(slot, () => open() ? stripJpeg(file, from, to, n, w, u.searchParams.get('key') === '1', tok) : Promise.resolve(Buffer.alloc(0)));
      return jpg.length ? new Response(jpg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' } }) : new Response('', { status: 404 });
    }
    if (u.host === 'f') { // one still frame: shelf-media://f/<token>?t=12.5&w=320
      const t = Math.max(0, Number(u.searchParams.get('t')) || 0), w = Math.min(1280, Math.max(64, Number(u.searchParams.get('w')) || 320));
      const slot = /^[a-z]{1,8}$/.test(u.searchParams.get('slot') || '') ? u.pathname + ':' + u.searchParams.get('slot') : null;
      const jpg = await frameLane(slot, () => open() ? frameJpeg(file, t, Math.round(w / 2) * 2, tok) : Promise.resolve(Buffer.alloc(0)));
      return jpg.length ? new Response(jpg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } }) : new Response('', { status: 404 });
    }
    if (u.host !== 'v') return new Response('Not found', { status: 404 });
    const remote = remoteOpen.get(tok);
    if (remote) { // from your server, through its reader (which answers byte ranges the same way)
      const range = request.headers.get('range');
      const r = await fetch(file, { headers: range ? { range } : {} });
      const headers = { 'Content-Type': MIME[remote.ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
      ['content-length', 'content-range'].forEach((k) => { const v = r.headers.get(k); if (v) headers[k] = v; });
      return new Response(r.body, { status: r.status, headers });
    }
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
  // Decoding on the graphics card for title-card reading (see hwaccel.js).
  const hwaccel = require('./hwaccel');
  hwaccel.setMode(readPrefs().gpuDecode);
  handle('shelf:gpuDecode', async (m) => {
    if (typeof m === 'string' && hwaccel.MODES.includes(m)) { hwaccel.setMode(m); const p = readPrefs(); p.gpuDecode = m; writePrefs(p); }
    return hwaccel.status();
  });
  handle('shelf:setTheme', async (name) => {
    theme = name === 'seventies' ? 'seventies' : 'studio';
    try { const p = readPrefs(); if (p.theme !== theme) { p.theme = theme; writePrefs(p); } } catch (e) { /* not essential */ }
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(windowColor());
      barColor = null;
      if (process.platform === 'win32') win.setTitleBarOverlay(overlayNow());
    }
    return theme;
  });
  handle('shelf:titleBar', async (color, symbol) => {
    const hex = /^#[0-9a-f]{6}$/i;
    if (!hex.test(String(color)) || !hex.test(String(symbol))) return false;
    barColor = { color: String(color), symbolColor: String(symbol) };
    if (win && !win.isDestroyed() && process.platform === 'win32') win.setTitleBarOverlay(overlayNow());
    return true;
  });

  // ---- Updates: only when you click Check for Updates ----
  // The release file to install is remembered here; the window can't hand Shelf a link to download.
  // Tests stand in for GitHub and for starting the installer with global.__shelfUpdateTest.
  const updates = require('./updates');
  let offered = null, updateAbort = null;
  const T = () => global.__shelfUpdateTest || null;
  handle('shelf:checkUpdate', async () => {
    const kind = (T() && T().kind) || updates.installKind(process.platform, process.env);
    const r = await updates.check((T() && T().fetch) || net.fetch, app.getVersion(), kind);
    offered = r.newer ? r : null;
    return { current: r.current, version: r.version, newer: r.newer, date: r.date, notes: r.notes, kind: r.kind,
      size: r.asset ? r.asset.size : 0, canInstall: !!(r.newer && r.asset && r.kind !== 'page') };
  });
  handle('shelf:installUpdate', async () => {
    const r = offered;
    if (!r) throw new Error('Check for updates first');
    if (r.kind === 'page' || !r.asset) { shell.openExternal(updates.PAGE); return { opened: 'page' }; }
    // Installer: a private temporary folder. Portable: next to the copy of Shelf you're running.
    const dir = r.kind === 'portable'
      ? (process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('downloads'))
      : fs.mkdtempSync(path.join(app.getPath('temp'), 'shelf-update-'));
    updateAbort = new AbortController();
    const send = (got, total) => { if (win && !win.isDestroyed()) win.webContents.send('shelf:updateProgress', { got, total }); };
    let file;
    try {
      file = await updates.download((T() && T().fetch) || net.fetch, r.asset, (T() && T().dir) || dir, send, updateAbort.signal, !!T());
    } finally { updateAbort = null; }
    log('Update ' + r.version + ' downloaded and checked');
    const start = (T() && T().launch) || ((f) => { require('child_process').spawn(f, [], { detached: true, stdio: 'ignore' }).unref(); });
    await start(file, r.kind);
    if (!T()) setTimeout(() => app.quit(), 600); // the installer takes it from here
    return { started: true, kind: r.kind, file: path.basename(file) };
  });
  handle('shelf:cancelUpdate', async () => { if (updateAbort) updateAbort.abort(); return true; });
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
    const batch = newJournalPath();
    const { results } = await fileops.run(ops.slice(0, 20000), {
      library, mode, allowed: allowedSources, journalPath: batch,
      writePiece: (from, start, end, to) => require('./split').writePiece(from, start, end, to),
      // Songs' covers come from the Cover Art Archive, through Shelf (never from the window).
      coverFor: (ref, size) => mb().cover(ref.release, ref.group, size),
      // An original made smaller (Move): to the Recycle Bin, where it can be put back from.
      // (In tests: a pretend bin folder, never your real Recycle Bin.)
      trash: (p) => { const t = !app.isPackaged && global.__shelfMusicTest; return t && t.trashDir ? fs.promises.rename(p, path.join(t.trashDir, path.basename(p))) : shell.trashItem(p); },
      onProgress: (p) => { if (win && !win.isDestroyed()) win.webContents.send('shelf:progress', p); }
    });
    // A moved file's old path is gone; its new path can be renamed again later.
    // (A split leaves the original where it was, so it stays allowed.)
    results.forEach((r) => { if (r.ok && r.to && mode === 'move' && !r.split) { allowedSources.delete(path.resolve(r.source)); allowedSources.add(r.to); } });
    const id = path.basename(batch, '.json');
    results.forEach((r) => { if (r.ok && r.to) r.batch = id; });
    return results;
  });

  handle('shelf:canUndo', async () => !!(await newestUndoable()));
  handle('shelf:undo', async () => {
    const file = await newestUndoable();
    if (!file) return { undone: 0, kept: 0, nothing: true, batch: null, more: false };
    const r = await fileops.undo(file);
    (r.restored || []).forEach((p) => allowedSources.add(path.resolve(p))); // files put back can be renamed again
    return { undone: r.undone, kept: r.kept, nothing: !!r.nothing, inTrash: (r.inTrash || []).length, batch: path.basename(file, '.json'), more: !!(await newestUndoable()) };
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
  // req: { kind, title, lead, points: [{ icon, text }], ok }. The videos' names are shown too.
  function askFirst(files, req) {
    return askConsent(Object.assign({}, req, { files: files.map((f) => path.basename(f)) }));
  }
  const n = (files, one, many) => (files.length === 1 ? one : many.replace('#', files.length));


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
  // Where to split a video on your server: the same search, reading only the minutes around each gap over SSH.
  async function suggestRemote(p, hints) {
    if (!lookApproved.has(p) && !approvedMedia.has(p)) {
      const yes = await askFirst([p], {
        kind: 'split', ok: 'Find Split', title: 'Find where to split this video?',
        lead: 'Shelf looks for the black, silent moment between the episodes, reading the video on your Plex server.',
        points: [{ icon: 'lock', text: 'Only the minutes around each gap are read, over your SSH connection' }, { icon: 'keep', text: 'Nothing changes until you click Rename Now' }, { icon: 'keep', text: 'The original is kept on the server' }]
      });
      if (!yes) return null;
      lookApproved.add(p);
    }
    return plexSend.withSession(async (s) => {
      const proxy = await require('./remoteread').open(s.sftp);
      try {
        const src = await proxy.add(p);
        try {
          const split = require('./split'), out = [];
          for (const h of hints.slice(0, 5)) {
            if (h && Number.isFinite(h.card)) out.push(Object.assign({ from: 'card' }, await split.cutBefore(src.url, h.card)));
            else if (h && Number.isFinite(h.est)) out.push(Object.assign({ from: 'estimate' }, await split.cutNear(src.url, h.est)));
            else out.push(null);
          }
          return { cuts: out, secs: await probe.duration(p, src.fh) };
        } finally { await src.done(); }
      } finally { await proxy.close(); }
    });
  }
  handle('shelf:suggestCuts', async (p, hints) => {
    if (onServerVideo(p) && Array.isArray(hints)) return suggestRemote(p, hints);
    const files = pickedVideos([p]);
    if (!files.length || !Array.isArray(hints)) throw new Error('Not a video you picked');
    const f = files[0];
    if (!lookApproved.has(f) && !approvedMedia.has(f)) {
      const yes = await askFirst([f], {
        kind: 'split', ok: 'Find Split', title: 'Find where to split this video?',
        lead: 'Shelf looks for the black, silent moment between the episodes.',
        points: [{ icon: 'keep', text: 'Nothing changes until you click Rename Now' }, { icon: 'keep', text: 'Your original file is always kept' }, { icon: 'lock', text: 'Nothing leaves this computer' }]
      });
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
  // Split All: one question for every video, instead of one each.
  handle('shelf:approveSplit', async (paths) => {
    const list = Array.isArray(paths) ? paths.slice(0, 2000) : [];
    const files = pickedVideos(list.filter((f) => !onServerVideo(f))).concat(list.filter(onServerVideo));
    const ask = files.filter((f) => !lookApproved.has(f) && !approvedMedia.has(f));
    if (!ask.length) return files.length > 0;
    const remote = ask.some(onServerVideo);
    const yes = await askFirst(ask, {
      kind: 'split', ok: 'Find Splits', title: n(ask, 'Find where to split this video?', 'Find where to split these # videos?'),
      lead: 'Shelf looks for the black, silent moment between the episodes in each one.',
      points: [{ icon: 'keep', text: 'Nothing changes until you click Rename Now' }, { icon: 'keep', text: 'Your originals are always kept' },
        remote ? { icon: 'lock', text: 'Videos on your Plex server: only the minutes around each gap are read, over SSH' } : { icon: 'lock', text: 'Nothing leaves this computer' }]
    });
    if (!yes) return false;
    ask.forEach((f) => lookApproved.add(f));
    return true;
  });
  let cardCancel = false;
  handle('shelf:cancelCards', async () => { cardCancel = true; if (listenerMade) listenerMade.stop(); return true; });
  // Listening to an episode (whisper.cpp, shipped with Shelf): for shows whose episodes don't show their name.
  let listenerMade = null;
  const whisperDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'whisper') : (global.__shelfWhisperDir || path.join(__dirname, '..', 'build', 'bin', 'whisper')));
  const listener = () => listenerMade || (listenerMade = require('./listen').create({ whisperDir: whisperDir(), ffmpeg: scanner().ffmpegPath() }));
  handle('shelf:canListen', async () => listener().ready());
  // jobs: [{ path, titles: [episode titles of that show] }]. A video on your Plex server (listed by Fix My
  // Plex Library) comes as { remote: its path there, titles } and is read over the SSH connection (remoteread.js).
  handle('shelf:readCards', async (jobs, how) => {
    if (!Array.isArray(jobs)) return {};
    const deep = !!(how && how.deep);
    const onServer = new Set(); // keys of videos on the server (their path there, never resolved on this PC)
    const keyOf = (j) => {
      if (typeof j.path === 'string') return path.resolve(j.path);
      const r = String(j.remote);
      if (plexFix.isListed(r) && P.VIDEO_EXT.includes(path.posix.extname(r).slice(1).toLowerCase())) { onServer.add(r); return r; }
      return null;
    };
    jobs = jobs.filter((j) => j && (typeof j.path === 'string' || typeof j.remote === 'string')).map((j) => Object.assign({}, j, { key: keyOf(j) })).filter((j) => j.key);
    const titlesFor = new Map(jobs.map((j) => [j.key, Array.isArray(j.titles) ? j.titles.map(String).slice(0, 3000) : []]));
    // Each title's description and its place in the list (season x number), for matching what's heard.
    const aboutsFor = new Map(jobs.map((j) => [j.key, Array.isArray(j.abouts) ? j.abouts.slice(0, 3000).map((a) => String(a || '').slice(0, 600)) : []]));
    const keysFor = new Map(jobs.map((j) => [j.key, Array.isArray(j.keys) ? j.keys.slice(0, 3000).map(String) : []]));
    const seasonFor = new Map(jobs.map((j) => [j.key, Number.isInteger(j.season) ? j.season : null]));
    const runtimesFor = new Map(jobs.map((j) => [j.key, Array.isArray(j.runtimes) ? j.runtimes.slice(0, 3000).map((m) => Math.max(0, Math.min(600, Number(m) || 0))) : []]));
    const nearFor = new Map(jobs.map((j) => [j.key, new Set(Array.isArray(j.near) ? j.near.map(String).slice(0, 200) : [])]));
    const showFor = new Map(jobs.map((j) => [j.key, String(j.show || '').slice(0, 200)]));
    const okHere = new Set(pickedVideos([...titlesFor.keys()].filter((k) => !onServer.has(k))));
    const files = [...titlesFor.keys()].filter((k) => onServer.has(k) || okHere.has(k)).slice(0, 2000); // in the order asked (the list's order)
    if (!files.length) return {};
    const someOnServer = files.some((f) => onServer.has(f));
    const where = someOnServer
      ? [{ icon: 'lock', text: 'Videos on your Plex server: only the minutes Shelf needs are read, over your SSH connection' }, { icon: 'trash', text: 'Nothing is saved, and nothing is installed on the server' }]
      : [{ icon: 'lock', text: 'Happens on this computer. Nothing is uploaded' }, { icon: 'trash', text: 'Frames and sound are deleted straight away' }];
    const yes = deep
      ? await askFirst(files, {
        kind: 'deep', ok: 'Deep Scan', title: n(files, 'Deep scan this video?', 'Deep scan these # videos?'),
        lead: 'Shelf takes a much closer look at every spot a title card could be, reading each one many ways.',
        points: where.concat([{ icon: 'clock', text: 'Takes a few minutes per video' }])
      })
      : await askFirst(files, {
        kind: 'cards', ok: 'Read Title Cards', title: n(files, 'Read this video’s title cards?', 'Read the title cards of # videos?'),
        lead: 'Shelf reads the words on a few still frames, and for shows that don’t show the episode’s name it listens to the first minutes, to find out which episodes ' + n(files, 'it holds.', 'they hold.'),
        points: where.concat([{ icon: 'clock', text: 'About 10–40 seconds per video' }])
      });
    if (!yes) return null;
    files.forEach((f) => { if (!onServer.has(f)) lookApproved.add(f); }); // you said yes to Shelf looking inside these
    const scan = scanner(); // loaded only when you use it
    cardCancel = false;
    const send = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('shelf:cardProgress', msg); };
    const out = {};
    // What Shelf learns about each show as it goes: a show whose first videos have no readable title card but
    // whose episodes were recognised by listening is only listened to from then on (much quicker).
    // It starts from what earlier scans of the show learned (see learnedPath). (A show only listened to is still read
    // for cards once each scan, so a wrong early judgement isn't kept for ever.)
    const learned = readLearned(), keepLast = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'number' && isFinite(x)).slice(-12) : []);
    const showSeen = new Map(); // show → { files, cards, heard, ... }
    const seenFor = (show) => {
      if (showSeen.has(show)) return showSeen.get(show);
      const k = (show && learned[show]) || {}, num = (x) => Math.max(0, Math.min(1e6, Math.floor(Number(x) || 0)));
      const s = {
        files: Math.min(num(k.files), 1), cards: num(k.cards), heard: num(k.heard), seasons: [], listened: num(k.listened),
        words: new Map(Array.isArray(k.words) ? k.words.filter((w) => Array.isArray(w) && typeof w[0] === 'string').map((w) => [w[0], num(w[1])]) : []),
        looked: num(k.looked), onScreen: new Map(Array.isArray(k.onScreen) ? k.onScreen.filter((w) => Array.isArray(w) && typeof w[0] === 'string' && /^[a-z]{4,20}$/.test(w[0])).slice(0, 300).map((w) => [w[0], num(w[1])]) : []),
        firstCard: keepLast(k.firstCard), afterBlack: keepLast(k.afterBlack), afterQuiet: keepLast(k.afterQuiet), quietLen: keepLast(k.quietLen), quickAll: !!k.quickAll
      };
      showSeen.set(show, s);
      return s;
    };
    // (Saved after each video, so a scan stopped part way still teaches the next one.)
    const rememberShow = (show, s) => {
      if (!show) return;
      const words = [...s.words].filter(([, n]) => n >= Math.max(2, s.listened * 0.3)).sort((a, b) => b[1] - a[1]).slice(0, 300);
      const onScreen = [...s.onScreen].filter(([, n]) => n >= Math.max(2, s.looked * 0.15)).sort((a, b) => b[1] - a[1]).slice(0, 300);
      learned[show] = { at: Date.now(), files: s.files, cards: s.cards, heard: s.heard, listened: s.listened, words, looked: s.looked, onScreen, quickAll: s.quickAll,
        firstCard: keepLast(s.firstCard), afterBlack: keepLast(s.afterBlack), afterQuiet: keepLast(s.afterQuiet), quietLen: keepLast(s.quietLen) };
      try { writeLearned(learned); } catch (e) { /* not kept: the next scan learns it again */ }
    };
    // Words on screen in a good share of the show's videos (at least three) that were never their title: its credits
    // ("Story By Jennifer Keene" read as "Imperfect Storm"), its logo. They don't count towards a title (see matchCardText).
    const usualOnScreen = (s) => (s.looked >= 3 ? [...s.onScreen].filter(([, n]) => n >= Math.max(3, s.looked * 0.25)).sort((a, b) => b[1] - a[1]).slice(0, 200).map(([w]) => w) : []);
    const canListen = listener().ready();
    // The stretches to listen to: the start of each part without a title card read. One episode as long as the
    // video (Mythbusters, Dora): just its start. Several cartoons in one video: the start of each.
    const runSecs = scan.runSecs, partsIn = scan.partsIn; // (see scan.js)
    // The middle of the last few values (null when there are none).
    const lastFew = (a) => (a.length ? a.slice(-5).sort((x, y) => x - y)[Math.min(a.length, 5) >> 1] : null);
    // How long after a silence this show's cards usually come, commonest first (at most three). Some shows always
    // wait the same moment (SpongeBob: 1.1-1.4 s); Phineas and Ferb waits 1, 4.5 or 10 s, depending on the episode.
    const usualGaps = (a) => {
      const groups = [];
      a.slice(-12).forEach((v, k) => { const g = groups.find((x) => Math.abs(x.v - v) <= 0.6); if (g) { g.n++; g.k = k; } else groups.push({ v, n: 1, k }); });
      return groups.sort((x, y) => y.n - x.n || y.k - x.k).slice(0, 3).map((g) => g.v);
    };
    function listenPlan(secs, usualMins, parts, found) {
      const d = secs || 1320;
      const one = !parts || parts <= 1 || partsIn(d, usualMins) === 1;
      const n = one ? 1 : parts;
      const plan = [];
      for (let k = 0; k < n; k++) if (!found.has(k)) plan.push({ part: k, from: k ? Math.max(0, (d * k) / n - 20) : 0 });
      return { n, plan };
    }
    // Listen to the first two minutes (where a show says what's in this episode); not sure yet, the next two too
    // (up to six minutes). → the match, or null.
    async function hear(src, from, entries, limit, seasons, seen) {
      let heard = { text: '', lines: [] }, m = null;
      // Words said in most of this show's episodes so far (its opening, its hosts' names) don't tell them apart.
      const ignore = {};
      if (seen && seen.listened >= 3) for (const [w, n] of seen.words) if (n >= seen.listened * 0.5) ignore[w] = 1;
      for (let k = 0; k < 3 && !cardCancel; k++) {
        const at = from + k * 120;
        if (limit && at >= limit - 30) break;
        const h = await listener().listen(src, at, 120);
        heard = { text: (heard.text + ' ' + h.text).trim(), lines: heard.lines.concat(h.lines) };
        m = P.matchHeard(heard, entries, { seasons, ignore });
        if (m && m.margin >= 2) break;
      }
      if (seen && heard.text) { seen.listened++; for (const w of new Set(P.heardWords(heard.text.slice(0, 2500)))) seen.words.set(w, (seen.words.get(w) || 0) + 1); }
      return m;
    }
    // While one video's frames are being read, the next one's still moments are found (that part is mostly the
    // video tool decoding, and reading is mostly the text reader): about a third quicker for a folder of videos.
    // (Videos on this computer only; one on the server is fetched over SSH and read only when it's its turn.)
    const ahead = new Map(); // file → { secs, stills }
    // (Not for a show whose title cards the quick look found in its last video: its thumbnails are seldom needed.)
    function prepareAhead(f) {
      if (!f || onServer.has(f) || ahead.has(f) || deep) return;
      const sn = seenFor(showFor.get(f));
      if (sn && sn.quickAll) return;
      const mins = (runtimesFor.get(f) || []).filter((m) => m > 0).sort((a, b) => a - b), usual = mins.length ? mins[mins.length >> 1] : 0;
      const p = probe.duration(f).then((secs) => {
        const n = partsIn(secs, usual);
        return { secs, n, stills: scan.prepareStills(f, secs, n) };
      });
      p.catch(() => {});
      ahead.set(f, p);
    }
    // proxy: the reader for videos on the server (null when there are none, or the server couldn't be reached: why).
    async function readAll(proxy, why) {
      for (let i = 0; i < files.length && !cardCancel; i++) {
        const f = files[i], remote = onServer.has(f);
        const mins = runtimesFor.get(f) || [];
        const entries = titlesFor.get(f).map((name, n) => ({ name, number: n + 1, season: 1, runtime: mins[n] || null }));
        const near = entries.filter((e) => nearFor.get(f).has(e.name));
        // The episodes of the season the file's name gives and those either side (a card from further away must be
        // read almost perfectly; see matchCardText).
        const sn0 = seasonFor.get(f), fk = keysFor.get(f) || [];
        const inSeason = sn0 == null ? null : entries.filter((e, n) => Math.abs(+String(fk[n] || '').split('x')[0] - sn0) <= 1);
        // The show's usual episode length (the middle one of those listed), which a double-length episode stands out from.
        const known = mins.filter((m) => m > 0).sort((a, b) => a - b), usual = known.length ? known[known.length >> 1] : 0;
        let src = null, secs = null;
        try {
          if (remote) {
            if (!proxy) throw new Error(why || 'Couldn’t reach your Plex server.');
            src = await proxy.add(f).catch((e) => { throw new Error(require('./server').friendly(e, '').message); });
          }
          const pre = ahead.get(f); ahead.delete(f);
          var made = pre ? await pre.catch(() => null) : null;
          secs = made ? made.secs : src ? await probe.duration(f, src.fh) : await probe.duration(f);
        } catch (e) {
          out[f] = { secs, error: String(e.message || e).slice(0, 200) };
          send({ kind: 'file', path: f, index: i, total: files.length, result: out[f], stopped: cardCancel });
          continue;
        }
        send({ kind: 'start', path: f, index: i, total: files.length, file: remote ? path.posix.basename(f) : path.basename(f) });
        let last = 0;
        const seen = seenFor(showFor.get(f));
        const foundParts = new Set(), foundSeasons = new Set(), foundNames = [];
        const notTitle = usualOnScreen(seen);
        // Two videos of this show in, no title card read, but listening worked: just listen.
        const skipCards = canListen && !deep && seen.files >= 2 && seen.cards === 0 && seen.heard > 0;
        try {
          // How many episodes the video holds, by the show's usual episode length (one: only its start has a title
          // card). 0 when the list gives no lengths: then by the video's length alone.
          const nParts = partsIn(secs, usual);
          // The next video's still moments, found meanwhile (unless this show is only listened to now).
          if (!skipCards && !(seen.files >= 1 && seen.cards === 0 && seen.heard > 0)) prepareAhead(files[i + 1]);
          const r = skipCards ? { texts: [], parts: 0 } : await scan.scanFile(src ? src.url : f, secs, {
            deep, maxParts: nParts, stills: made && made.n === nParts ? made.stills : null,
            // Where the first title card was in this show's other videos (the middle of the last few).
            cardAt: lastFew(seen.firstCard),
            // How long after a fade to black, and after a silence (and how long that was), this show's cards were.
            cardAfterBlack: lastFew(seen.afterBlack), cardAfterQuiet: usualGaps(seen.afterQuiet), cardQuietLen: lastFew(seen.quietLen),
            // The quick look a moment after the silences, unless this show's cards never come after one.
            quick: !(seen.cards >= 3 && !seen.afterQuiet.length),
            isMatch: (texts) => P.matchCardText(texts, entries, near, showFor.get(f), inSeason, notTitle),
            // An episode as long as the video (give or take the credits), and clearly longer than the show's usual one:
            // it's the only one in there. Online lists get lengths wrong (TVmaze has 11-minute "Squid's Day Off" at
            // 30), so one listed as longer than the whole video, or a show listing every cartoon at the half-hour's
            // length, never stops the search early.
            fillsVideo: (hit) => {
              const m = hit && hit.entry && hit.entry.runtime;
              return !!(m && usual && m >= usual * 1.4 && runSecs(m) >= secs * 0.7 && runSecs(m) <= secs * 1.15);
            },
            cancelled: () => cardCancel,
            // What Shelf is looking at right now (a small picture, only sent to this window) and what it found.
            onPeek: (pk) => send({ kind: 'peek', path: f, index: i, total: files.length, t: pk.t, part: pk.part, image: { w: pk.image.w, h: pk.image.h, data: pk.image.data } }),
            onFound: (fd) => { foundParts.add(fd.part); foundNames.push(fd.hit.entry.name); if (fd.part === 0) seen.firstCard.push(fd.t); if (fd.afterBlack != null) seen.afterBlack.push(fd.afterBlack); if (fd.afterQuiet != null) { seen.afterQuiet.push(fd.afterQuiet); seen.quietLen.push(fd.quietLen); } const fk = String((keysFor.get(f) || [])[fd.hit.entry.number - 1] || '').split('x')[0]; if (fk) foundSeasons.add(+fk); send({ kind: 'found', path: f, index: i, total: files.length, t: fd.t, part: fd.part, title: fd.hit.entry.name }); },
            onProgress: (frac) => { const now = Date.now(); if (now - last > 150 || frac >= 1) { last = now; send({ kind: 'step', path: f, index: i, total: files.length, frac }); } }
          });
          let parts = r.parts || scan.windowsFor(secs, nParts).length;
          seen.files++; if (foundParts.size) seen.cards++;
          // (Every card found in it was found by the quick look.)
          seen.quickAll = foundParts.size > 0 && (r.quickHits || 0) >= foundParts.size;
          // What else this video read on screen (each word once), towards the show's usual words. (Not a Deep Scan's: it
          // reads far more frames than a scan usually does, credits and all.)
          const readings = r.texts.flatMap((x) => x.texts || []);
          if (!deep && readings.length) {
            seen.looked++;
            for (const w of P.otherCardWords(readings, foundNames)) seen.onScreen.set(w, (seen.onScreen.get(w) || 0) + 1);
            // (Most of it is one-off jumble: only the commonest are kept once there are many.)
            if (seen.onScreen.size > 4000) seen.onScreen = new Map([...seen.onScreen].sort((a, b) => b[1] - a[1]).slice(0, 2000));
          }
          // Parts without a title card: listen to their start.
          const titles = titlesFor.get(f), abouts = aboutsFor.get(f), keys = keysFor.get(f);
          // (Only when the list describes the episodes around this one: there's nothing to match words with otherwise,
          // as for SpongeBob's seventh season on TVmaze, and listening would only take time.)
          const nearSet = nearFor.get(f), sn = seasonFor.get(f), all = titles.map((x, k) => k);
          // Which episodes to judge by: the season a title card in this file named; else those near the file's
          // number; else the best-described of its season and the ones either side (a misnumbered file's episodes
          // are usually close by).
          const share = (ks) => ks.filter((k) => abouts[k]).length / Math.max(1, ks.length);
          const seasonOf = (k) => +String(keys[k]).split('x')[0];
          let described;
          if (foundSeasons.size) described = share(all.filter((k) => foundSeasons.has(seasonOf(k))));
          else if (nearSet.size) described = share(all.filter((k) => nearSet.has(titles[k])));
          else if (sn != null) described = Math.max(0, ...[sn - 1, sn, sn + 1].map((x) => all.filter((k) => seasonOf(k) === x)).filter((ks) => ks.length).map(share));
          else described = share(all);
          if (canListen && !cardCancel && described >= 0.3) {
            const lp = listenPlan(secs, usual, skipCards ? 1 : parts, foundParts);
            const hearList = titles.map((name, k) => ({ name, about: abouts[k] || '', key: keys[k] || '', season: +String(keys[k] || '').split('x')[0] || 0, number: k + 1 }));
            for (const p of lp.plan) {
              if (cardCancel) break;
              send({ kind: 'listen', path: f, index: i, total: files.length, part: p.part });
              // Once two of the show's files are recognised, the seasons they're in count a little extra.
              const m = await hear(src ? src.url : f, p.from, hearList, secs, seen.heard >= 2 ? seen.seasons : null, seen);
              if (!m) continue;
              seen.heard++; seen.seasons.push(m.entry.season);
              r.texts.push({ part: p.part, t: m.line ? m.line.t : Math.round(p.from), start: Math.round(p.from), texts: [], heard: { name: m.entry.name, key: m.entry.key, quote: m.line ? m.line.text : '', words: m.words, score: m.score, margin: m.margin } });
              send({ kind: 'found', path: f, index: i, total: files.length, t: m.line ? m.line.t : p.from, part: p.part, title: m.entry.name, heard: true });
            }
            if (lp.n === 1 && r.texts.some((x) => x.heard) && !foundParts.size) parts = 1; // one episode, heard
          }
          // (With the show's usual words, which the window leaves out when it judges these readings again.)
          out[f] = { secs, parts, texts: r.texts, notTitle: usualOnScreen(seen) };
        } catch (e) {
          out[f] = { secs, error: String(e.message || e).slice(0, 200) };
        } finally {
          if (src) await src.done();
        }
        if (!deep) rememberShow(showFor.get(f), seen); // (Deep Scan reads everything anyway, and isn't how this show usually goes)
        send({ kind: 'file', path: f, index: i, total: files.length, result: out[f], stopped: cardCancel });
      }
    }
    send({ kind: 'queue', paths: files, total: files.length });
    try {
      if (!someOnServer) await readAll(null);
      else {
        let opened = false;
        try {
          // The reader lives only while this scan runs, on the connection Send to Plex uses.
          await plexSend.withSession(async (s) => {
            opened = true;
            const proxy = await require('./remoteread').open(s.sftp);
            try { await readAll(proxy); } finally { await proxy.close(); }
          });
        } catch (e) {
          if (opened) throw e;
          await readAll(null, require('./server').friendly(e, (plexSend.cfg() || {}).host || '').message); // this PC's videos still get read
        }
      }
    } finally {
      scan.stopOcrSoon(); // kept ready for a minute, in case you read more
      send({ kind: 'end', total: files.length, stopped: cardCancel });
    }
    return out;
  });

  // ---- Split window ----
  // also: other videos you'll step through with "Save & Next" — asked about together, once.
  const approvedMedia = new Set();
  // A video on your Plex server that Fix My Plex Library listed: played and pictured straight from the server
  // through the reader title cards use (over your SSH connection, into memory only; nothing is saved or
  // installed). The connection is held only while the window is open.
  const remoteOpen = new Map(); // token → { ext, release() }
  const onServerVideo = (p) => typeof p === 'string' && plexFix.isListed(p) && P.VIDEO_EXT.includes(path.posix.extname(p).slice(1).toLowerCase());
  async function openRemote(p, also) {
    if (!approvedMedia.has(p)) {
      const batch = [p].concat(Array.isArray(also) ? also.filter(onServerVideo).slice(0, 500) : []);
      const yes = await askFirst(batch, {
        kind: 'open', ok: 'Open Video', title: n(batch, 'Open this video in Check Episodes?', 'Open these # videos in Check Episodes?'),
        lead: 'Shelf plays the video from your Plex server in its own window, so you can see which episodes it holds and mark their title cards.',
        points: [{ icon: 'lock', text: 'Played over your SSH connection, only the parts you watch' }, { icon: 'trash', text: 'Nothing is saved, and nothing is installed on the server' }, { icon: 'keep', text: 'Nothing changes until you click Rename Now' }]
      });
      if (!yes) return null;
      batch.forEach((f) => approvedMedia.add(f));
    }
    let release = null;
    const src = await new Promise((resolve, reject) => {
      plexSend.withSession((s) => new Promise((done) => {
        require('./remoteread').open(s.sftp).then((proxy) => proxy.add(p).then((one) => {
          release = () => { Promise.resolve(one.done()).catch(() => {}).then(() => proxy.close()).catch(() => {}).then(done); };
          resolve(one);
        }, (e) => { proxy.close().catch(() => {}); done(); reject(e); }), (e) => { done(); reject(e); });
      })).catch(reject);
    }).catch((e) => { throw new Error(require('./server').friendly(e, (plexSend.cfg() || {}).host || '').message); });
    const token = crypto.randomBytes(16).toString('hex');
    mediaTokens.set(token, src.url);
    remoteOpen.set(token, { ext: path.posix.extname(p).slice(1).toLowerCase(), release });
    return { token, secs: await probe.duration(p, src.fh), fps: await frameRate(src.url), remote: true }; // (split points: splitSuggest reads it the same way)
  }
  handle('shelf:openSplit', async (p, also) => {
    if (onServerVideo(p)) return openRemote(p, also);
    const files = pickedVideos([p]);
    if (!files.length) throw new Error('Not a video you picked');
    if (approvedMedia.has(files[0])) {
      const token0 = crypto.randomBytes(16).toString('hex');
      mediaTokens.set(token0, files[0]);
      return { token: token0, secs: await probe.duration(files[0]), fps: await frameRate(files[0]) };
    }
    const batch = pickedVideos([p].concat(Array.isArray(also) ? also.slice(0, 500) : []));
    const yes = await askFirst(batch, {
      kind: 'open', ok: 'Open Video', title: n(batch, 'Open this video in Check Episodes?', 'Open these # videos in Check Episodes?'),
      lead: 'Shelf plays the video in its own window, so you can see which episodes it holds, where each one starts, and split it if you want.',
      points: [{ icon: 'keep', text: 'Nothing changes until you click Rename Now' }, { icon: 'keep', text: 'Your original file is always kept' }, { icon: 'lock', text: 'Nothing leaves this computer' }]
    });
    if (!yes) return null;
    batch.forEach((f) => approvedMedia.add(f)); // "Save & Next" won't ask again for these
    const token = crypto.randomBytes(16).toString('hex');
    mediaTokens.set(token, files[0]);
    return { token, secs: await probe.duration(files[0]), fps: await frameRate(files[0]) };
  });
  // endBatch: you closed the window (not "Save & Next"), so the next video asks again.
  // A still frame of a video open in Check Episodes (fetched once, kept by that window).
  handle('shelf:mediaFrame', async (token, t, w) => {
    const f = mediaTokens.get(String(token));
    if (!f) return null;
    const jpg = await frameLane(null, () => mediaTokens.has(String(token)) ? frameJpeg(f, Math.max(0, Number(t) || 0), Math.min(640, Math.max(96, Math.round((Number(w) || 320) / 2) * 2)), String(token)) : Promise.resolve(Buffer.alloc(0)));
    return jpg && jpg.length ? new Uint8Array(jpg) : null;
  });
  handle('shelf:closeSplit', async (token, endBatch) => {
    const tok = String(token), remote = remoteOpen.get(tok);
    mediaTokens.delete(tok); stopJobs(tok);
    if (remote) { remoteOpen.delete(tok); remote.release(); } // lets go of the server connection
    if (endBatch !== false) approvedMedia.clear();
    return true;
  });
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

  // ---- Music: tags in the files, and looking albums up on MusicBrainz (see app/js/music.js) ----
  const audioOk = (p) => typeof p === 'string' && allowedSources.has(path.resolve(p)) && P.AUDIO_EXT.includes(path.extname(p).slice(1).toLowerCase());
  // Tags are read on two background threads, so a big music folder never makes the window wait.
  const tagWorkers = []; let tagSeq = 0, tagIdle = null;
  function tagWorker(i) {
    if (!tagWorkers[i]) {
      const { Worker } = require('worker_threads');
      const w = new Worker(path.join(__dirname, 'tagworker.js'));
      w.waiting = new Map();
      w.on('message', (m) => { const r = w.waiting.get(m.id); if (r) { w.waiting.delete(m.id); r.resolve(m.covers || m.results); } });
      w.on('error', (e) => { w.waiting.forEach((r) => r.reject(e)); w.waiting.clear(); tagWorkers[i] = null; });
      tagWorkers[i] = w;
    }
    return tagWorkers[i];
  }
  async function readTags(files) {
    clearTimeout(tagIdle);
    const half = Math.ceil(files.length / 2), parts = [files.slice(0, half), files.slice(half)].filter((x) => x.length);
    const out = await Promise.all(parts.map((list, i) => new Promise((resolve, reject) => {
      const w = tagWorker(i), id = ++tagSeq;
      w.waiting.set(id, { resolve, reject });
      w.postMessage({ id, files: list });
    })));
    // Let the threads go once nothing has been read for a minute.
    tagIdle = setTimeout(() => { tagWorkers.forEach((w) => w && w.terminate()); tagWorkers.length = 0; }, 60000);
    return [].concat(...out);
  }
  handle('shelf:musicTags', async (paths) => {
    const list = (Array.isArray(paths) ? paths : []).slice(0, 1000).map(String);
    const ok = list.filter(audioOk);
    const read = ok.length ? await readTags(ok) : [];
    const by = new Map(ok.map((p, i) => [p, read[i]]));
    return list.map((p) => by.get(p) || { ok: false, error: 'Not a music file Shelf may read.' });
  });
  // Small pictures of the covers inside files (for the list): read on a background thread, shrunk here, so a
  // big library's covers show in moments without anything being downloaded.
  handle('shelf:musicThumbs', async (paths, size) => {
    const list = (Array.isArray(paths) ? paths : []).slice(0, 200).map(String);
    const ok = list.filter(audioOk);
    if (!ok.length) return list.map(() => null);
    clearTimeout(tagIdle);
    const pics = await new Promise((resolve, reject) => { const w = tagWorker(0), id = ++tagSeq; w.waiting.set(id, { resolve, reject }); w.postMessage({ id, covers: ok }); });
    tagIdle = setTimeout(() => { tagWorkers.forEach((w) => w && w.terminate()); tagWorkers.length = 0; }, 60000);
    const px = Math.max(48, Math.min(400, Number(size) || 160));
    const by = new Map(ok.map((p, i) => {
      const c = pics[i];
      if (!c || !c.data) return [p, null];
      const img = nativeImage.createFromBuffer(Buffer.from(c.data));
      if (img.isEmpty()) return [p, null];
      const sz = img.getSize(), small = sz.width > px ? img.resize({ width: px, quality: 'good' }) : img;
      return [p, small.toJPEG(82).toString('base64')];
    }));
    return list.map((p) => by.get(p) || null);
  });
  // The cover inside a file (to show what it has now).
  handle('shelf:musicFileCover', async (p) => {
    if (!audioOk(p)) return null;
    const c = require('./tags.js').cover(p);
    return c ? { mime: c.mime, data: c.data.toString('base64') } : null;
  });
  // MusicBrainz and the Cover Art Archive. (In tests, a pretend MusicBrainz on this computer.)
  let mbClient = null;
  const mb = () => mbClient || (mbClient = (() => {
    const t = (!app.isPackaged && global.__shelfMusicTest) || {};
    return require('./musicbrainz.js').create({
      fetch: t.fetch || net.fetch, userAgent: 'Shelf/' + app.getVersion() + ' ( https://github.com/Groot36-yep/shelf )',
      cacheDir: path.join(app.getPath('userData'), 'lookups', 'music'), base: t.base, coverBase: t.coverBase, gapMs: t.gapMs
    });
  })());
  const mbid = (s) => (/^[0-9a-f-]{36}$/i.test(String(s || '')) ? String(s) : '');
  const words = (s) => String(s || '').slice(0, 200);
  handle('shelf:mbRelease', async (id) => mb().release(mbid(id)));
  handle('shelf:mbSearch', async (s) => mb().searchReleases({ album: words(s && s.album), artist: words(s && s.artist) }));
  handle('shelf:mbGroup', async (id) => mb().groupReleases(mbid(id)));
  handle('shelf:mbGroups', async (s) => mb().searchGroups({ album: words(s && s.album), artist: words(s && s.artist), year: /^\d{4}$/.test(String(s && s.year)) ? String(s.year) : '' }));
  handle('shelf:mbRecordings', async (s) => mb().searchRecordings({ title: words(s && s.title), artist: words(s && s.artist) }));
  handle('shelf:mbCover', async (releaseId, groupId, size) => {
    const c = await mb().cover(mbid(releaseId), mbid(groupId), [250, 500, 1200].includes(size) ? size : 250);
    return c ? { mime: c.mime, data: c.data.toString('base64') } : null;
  });
  handle('shelf:musicForget', async () => { await mb().forget(); return true; });
  // Recognising songs by their sound: Chromaprint's fpcalc (shipped with Shelf) and your own AcoustID key.
  let acoustClient = null;
  const fpcalcPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'fpcalc.exe') : path.join(__dirname, '..', 'build', 'bin', process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc'));
  const secretNow = (name) => { try { const b = fs.readFileSync(secretPath(name)); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : ''; } catch (e) { return ''; } };
  const acoust = () => acoustClient || (acoustClient = (() => {
    const t = (!app.isPackaged && global.__shelfMusicTest) || {};
    return require('./acoustid.js').create({ fpcalc: t.fpcalc || fpcalcPath(), fetch: t.fetch || net.fetch, base: t.acoustBase, key: () => (t.acoustKey != null ? t.acoustKey : secretNow('acoustid')) });
  })());
  handle('shelf:musicSound', async (paths) => {
    const list = (Array.isArray(paths) ? paths : []).slice(0, 200).map(String);
    const ok = list.map((p) => (audioOk(p) ? p : null));
    const heard = await acoust().recognise(ok.filter(Boolean));
    let k = 0;
    return ok.map((p) => (p ? heard[k++] : null));
  });
  handle('shelf:musicSoundReady', async () => fs.existsSync(((!app.isPackaged && global.__shelfMusicTest) || {}).fpcalc || fpcalcPath()));

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
  // ---- Send to Plex (your own server, over SSH) ----
  const plexSend = require('./plexsend').setup({
    handle, app, safeStorage, shell, readPrefs, writePrefs, log,
    send: (msg) => { if (win && !win.isDestroyed()) win.webContents.send('shelf:sendProgress', msg); },
    tidyDirs: async (d) => { const lib = readPrefs().library; if (lib) await fileops.removeEmptyDirs(d, await fs.promises.realpath(lib)); }
  });
  app.on('before-quit', () => { plexSend.close(); if (scanLoaded) scanLoaded.stopOcr(); });
  // ---- Fix My Plex Library (the files already on your server, over the same SSH connection) ----
  const plexFix = require('./plexfix').setup({ app, log, send: (msg) => { if (win && !win.isDestroyed()) win.webContents.send('shelf:fixProgress', msg); } }, plexSend);
  // ---- Server Files (copy between your Plex server and this PC, over the same SSH login) ----
  const xfer = require('./transfer').setup({ app, log, readPrefs, send: (msg) => { if (win && !win.isDestroyed()) win.webContents.send('shelf:xferProgress', msg); } }, plexSend);
  app.on('before-quit', () => xfer.close());

  // Settings → Look → App icon. choice: auto | a style; name: the style it comes to; pngs: { size: bytes }.
  handle('shelf:setAppIcon', async (choice, name, pngs) => {
    if (choice !== 'auto' && !appicon.STYLES.includes(choice)) throw new Error('Unknown icon style.');
    const used = appIcons().save(name, pngs);
    const p = readPrefs(); p.appIcon = choice; p.appIconUsed = used; writePrefs(p);
    return { shortcuts: appIcons().apply(used, win), canShortcuts: shortcutsOk() };
  });
  handle('shelf:eraseAll', async () => {
    try { appIcons().reset(); } catch (e) { /* nothing to put back */ }
    if (scanLoaded) await scanLoaded.stopOcr();
    plexSend.forgetAll();
    plexFix.forget();
    xfer.forget();
    for (const p of Object.keys(SECRETS).map(secretPath).concat([prefsPath(), learnedPath(), legacyJournal(), path.join(app.getPath('userData'), 'startup.log')])) fs.rmSync(p, { force: true });
    fs.rmSync(historyDir(), { recursive: true, force: true });
    fs.rmSync(path.join(app.getPath('userData'), 'lookups'), { recursive: true, force: true });
    logLines = [];
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
