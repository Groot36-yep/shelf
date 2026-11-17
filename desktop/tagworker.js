/*
 * Shelf desktop — reads music tags on a background thread, so a big music folder never makes the window wait.
 * Gets { id, files: [paths] }, answers { id, results: [tags.read(file) for each] }.
 */
'use strict';
const { parentPort } = require('worker_threads');
const tags = require('./tags.js');

parentPort.on('message', (m) => {
  const results = (m.files || []).map((f) => tags.read(f));
  parentPort.postMessage({ id: m.id, results });
});
