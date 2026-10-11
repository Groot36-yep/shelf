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

contextBridge.exposeInMainWorld('shelfNative', {
  platform: process.platform,
  version: () => ipcRenderer.invoke('shelf:version'),
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
  checkLengths: (paths) => ipcRenderer.invoke('shelf:checkLengths', paths),
  openSplit: (p, also) => ipcRenderer.invoke('shelf:openSplit', p, also),
  closeSplit: (token, endBatch) => ipcRenderer.invoke('shelf:closeSplit', token, endBatch),
  splitSuggest: (token, hints) => ipcRenderer.invoke('shelf:splitSuggest', token, hints),
  splitAround: (token, t) => ipcRenderer.invoke('shelf:splitAround', token, t),
  readCards: (jobs) => ipcRenderer.invoke('shelf:readCards', jobs),
  cancelCards: () => ipcRenderer.invoke('shelf:cancelCards'),
  onCardProgress: (fn) => {
    const listener = (e, p) => fn({
      kind: String(p.kind || ''), path: String(p.path || ''), paths: Array.isArray(p.paths) ? p.paths.map(String) : [],
      index: Number(p.index) || 0, total: Number(p.total) || 0, frac: Number(p.frac) || 0,
      file: String(p.file || ''), stopped: !!p.stopped, result: p.result && typeof p.result === 'object' ? p.result : null
    });
    ipcRenderer.on('shelf:cardProgress', listener);
    return () => ipcRenderer.removeListener('shelf:cardProgress', listener);
  },
  onProgress: (fn) => {
    const listener = (e, p) => fn({ done: Number(p.done) || 0, total: Number(p.total) || 0 });
    ipcRenderer.on('shelf:progress', listener);
    return () => ipcRenderer.removeListener('shelf:progress', listener);
  }
});
