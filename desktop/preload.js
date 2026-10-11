/*
 * Shelf desktop — the small, fixed list of things the window may ask for.
 * The window never gets direct access to your disk or to Node.
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('shelfNative', {
  platform: process.platform,
  version: () => ipcRenderer.invoke('shelf:version'),
  pickFiles: () => ipcRenderer.invoke('shelf:pickFiles'),
  pickFolder: () => ipcRenderer.invoke('shelf:pickFolder'),
  expandDropped: (files) => ipcRenderer.invoke('shelf:expandDropped', Array.from(files || []).map((f) => {
    try { return webUtils.getPathForFile(f); } catch (e) { return ''; }
  }).filter(Boolean)),
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
