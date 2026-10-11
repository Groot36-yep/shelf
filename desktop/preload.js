/*
 * Shelf desktop — the small, fixed list of things the window may ask for.
 * The window never gets direct access to your disk or to Node.
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('shelfNative', {
  platform: process.platform,
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
  getKey: () => ipcRenderer.invoke('shelf:getKey'),
  setKey: (k) => ipcRenderer.invoke('shelf:setKey', k),
  eraseAll: () => ipcRenderer.invoke('shelf:eraseAll'),
  onProgress: (fn) => {
    const listener = (e, p) => fn({ done: Number(p.done) || 0, total: Number(p.total) || 0 });
    ipcRenderer.on('shelf:progress', listener);
    return () => ipcRenderer.removeListener('shelf:progress', listener);
  }
});
