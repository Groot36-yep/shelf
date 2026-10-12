/*
 * Shelf's permission window: all it can do is show the question it's given and answer Yes or No.
 * The app only accepts the answer from this window, so the main window can never say yes for you.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shelfConsent', {
  onShow: (fn) => ipcRenderer.once('consent:show', (e, d) => fn({
    kind: String(d.kind || ''), theme: d.theme === 'seventies' ? 'seventies' : 'studio', title: String(d.title || ''), lead: String(d.lead || ''), ok: String(d.ok || ''),
    points: Array.isArray(d.points) ? d.points.slice(0, 5).map((p) => ({ icon: String(p.icon || ''), text: String(p.text || '') })) : [],
    files: Array.isArray(d.files) ? d.files.slice(0, 2000).map(String) : []
  })),
  size: (h) => ipcRenderer.send('consent:size', Number(h) || 0),
  answer: (yes) => ipcRenderer.send('consent:answer', yes === true)
});
