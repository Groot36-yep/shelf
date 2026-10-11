/*
 * Shelf desktop — the only code that touches your files.
 *
 * Safety rules, enforced here (never trusted from the window):
 *  - Only files the user picked in a system dialog (or dropped) can be renamed.
 *  - Every new name is re-cleaned here, and must land inside the chosen library folder.
 *  - Nothing is ever overwritten.
 *  - Every change is written to an undo journal first, so it can be put back.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { safeName, VIDEO_EXT, SUB_EXT } = require('../js/parser.js');

const WANTED = new Set(VIDEO_EXT.concat(SUB_EXT));
const MAX_FILES = 20000;

function isWanted(name) {
  if (name.startsWith('.')) return false;
  const ext = path.extname(name).slice(1).toLowerCase();
  return WANTED.has(ext);
}

/** Expand picked files/folders into a flat list of video + subtitle files. */
async function expand(paths) {
  const out = [];
  async function walk(full, base) {
    if (out.length >= MAX_FILES) return;
    let st;
    try { st = await fsp.lstat(full); } catch (e) { return; }
    if (st.isSymbolicLink()) return; // never follow links out of the chosen folder
    if (st.isDirectory()) {
      let names = [];
      try { names = await fsp.readdir(full); } catch (e) { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const n of names) {
        if (n.startsWith('.') || /^(\$RECYCLE\.BIN|System Volume Information)$/i.test(n)) continue;
        await walk(path.join(full, n), base);
      }
    } else if (st.isFile() && isWanted(path.basename(full))) {
      out.push({
        name: path.basename(full),
        relPath: path.relative(base, full).split(path.sep).join('/'),
        size: st.size,
        fullPath: full
      });
    }
  }
  for (const p of paths) {
    const full = path.resolve(p);
    let st;
    try { st = await fsp.lstat(full); } catch (e) { continue; }
    await walk(full, st.isDirectory() ? path.dirname(full) : path.dirname(full));
  }
  return out;
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch (e) { return false; }
}

/** Move without ever overwriting. Same drive: instant. Other drive: copy, check, then remove. */
async function moveNoOverwrite(from, to) {
  try {
    await fsp.link(from, to); // atomic: fails if `to` exists
    await fsp.unlink(from);
    return;
  } catch (e) {
    if (e.code === 'EEXIST') throw e;
    // Links not supported here (e.g. FAT/exFAT drives, some network shares): fall through.
  }
  if (await exists(to)) { const err = new Error('exists'); err.code = 'EEXIST'; throw err; }
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    const [a, b] = await Promise.all([fsp.stat(from), fsp.stat(to)]);
    if (a.size !== b.size) { await fsp.unlink(to); throw new Error('Copy check failed'); }
    await fsp.unlink(from);
  }
}

async function copyNoOverwrite(from, to) {
  await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  const st = await fsp.stat(from);
  await fsp.utimes(to, st.atime, st.mtime); // same timestamp, so undo can recognise its own copy
}

/**
 * Do the renames.
 * ops: [{ source: fullPath, folder: [segments], file }]
 * opts: { library, mode: 'move'|'copy'|'link', allowed: Set<fullPath>, journalPath, onProgress }
 */
async function run(ops, opts) {
  const library = path.resolve(opts.library);
  const mode = ['move', 'copy', 'link'].includes(opts.mode) ? opts.mode : 'move';
  const results = [];
  const journal = { when: new Date().toISOString(), mode, library, done: [] };
  let n = 0;
  for (const op of ops) {
    n++;
    const res = { source: op.source, ok: false };
    results.push(res);
    try {
      const from = path.resolve(String(op.source));
      if (!opts.allowed || !opts.allowed.has(from)) throw new Error('Not a file you picked');
      if (!Array.isArray(op.folder) || !op.folder.length || op.folder.length > 4) throw new Error('Bad destination');
      const dir = path.join(library, ...op.folder.map(safeName));
      const wantExt = path.extname(String(op.file));
      if (!/^\.[A-Za-z0-9]{2,6}$/.test(wantExt) || wantExt.toLowerCase() !== path.extname(from).toLowerCase()) throw new Error('File type would change');
      const fileName = safeName(String(op.file).slice(0, -wantExt.length)) + wantExt;
      const to = path.join(dir, fileName);
      if (!inside(library, to)) throw new Error('Destination is outside your library');
      if (path.resolve(to) === from) { res.ok = true; res.skipped = 'Already has this name'; continue; }
      if (!(await exists(from))) throw new Error('File not found (was it moved?)');
      if (await exists(to)) { res.skipped = 'A file with this name already exists'; continue; }
      await fsp.mkdir(dir, { recursive: true });
      if (mode === 'move') await moveNoOverwrite(from, to);
      else if (mode === 'copy') await copyNoOverwrite(from, to);
      else await fsp.link(from, to);
      res.ok = true;
      res.to = to;
      journal.done.push({ from, to });
      if (opts.journalPath) await writeJournal(opts.journalPath, journal); // saved as we go
    } catch (e) {
      res.error = e.code === 'EEXIST' ? 'A file with this name already exists' : e.code === 'EXDEV' ? 'Hard links only work on the same drive' : (e.message || String(e));
    }
    if (opts.onProgress) opts.onProgress({ done: n, total: ops.length });
  }
  return { results, journal };
}

async function writeJournal(p, journal) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(journal, null, 1));
  await fsp.rename(tmp, p);
}

async function readJournal(p) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch (e) { return null; }
}

/** Put the last batch back — but never delete or move anything Shelf didn't create. */
async function undo(journalPath) {
  const j = await readJournal(journalPath);
  if (!j || !Array.isArray(j.done) || !j.done.length) return { undone: 0, kept: 0, nothing: true, restored: [] };
  let undone = 0, kept = 0;
  const restored = [];
  for (const { from, to } of j.done.slice().reverse()) {
    try {
      if (!inside(path.resolve(j.library), path.resolve(to))) { kept++; continue; }
      if (j.mode === 'move') {
        if ((await exists(to)) && !(await exists(from))) {
          await fsp.mkdir(path.dirname(from), { recursive: true });
          await moveNoOverwrite(to, from);
          restored.push(from);
          undone++;
        } else kept++;
      } else {
        const [a, b] = await Promise.all([fsp.stat(from), fsp.stat(to)]);
        const same = j.mode === 'link'
          ? a.ino === b.ino && a.dev === b.dev
          : a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000;
        if (same) { await fsp.unlink(to); undone++; } else kept++;
      }
      await removeEmptyDirs(path.dirname(to), j.library);
    } catch (e) { kept++; }
  }
  await fsp.unlink(journalPath).catch(() => {});
  return { undone, kept, restored };
}

// Tidy up folders Shelf made that are now empty (never the library itself).
async function removeEmptyDirs(dir, library) {
  library = path.resolve(library);
  while (inside(library, dir)) {
    try { await fsp.rmdir(dir); } catch (e) { return; }
    dir = path.dirname(dir);
  }
}

module.exports = { expand, run, undo, readJournal, inside };
