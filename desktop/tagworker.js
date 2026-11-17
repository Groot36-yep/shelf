/*
 * Shelf desktop — reads music tags on a background thread, so a big music folder never makes the window wait.
 * Gets { id, files: [paths] } → { id, results: [tags.read(file) for each] },
 * or { id, covers: [paths] } → { id, covers: [{ mime, data } | null] } (each song's own cover picture).
 */
'use strict';
const { parentPort } = require('worker_threads');
const tags = require('./tags.js');

parentPort.on('message', (m) => {
  if (m.covers) {
    parentPort.postMessage({ id: m.id, covers: m.covers.map((f) => tags.cover(f)) });
    return;
  }
  const results = (m.files || []).map((f) => tags.read(f));
  parentPort.postMessage({ id: m.id, results });
});
