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
const fileops = require('./fileops');

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
function fatal(where, err) {
  const text = (err && (err.stack || err.message)) || String(err);
  log('ERROR ' + where + ': ' + text);
  try {
    dialog.showErrorBox('Shelf couldn’t start', 'Something went wrong while opening Shelf (' + where + ').\n\n' +
      String((err && err.message) || err).slice(0, 400) + '\n\nDetails were saved to:\n' + path.join(app.getPath('userData'), 'startup.log'));
  } catch (e) { /* ignore */ }
}
process.on('uncaughtException', (e) => fatal('main', e));
process.on('unhandledRejection', (e) => fatal('main', e));
log('Starting Shelf ' + app.getVersion() + ' on ' + process.platform + ' ' + process.getSystemVersion() + ' (Electron ' + process.versions.electron + ')');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }
]);

// Only one copy of Shelf at a time. A second launch brings the first window to the front.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { log('Another copy is already running; asking it to come to the front.'); app.exit(0); }

let win = null;
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
