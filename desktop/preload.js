/*
 * Shelf desktop — the small, fixed list of things the window may ask for.
 * The window never gets direct access to your disk or to Node.
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

let dropListener = null;
window.addEventListener('drop', (e) => {
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length || !dropListener) return;
  const paths = files.map((f) => { try { return webUtils.getPathForFile(f); } catch (err) { return ''; } }).filter(Boolean);
  const fn = dropListener;
  fn({ state: 'start', count: files.length });
  ipcRenderer.invoke('shelf:expandDropped', paths)
    .then((list) => fn({ state: 'done', list, asked: files.length, found: paths.length }))
    .catch((err) => fn({ state: 'error', message: String((err && err.message) || err) }));
}, true);

// A live preview frame from the title-card reader: only a small RGBA picture of the right size is passed on.
function peekImage(im) {
  if (!im || typeof im !== 'object') return null;
  const w = Number(im.w) | 0, h = Number(im.h) | 0, d = im.data;
  if (w <= 0 || h <= 0 || w > 400 || h > 400 || !(d instanceof Uint8Array) || d.length !== w * h * 4) return null;
  return { w, h, data: new Uint8ClampedArray(d.buffer, d.byteOffset, d.length) };
}

contextBridge.exposeInMainWorld('shelfNative', {
  platform: process.platform,
  version: () => ipcRenderer.invoke('shelf:version'),
  // Updates: only when you click (see desktop/updates.js).
  checkUpdate: () => ipcRenderer.invoke('shelf:checkUpdate'),
  installUpdate: () => ipcRenderer.invoke('shelf:installUpdate'),
  cancelUpdate: () => ipcRenderer.invoke('shelf:cancelUpdate'),
  onUpdateProgress: (fn) => {
    const listener = (e, p) => fn({ got: Number(p.got) || 0, total: Number(p.total) || 0 });
    ipcRenderer.on('shelf:updateProgress', listener);
    return () => ipcRenderer.removeListener('shelf:updateProgress', listener);
  },
  // The look you chose (so the window frame and permission window match).
  setTheme: (name) => ipcRenderer.invoke('shelf:setTheme', String(name || 'studio')),
  // Windows: the colour under the window's minimise / maximise / close buttons, so they blend in.
  titleBar: (color, symbol) => ipcRenderer.invoke('shelf:titleBar', String(color), String(symbol)),
  // Shelf's permission window is open (the main window dims behind it).
  onModal: (fn) => { ipcRenderer.on('shelf:modal', (e, open) => fn(open === true)); },
  // Graphics card for reading title cards: 'auto' | 'on' | 'off' (nothing passed: just ask).
  gpuDecode: (m) => ipcRenderer.invoke('shelf:gpuDecode', ['auto', 'on', 'off'].includes(m) ? m : null)
    .then((s) => ({ mode: String(s.mode), available: (s.available || []).map(String), broken: (s.broken || []).map(String), used: String(s.used || '') })),
  pickFiles: () => ipcRenderer.invoke('shelf:pickFiles'),
  pickFolder: () => ipcRenderer.invoke('shelf:pickFolder'),
  // Dropped files: their locations are read here, where the real File objects are (a File handed
  // across to the page loses its location). The page just gets told what was added.
  onDropFiles: (fn) => { dropListener = typeof fn === 'function' ? fn : null; },
  getLibrary: () => ipcRenderer.invoke('shelf:getLibrary'),
  pickLibrary: () => ipcRenderer.invoke('shelf:pickLibrary'),
  rename: (ops, mode) => ipcRenderer.invoke('shelf:rename', ops, mode),
  canUndo: () => ipcRenderer.invoke('shelf:canUndo'),
  undo: () => ipcRenderer.invoke('shelf:undo'),
  showLibrary: () => ipcRenderer.invoke('shelf:showInFolder'),
  getKey: (name) => ipcRenderer.invoke('shelf:getKey', String(name || 'tmdb')),
  setKey: (name, k) => ipcRenderer.invoke('shelf:setKey', String(name || 'tmdb'), k),
  eraseAll: () => ipcRenderer.invoke('shelf:eraseAll'),
  openSplit: (p, also) => ipcRenderer.invoke('shelf:openSplit', p, also),
  mediaFrame: (token, t, w) => ipcRenderer.invoke('shelf:mediaFrame', token, t, w).then((b) => (b instanceof Uint8Array && b.length < 2e6 ? b : null)),
  closeSplit: (token, endBatch) => ipcRenderer.invoke('shelf:closeSplit', token, endBatch),
  splitSuggest: (token, hints) => ipcRenderer.invoke('shelf:splitSuggest', token, hints),
  splitAround: (token, t) => ipcRenderer.invoke('shelf:splitAround', token, t),
  readCards: (jobs, how) => ipcRenderer.invoke('shelf:readCards', jobs, { deep: !!(how && how.deep) }),
  cardFrame: (p, t, w) => ipcRenderer.invoke('shelf:cardFrame', p, t, w).then((b) => (b instanceof Uint8Array && b.length < 2e6 ? b : null)),
  suggestCuts: (p, hints) => ipcRenderer.invoke('shelf:suggestCuts', p, hints),
  approveSplit: (paths) => ipcRenderer.invoke('shelf:approveSplit', paths),
  cancelCards: () => ipcRenderer.invoke('shelf:cancelCards'),
  onCardProgress: (fn) => {
    const listener = (e, p) => fn({
      kind: String(p.kind || ''), path: String(p.path || ''), paths: Array.isArray(p.paths) ? p.paths.map(String) : [],
      index: Number(p.index) || 0, total: Number(p.total) || 0, frac: Number(p.frac) || 0,
      file: String(p.file || ''), stopped: !!p.stopped, result: p.result && typeof p.result === 'object' ? p.result : null,
      t: Number(p.t) || 0, part: Number(p.part) || 0, title: String(p.title || ''), image: peekImage(p.image)
    });
    ipcRenderer.on('shelf:cardProgress', listener);
    return () => ipcRenderer.removeListener('shelf:cardProgress', listener);
  },
  // Send to Plex: your server over SSH. Passwords go in, never come back out.
  server: () => ipcRenderer.invoke('shelf:server'),
  serverFileZilla: () => ipcRenderer.invoke('shelf:serverFileZilla'),
  serverProbe: (host, port) => ipcRenderer.invoke('shelf:serverProbe', String(host || ''), Number(port) || 22),
  serverLogin: (a) => ipcRenderer.invoke('shelf:serverLogin', {
    user: String((a && a.user) || ''), password: String((a && a.password) || ''), trust: String((a && a.trust) || ''),
    fz: a && Number.isInteger(a.fz) ? a.fz : null, useKey: !(a && a.useKey === false)
  }),
  serverList: (where) => ipcRenderer.invoke('shelf:serverList', String(where || '')),
  serverMkdir: (where, name) => ipcRenderer.invoke('shelf:serverMkdir', String(where || ''), String(name || '')),
  serverFolder: (kind, where) => ipcRenderer.invoke('shelf:serverFolder', String(kind), String(where || '')),
  serverPlex: (token) => ipcRenderer.invoke('shelf:serverPlex', String(token || '')),
  serverForgetPlex: () => ipcRenderer.invoke('shelf:serverForgetPlex'),
  serverOptions: (o) => ipcRenderer.invoke('shelf:serverOptions', o && typeof o === 'object' ? {
    autoSend: typeof o.autoSend === 'boolean' ? o.autoSend : undefined, verify: typeof o.verify === 'boolean' ? o.verify : undefined,
    scan: typeof o.scan === 'boolean' ? o.scan : undefined, tidy: typeof o.tidy === 'boolean' ? o.tidy : undefined
  } : {}),
  serverRetrust: (fp) => ipcRenderer.invoke('shelf:serverRetrust', String(fp || '')),
  serverForget: (removeKey) => ipcRenderer.invoke('shelf:serverForget', !!removeKey),
  sendPlan: (paths) => ipcRenderer.invoke('shelf:sendPlan', Array.isArray(paths) ? paths.map(String) : null),
  send: (paths, how) => ipcRenderer.invoke('shelf:send', Array.isArray(paths) ? paths.map(String) : null, { replace: !!(how && how.replace) }),
  sendStop: () => ipcRenderer.invoke('shelf:sendStop'),
  // Fix My Plex Library: the files already on your server (renamed there, nothing is copied).
  plexLibraryScan: (only) => ipcRenderer.invoke('shelf:plexLibraryScan', only === 'all' ? 'all' : 'problems'),
  plexLibraryFix: (ops) => ipcRenderer.invoke('shelf:plexLibraryFix', Array.isArray(ops) ? ops.map((o) => ({
    remote: String((o && o.remote) || ''), folder: Array.isArray(o && o.folder) ? o.folder.map(String) : [], file: String((o && o.file) || '')
  })) : []),
  plexLibraryStop: () => ipcRenderer.invoke('shelf:plexLibraryStop'),
  // What Fix My Plex Library is doing right now: { stage: 'connect' | 'plex' | 'walk' | 'done', … numbers }.
  onFixProgress: (fn) => {
    const listener = (e, m) => fn({
      stage: String((m && m.stage) || ''), lib: String((m && m.lib) || ''), index: Number(m && m.index) || 0, of: Number(m && m.of) || 0,
      done: Number(m && m.done) || 0, total: Number(m && m.total) || 0, folders: Number(m && m.folders) || 0, files: Number(m && m.files) || 0,
      picked: Number(m && m.picked) || 0, stopped: !!(m && m.stopped)
    });
    ipcRenderer.on('shelf:fixProgress', listener);
    return () => ipcRenderer.removeListener('shelf:fixProgress', listener);
  },
  plexLibraryCanUndo: () => ipcRenderer.invoke('shelf:plexLibraryCanUndo'),
  plexLibraryUndo: () => ipcRenderer.invoke('shelf:plexLibraryUndo'),
  onSend: (fn) => {
    const listener = (e, m) => fn(m && typeof m === 'object' ? JSON.parse(JSON.stringify(m)) : {});
    ipcRenderer.on('shelf:sendProgress', listener);
    return () => ipcRenderer.removeListener('shelf:sendProgress', listener);
  },
  onProgress: (fn) => {
    const listener = (e, p) => fn({ done: Number(p.done) || 0, total: Number(p.total) || 0 });
    ipcRenderer.on('shelf:progress', listener);
    return () => ipcRenderer.removeListener('shelf:progress', listener);
  }
});
