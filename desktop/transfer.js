/*
 * Shelf desktop — "Server Files": copy files and folders between your Plex server and this PC, like FileZilla.
 * The SSH work is in server.js; the saved server and its login come from plexsend.js.
 *
 * Safety:
 *  - Nothing goes anywhere but your own server, over the same encrypted SSH connection as Send to Plex.
 *  - Copies arrive under a temporary name (".name.shelf-part") and only get their real name once every
 *    byte is there (and checked), so there are never half files. A paused copy picks up where it stopped.
 *  - Nothing is overwritten unless you said Replace.
 *  - Shelf won't save into Windows' own folders, and won't delete the top of your server's disk, your home
 *    folder or your Plex library folders themselves.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const posix = path.posix;
const os = require('os');
const crypto = require('crypto');
const S = require('./server');

const MAX_FILES = 50000;
const MAX_LIST = 20000;
const PART = '.shelf-part';
const HIDE_LOCAL = /^(desktop\.ini|thumbs\.db|\$recycle\.bin|system volume information|\$windows\.~bt|\$winreagent)$/i;
const problem = S.problem;

// ---- Names ----
/** A single file or folder name typed in the window, or '' if it won't do. */
function cleanName(n) {
  n = String(n == null ? '' : n).trim();
  if (!n || n === '.' || n === '..' || n.length > 240 || /[\/\\\0\n\r]/.test(n)) return '';
  return n;
}
/** A name from the server, made safe to save on Windows (characters Windows refuses become "_"). */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
function winSafe(n) {
  let s = String(n).replace(/[<>:"|?*\\\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!s) s = '_';
  if (RESERVED.test(s)) s = '_' + s;
  return s.slice(0, 240);
}
/** "Name (2).mkv" — the next free name for Keep Both. taken(name) says whether a name is in use. */
function keepBothName(name, taken, isDir) {
  const ext = isDir ? '' : path.extname(name);
  const base = ext && ext.length < name.length ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 10000; i++) {
    const n = base + ' (' + i + ')' + (ext.length < name.length ? ext : '');
    if (!taken(n)) return n;
  }
  return base + ' (' + crypto.randomBytes(3).toString('hex') + ')' + ext;
}
/** Same size and modified within 2 seconds (FAT drives and some servers round times). Times are seconds. */
function sameFile(a, b) {
  return !!a && !!b && Number(a.size) === Number(b.size) && Math.abs((Number(a.mtime) || 0) - (Number(b.mtime) || 0)) < 2;
}
/** The deepest folder that holds all of these server folders ('' if none). */
function commonParent(list) {
  const parts = list.filter(Boolean).map((p) => posix.dirname(p).split('/').filter(Boolean));
  if (!parts.length) return '';
  const out = [];
  for (let i = 0; i < parts[0].length; i++) { const x = parts[0][i]; if (parts.every((p) => p[i] === x)) out.push(x); else break; }
  return '/' + out.join('/');
}
const partOfRemote = (f) => posix.join(posix.dirname(f), '.' + posix.basename(f) + PART);
const partOfLocal = (f) => path.join(path.dirname(f), '.' + path.basename(f) + PART);
const lowerKey = (n) => (process.platform === 'win32' ? String(n).toLowerCase() : String(n));

/** Windows' own folders: Shelf never saves copies there. */
function systemFolder(p) {
  const env = process.env;
  const roots = [env.SystemRoot || env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData].filter(Boolean).map((r) => path.resolve(r).toLowerCase());
  const q = path.resolve(p).toLowerCase();
  return roots.some((r) => q === r || q.startsWith(r + path.sep));
}

// A few at a time.
async function eachLimit(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } }));
}

// ---- What's in a folder ----
async function listRemote(s, dir) {
  const raw = await s.p((cb) => s.sftp.readdir(dir, cb));
  const out = [];
  await eachLimit(raw.slice(0, MAX_LIST), 8, async (e) => {
    const name = e.filename;
    if (name === '.' || name === '..' || name.startsWith('.')) return;
    let a = e.attrs, link = false;
    if (a.isSymbolicLink()) { link = true; a = await s.stat(posix.join(dir, name)).catch(() => null); if (!a) return; }
    const isDir = a.isDirectory();
    if (!isDir && !a.isFile()) return;
    out.push({ name, dir: isDir, size: isDir ? 0 : Number(a.size) || 0, mtime: Number(a.mtime) || 0, link });
  });
  return out;
}
async function drives() {
  const out = [];
  await eachLimit('CDEFGHIJKLMNOPQRSTUVWXYZAB'.split(''), 6, async (l) => {
    const root = l + ':\\';
    const ok = await Promise.race([fsp.stat(root).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 1500))]);
    if (ok) out.push({ name: l + ':', path: root, dir: true, size: 0, mtime: 0, drive: true });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
async function listLocal(dir) {
  const names = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  await eachLimit(names.slice(0, MAX_LIST), 16, async (d) => {
    const name = d.name;
    if (name.startsWith('.') || HIDE_LOCAL.test(name)) return;
    const st = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (!st || (!st.isDirectory() && !st.isFile())) return;
    out.push({ name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: Math.floor(st.mtimeMs / 1000), link: d.isSymbolicLink() });
  });
  return out;
}
/** Every file under a server folder: [{ rel, src, size, mtime }] and its folders [rel]. */
async function walkRemote(s, top, out, dirs, rel, depth) {
  if (out.length >= MAX_FILES || depth > 40) return;
  const list = await listRemote(s, top);
  for (const e of list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const r = rel ? rel + '/' + e.name : e.name;
    const full = posix.join(top, e.name);
    if (e.dir) { if (e.link) continue; dirs.push(r); await walkRemote(s, full, out, dirs, r, depth + 1); }
    else if (out.length < MAX_FILES) out.push({ rel: r, src: full, size: e.size, mtime: e.mtime });
  }
}
async function walkLocal(top, out, dirs, rel, depth) {
  if (out.length >= MAX_FILES || depth > 40) return;
  let names = [];
  try { names = await fsp.readdir(top, { withFileTypes: true }); } catch (e) { return; }
  names.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const d of names) {
    if (d.name.startsWith('.') || HIDE_LOCAL.test(d.name) || d.isSymbolicLink()) continue;
    const r = rel ? rel + '/' + d.name : d.name;
    const full = path.join(top, d.name);
    if (d.isDirectory()) { dirs.push(r); await walkLocal(full, out, dirs, r, depth + 1); }
    else if (d.isFile() && out.length < MAX_FILES) {
      const st = await fsp.stat(full).catch(() => null);
      if (st) out.push({ rel: r, src: full, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
    }
  }
}

// ---- Copying one file from the server to this PC (resumes; written in order, so a stopped copy is a clean start) ----
function pullPump(s, rh, fh, offset, size, hash, o) {
  const sftp = s.sftp;
  const CHUNK = 128 * 1024, MAX_IN_FLIGHT = 24, stall = s.stallMs || 60000;
  return new Promise((resolve, reject) => {
    let next = offset, writeAt = offset, inFlight = 0, failed = false, writing = false;
    const ready = new Map();
    let moved = Date.now();
    const watch = setInterval(() => { if (inFlight && Date.now() - moved > stall) fail(problem('LOST', 'The connection stopped moving.')); }, Math.min(5000, stall / 3));
    function fail(e) { if (failed) return; failed = true; clearInterval(watch); reject(e); }
    function flush() {
      if (writing || failed) return;
      if (writeAt >= size) { clearInterval(watch); failed = true; return resolve(); }
      const first = ready.get(writeAt);
      if (!first) return;
      const bufs = [first]; let len = first.length;
      ready.delete(writeAt);
      while (len < 4 * 1024 * 1024 && ready.has(writeAt + len)) { const b = ready.get(writeAt + len); ready.delete(writeAt + len); bufs.push(b); len += b.length; }
      const all = bufs.length === 1 ? first : Buffer.concat(bufs, len);
      writing = true;
      fh.write(all, 0, len, writeAt).then(() => {
        writing = false; hash.update(all); writeAt += len;
        if (o.onBytes) o.onBytes(len);
        flush(); ask();
      }, (e) => { writing = false; fail(e); });
    }
    function read(at, len) {
      const buf = Buffer.allocUnsafe(len);
      inFlight++;
      sftp.read(rh, buf, 0, len, at, (err, n) => {
        inFlight--; moved = Date.now();
        if (failed) return;
        if (err) return fail(err);
        if (!n) return fail(problem('LOST', 'This file got shorter on the server while it was being copied.'));
        ready.set(at, n === len ? buf : buf.subarray(0, n));
        if (n < len) read(at + n, len - n);
        flush(); ask();
      });
    }
    function ask() {
      if (failed) return;
      if (o.stopped && o.stopped()) return fail(problem('STOPPED', 'Stopped'));
      while (inFlight < MAX_IN_FLIGHT && next < size && ready.size < MAX_IN_FLIGHT * 2) {
        const at = next, len = Math.min(CHUNK, size - at);
        next += len;
        read(at, len);
      }
    }
    if (offset >= size) { clearInterval(watch); return resolve(); }
    ask();
  });
}
/** remote → part (on this PC), picking up where an earlier copy stopped. Returns 'sha256' | 'size'. */
async function pull(s, remote, part, size, o) {
  o = o || {};
  const old = await fsp.stat(part).catch(() => null);
  const offset = old && old.isFile() && old.size <= size ? old.size : 0;
  const hash = crypto.createHash('sha256');
  const fh = await fsp.open(part, offset ? 'r+' : 'w');
  let rh = null;
  try {
    if (offset) {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (let pos = 0; pos < offset;) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, offset - pos), pos);
        if (!bytesRead) break;
        hash.update(buf.subarray(0, bytesRead)); pos += bytesRead;
      }
      if (o.onBytes) o.onBytes(offset);
    }
    rh = await s.p((cb) => s.sftp.open(remote, 'r', cb));
    await pullPump(s, rh, fh, offset, size, hash, o);
  } finally {
    await fh.close().catch(() => {});
    if (rh) await s.p((cb) => s.sftp.close(rh, cb)).catch(() => {});
  }
  if (o.stopped && o.stopped()) throw problem('STOPPED', 'Stopped');
  const got = await fsp.stat(part);
  if (got.size !== size) throw problem('LOST', 'The file didn’t arrive complete.');
  if (o.verify === false) return 'size';
  if (o.onCheck) o.onCheck();
  const theirs = await s.sha256(remote);
  if (!theirs) return 'size';
  if (theirs !== hash.digest('hex')) { await fsp.rm(part, { force: true }); throw problem('BAD_COPY', 'The copy on this PC didn’t match the server’s. It was removed so it can be copied again.'); }
  return 'sha256';
}

/** Delete a server file or folder (and everything in it). Shortcuts are removed, never followed. */
async function removeRemote(s, p, depth) {
  const st = await s.p((cb) => s.sftp.lstat(p, cb)).catch((e) => { if (e.code === 2) return null; throw e; });
  if (!st) return;
  if (st.isDirectory() && (depth || 0) < 60) {
    const kids = await s.p((cb) => s.sftp.readdir(p, cb));
    for (const k of kids) if (k.filename !== '.' && k.filename !== '..') await removeRemote(s, posix.join(p, k.filename), (depth || 0) + 1);
    await s.p((cb) => s.sftp.rmdir(p, cb));
  } else await s.unlink(p);
}

function setup(ctx, api) {
  const { app, log, send, readPrefs } = ctx;
  const { withSession, cfg, getSecret, handle } = api;
  const host = () => (cfg() || {}).host || '';
  const verifyOn = () => (((cfg() || {}).options || {}).verify) !== false;

  // ---- Where things are ----
  function serverPlaces(home) {
    const c = cfg() || {};
    const out = [];
    const add = (label, p, kind) => { p = S.cleanRoot(p); if (p && !out.some((x) => x.path === p)) out.push({ label, path: p, kind }); };
    add('Movies', c.movies, 'movies'); add('TV Shows', c.tv, 'tv'); add('Music', c.music, 'music');
    for (const l of c.libraries || []) for (const f of l.folders || []) add(l.title || f, f, l.kind);
    add('Home', home || c.home, 'home');
    return out;
  }
  function serverStart(home) {
    const c = cfg() || {};
    const roots = [c.movies, c.tv, c.music].concat(...(c.libraries || []).map((l) => l.folders || [])).map(S.cleanRoot).filter(Boolean);
    if (!roots.length) return home || c.home || '/';
    const common = roots.length > 1 ? commonParent(roots) : posix.dirname(roots[0]);
    return common && common !== '/' ? common : roots[0];
  }
  function pcPlaces() {
    const get = (n) => { try { return app.getPath(n); } catch (e) { return ''; } };
    const out = [];
    const add = (label, p, kind) => { if (p && fs.existsSync(p) && !out.some((x) => x.path === p)) out.push({ label, path: p, kind }); };
    add('Videos', get('videos'), 'videos'); add('Music', get('music'), 'music'); add('Downloads', get('downloads'), 'downloads');
    add('Desktop', get('desktop'), 'desktop'); add('Home', get('home') || os.homedir(), 'home');
    const lib = readPrefs ? readPrefs().library : '';
    if (lib) add('Shelf Library', lib, 'library');
    return out;
  }
  function localDir(p) {
    if (typeof p !== 'string' || !p || /[\0\n\r]/.test(p) || !path.isAbsolute(p)) return '';
    return path.resolve(p);
  }

  handle('shelf:xferStart', async () => {
    const c = cfg();
    if (!c || !c.fingerprint) throw problem('NO_SERVER', 'Set up your Plex server first.');
    const home = c.home || await withSession((s) => s.home());
    const places = pcPlaces();
    const vids = places.find((x) => x.kind === 'videos') || places.find((x) => x.kind === 'home');
    return { host: c.host, server: { start: serverStart(home), home, places: serverPlaces(home) }, pc: { start: vids ? vids.path : os.homedir(), places, drives: process.platform === 'win32' }, queue: snapshot() };
  });

  // A folder on the server: { path, parent, entries } or why it couldn't be opened.
  handle('shelf:xferListServer', async (where) => withSession(async (s) => {
    const at = S.cleanRoot(where) || (cfg() || {}).home || await s.home();
    const st = await s.stat(at).catch((e) => { throw S.friendly(e, host()); });
    if (!st) throw problem('MISSING', 'That folder isn’t on the server any more.');
    if (!st.isDirectory()) throw problem('FOLDER', 'That’s a file, not a folder.');
    const entries = await listRemote(s, at).catch((e) => { throw S.friendly(e, host()); });
    return { path: at, parent: at === '/' ? '' : posix.dirname(at), entries };
  }));
  // A folder on this PC ('' = the list of drives).
  handle('shelf:xferListPC', async (where) => {
    if (!where && process.platform === 'win32') return { path: '', parent: null, entries: await drives() };
    const at = localDir(where) || os.homedir();
    let entries;
    try { entries = await listLocal(at); } catch (e) {
      if (e.code === 'ENOENT') throw problem('MISSING', 'That folder isn’t there any more.');
      if (e.code === 'EPERM' || e.code === 'EACCES') throw problem('FOLDER', 'Windows won’t let Shelf open that folder.');
      if (e.code === 'ENOTDIR') throw problem('FOLDER', 'That’s a file, not a folder.');
      throw problem('OTHER', 'Couldn’t open that folder.');
    }
    const parent = path.dirname(at);
    return { path: at, parent: parent === at ? (process.platform === 'win32' ? '' : null) : parent, entries };
  });

  handle('shelf:xferMkdir', async (side, where, name) => {
    name = cleanName(name);
    if (!name) throw problem('NAME', 'That folder name won’t work.');
    if (side === 'pc') {
      const at = localDir(where);
      if (!at) throw problem('FOLDER', 'Open a folder first.');
      if (systemFolder(at)) throw problem('FOLDER', 'Shelf doesn’t make folders inside Windows’ own folders.');
      const full = path.join(at, winSafe(name));
      try { await fsp.mkdir(full); } catch (e) { throw problem(e.code === 'EEXIST' ? 'EXISTS' : 'FOLDER', e.code === 'EEXIST' ? 'There’s already something called “' + name + '” here.' : 'Couldn’t make that folder here.'); }
      return full;
    }
    return withSession(async (s) => {
      const at = S.cleanRoot(where);
      if (!at) throw problem('FOLDER', 'Open a folder first.');
      const full = posix.join(at, name);
      if (await s.stat(full)) throw problem('EXISTS', 'There’s already something called “' + name + '” here.');
      await s.p((cb) => s.sftp.mkdir(full, cb));
      return full;
    });
  });
  handle('shelf:xferRename', async (where, from, to) => withSession(async (s) => {
    const at = S.cleanRoot(where); from = cleanName(from); to = cleanName(to);
    if (!at || !from) throw problem('NAME', 'Pick something to rename.');
    if (!to) throw problem('NAME', 'That name won’t work.');
    if (from === to) return posix.join(at, to);
    const a = posix.join(at, from), b = posix.join(at, to);
    if (protectedRemote(a)) throw problem('FOLDER', 'That’s one of your Plex library folders. Shelf leaves its name alone.');
    if (!(await s.stat(a))) throw problem('MISSING', '“' + from + '” isn’t there any more.');
    if (from.toLowerCase() !== to.toLowerCase() && await s.stat(b)) throw problem('EXISTS', 'There’s already something called “' + to + '” here.');
    await s.p((cb) => s.sftp.rename(a, b, cb)).catch((e) => { throw S.friendly(e, host()); });
    return b;
  }));
  // Never: the top of the disk, folders right under it (/home, /mnt…), your home folder, or a Plex library folder itself.
  function protectedRemote(p) {
    const c = cfg() || {};
    const keep = [c.home, c.movies, c.tv, c.music].concat(...(c.libraries || []).map((l) => l.folders || [])).map(S.cleanRoot).filter(Boolean);
    return p.split('/').filter(Boolean).length < 2 || keep.includes(p);
  }
  handle('shelf:xferDelete', async (paths) => {
    const list = (Array.isArray(paths) ? paths : []).slice(0, 1000).map(S.cleanRoot).filter(Boolean);
    if (!list.length) return { deleted: 0, failed: [] };
    const bad = list.find(protectedRemote);
    if (bad) throw problem('FOLDER', '“' + posix.basename(bad) + '” is a folder Shelf won’t delete (it’s one of your Plex library folders, your home folder, or a main folder of the server).');
    const failed = [];
    let deleted = 0;
    await withSession(async (s) => {
      for (const p of list) {
        try { await removeRemote(s, p); deleted++; } catch (e) { failed.push({ name: posix.basename(p), why: S.friendly(e, host()).message }); }
      }
    });
    log('Server Files: deleted ' + deleted + ' item' + (deleted === 1 ? '' : 's') + (failed.length ? ', ' + failed.length + ' couldn’t be' : ''));
    return { deleted, failed };
  });

  // ---- A copy, before it starts: what's in it, and what's already at the other end ----
  const plans = new Map();
  let nextPlan = 1;
  // direction: 'down' (server → this PC) or 'up' (this PC → server). sources: paths on the side they come from.
  handle('shelf:xferPlan', async (direction, sources, dest) => {
    if (direction !== 'down' && direction !== 'up') throw new Error('Bad direction');
    const srcs = (Array.isArray(sources) ? sources : []).slice(0, 5000);
    const jobs = [];
    const work = async (s) => {
      // Where they go.
      let destDir;
      if (direction === 'down') {
        destDir = localDir(dest);
        const st = destDir && await fsp.stat(destDir).catch(() => null);
        if (!st || !st.isDirectory()) throw problem('FOLDER', 'Open the folder on this PC to copy into first.');
        if (systemFolder(destDir)) throw problem('FOLDER', 'Shelf won’t save files inside Windows’ own folders. Pick another folder.');
      } else {
        destDir = S.cleanRoot(dest);
        const st = destDir && await s.stat(destDir);
        if (!st || !st.isDirectory()) throw problem('FOLDER', 'Open the folder on the server to copy into first.');
      }
      // What goes.
      for (const raw of srcs) {
        if (direction === 'down') {
          const src = S.cleanRoot(raw);
          if (!src || src === '/') continue;
          const st = await s.stat(src).catch(() => null);
          if (!st) continue;
          const name = posix.basename(src), files = [], dirs = [];
          if (st.isDirectory()) await walkRemote(s, src, files, dirs, '', 0);
          else if (st.isFile()) files.push({ rel: '', src, size: Number(st.size) || 0, mtime: Number(st.mtime) || 0 });
          else continue;
          jobs.push({ name, isDir: st.isDirectory(), from: src, files, dirs, top: winSafe(name) });
        } else {
          const src = localDir(raw);
          if (!src) continue;
          const st = await fsp.stat(src).catch(() => null);
          if (!st) continue;
          const name = path.basename(src) || src.replace(/[:\\]/g, ''), files = [], dirs = [];
          if (st.isDirectory()) await walkLocal(src, files, dirs, '', 0);
          else if (st.isFile()) files.push({ rel: '', src, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
          else continue;
          jobs.push({ name, isDir: st.isDirectory(), from: src, files, dirs, top: cleanName(name) || 'Copy' });
        }
      }
      // Where each file lands, and what's already there (each folder is looked at once).
      const seen = new Map();
      const existing = async (dir) => {
        if (seen.has(dir)) return seen.get(dir);
        let m = new Map();
        try {
          const list = direction === 'down' ? await listLocalAll(dir) : await listRemoteAll(s, dir);
          m = new Map(list.map((e) => [lowerKey(e.name), e]));
        } catch (e) { /* not there yet: nothing in it */ }
        seen.set(dir, m);
        return m;
      };
      const join = direction === 'down' ? path.join : posix.join;
      let conflicts = 0, same = 0;
      const names = [];
      for (const j of jobs) {
        j.dest = destDir;
        const there = (await existing(destDir)).get(lowerKey(j.top));
        if (there && there.dir !== j.isDir) { j.blocked = j.isDir ? 'There’s a file called “' + j.top + '” where this folder would go.' : 'There’s a folder called “' + j.top + '” where this file would go.'; }
        for (const f of j.files) {
          const parts = f.rel ? f.rel.split('/') : [];
          const segs = direction === 'down' ? parts.map(winSafe) : parts;
          f.dst = f.rel ? join(destDir, j.top, ...segs) : join(destDir, j.top);
          const dir = direction === 'down' ? path.dirname(f.dst) : posix.dirname(f.dst);
          const base = direction === 'down' ? path.basename(f.dst) : posix.basename(f.dst);
          const e = j.blocked ? null : (await existing(dir)).get(lowerKey(base));
          if (!e) continue;
          if (e.dir) { f.blocked = 'There’s a folder with this name where the file would go.'; continue; }
          f.conflict = { same: sameFile(f, e) };
          conflicts++; if (f.conflict.same) same++;
          if (names.length < 6 && !f.conflict.same) names.push(f.rel ? f.rel.split('/').pop() : j.top); // the ones you're asked about
        }
      }
      return { conflicts, same, names };
    };
    const r = await withSession(work);
    const id = nextPlan++;
    plans.set(id, { direction, jobs, at: Date.now() });
    for (const [k, v] of plans) if (Date.now() - v.at > 30 * 60000) plans.delete(k);
    const files = jobs.reduce((n, j) => n + j.files.length, 0), bytes = jobs.reduce((n, j) => n + j.files.reduce((m, f) => m + f.size, 0), 0);
    let free = null;
    if (direction === 'up' && jobs.length) free = await withSession((s) => s.free(jobs[0].dest)).catch(() => null);
    return { id, direction, items: jobs.length, files, folders: jobs.reduce((n, j) => n + (j.isDir ? 1 : 0), 0), bytes, conflicts: r.conflicts, same: r.same, names: r.names, free,
      blocked: jobs.filter((j) => j.blocked).map((j) => j.blocked).slice(0, 3) };
  });
  async function listRemoteAll(s, dir) {
    const raw = await s.p((cb) => s.sftp.readdir(dir, cb));
    return raw.filter((e) => e.filename !== '.' && e.filename !== '..').map((e) => ({ name: e.filename, dir: e.attrs.isDirectory(), size: Number(e.attrs.size) || 0, mtime: Number(e.attrs.mtime) || 0 }));
  }
  async function listLocalAll(dir) {
    const names = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    await eachLimit(names, 16, async (d) => {
      const st = await fsp.stat(path.join(dir, d.name)).catch(() => null);
      if (st) out.push({ name: d.name, dir: st.isDirectory(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
    });
    return out;
  }

  // policy: { same: 'skip' | 'ask', other: 'skip' | 'replace' | 'both' } — what to do with files already there.
  handle('shelf:xferGo', async (id, policy) => {
    const plan = plans.get(Number(id));
    if (!plan) throw problem('OTHER', 'That copy was already started (or it’s too old). Try again.');
    plans.delete(Number(id));
    policy = policy || {};
    const other = ['skip', 'replace', 'both'].includes(policy.other) ? policy.other : 'skip';
    const skipSame = policy.same !== 'ask';
    for (const j of plan.jobs) {
      const taken = new Map(); // folder → names given out by Keep Both
      for (const f of j.files) {
        if (j.blocked) { f.state = 'failed'; f.error = j.blocked; continue; }
        if (f.blocked) { f.state = 'failed'; f.error = f.blocked; continue; }
        f.state = 'waiting';
        if (!f.conflict) continue;
        const how = f.conflict.same && skipSame ? 'skip' : other;
        if (how === 'skip') { f.state = 'skipped'; continue; }
        if (how === 'replace') { f.replace = true; continue; }
        const dir = plan.direction === 'down' ? path.dirname(f.dst) : posix.dirname(f.dst);
        const base = plan.direction === 'down' ? path.basename(f.dst) : posix.basename(f.dst);
        if (!taken.has(dir)) taken.set(dir, new Set());
        const names = taken.get(dir);
        f.dst = (plan.direction === 'down' ? path.join : posix.join)(dir, keepBothName(base, (n) => names.has(lowerKey(n)) || existsSyncish(plan.direction, dir, n), false));
        names.add(lowerKey(base)); names.add(lowerKey(plan.direction === 'down' ? path.basename(f.dst) : posix.basename(f.dst)));
        f.both = true;
      }
      addJob(plan.direction, j);
    }
    // Keep Both on the server: the names are checked once more just before each copy.
    kick();
    return snapshot();
  });
  // For this PC the free name is known now; for the server it's checked again right before the copy.
  function existsSyncish(direction, dir, n) { return direction === 'down' ? fs.existsSync(path.join(dir, n)) : false; }

  // ---- The queue: one file at a time, as fast as the network goes ----
  let jobs = [], nextJob = 1, running = false;
  let conn = null, opening = null, idle = null;
  async function open() {
    clearTimeout(idle);
    if (conn && !conn.closed) return conn;
    if (opening) return opening;
    opening = api.connect();
    try { conn = await opening; } finally { opening = null; }
    return conn;
  }
  function hangUpLater() {
    clearTimeout(idle);
    idle = setTimeout(() => { if (!running && conn) { conn.close(); conn = null; } }, 30000);
  }
  function dropConn() { if (conn) { conn.close(); conn = null; } }

  function addJob(direction, j) {
    const job = {
      id: nextJob++, direction, name: j.name, isDir: j.isDir, from: j.from, to: j.dest, files: j.files, dirs: j.dirs || [], top: j.top,
      state: 'waiting', stop: null, cur: 0, current: '', note: '', rate: 0, phase: ''
    };
    if (!job.files.some((f) => f.state === 'waiting') && !job.isDir) job.state = job.files.some((f) => f.state === 'failed') ? 'failed' : 'done';
    jobs.push(job);
    emit(true);
    return job;
  }
  const counted = (j) => j.files.reduce((n, f) => n + (f.state === 'done' || f.state === 'skipped' ? f.size : 0), 0);
  function view(j) {
    const total = j.files.reduce((n, f) => n + f.size, 0);
    const done = Math.min(total, counted(j) + j.cur);
    const failed = j.files.filter((f) => f.state === 'failed');
    return {
      id: j.id, direction: j.direction, name: j.name, isDir: j.isDir, from: j.from, to: j.to, state: j.state, phase: j.phase,
      files: j.files.length, filesDone: j.files.filter((f) => f.state === 'done').length, filesSkipped: j.files.filter((f) => f.state === 'skipped').length,
      filesFailed: failed.length, bytesTotal: total, bytesDone: done, rate: Math.round(j.state === 'running' ? j.rate : 0),
      eta: j.state === 'running' && j.rate > 1 ? Math.round((total - done) / j.rate) : 0,
      current: j.current, note: j.note, errors: failed.slice(0, 5).map((f) => ({ name: f.rel ? f.rel.split('/').pop() : j.name, why: f.error || '' }))
    };
  }
  function snapshot() { return { running, jobs: jobs.map(view) }; }
  let lastEmit = 0, emitTimer = null;
  function emit(now) {
    const go = () => { lastEmit = Date.now(); emitTimer = null; send(snapshot()); };
    if (now) { clearTimeout(emitTimer); return go(); }
    if (emitTimer) return;
    emitTimer = setTimeout(go, Math.max(0, 200 - (Date.now() - lastEmit)));
  }

  function kick() { if (!running) run().catch((e) => log('Server Files: ' + (S.friendly(e, '').code || 'OTHER'))); }
  async function run() {
    running = true;
    try {
      for (;;) {
        const job = jobs.find((j) => j.state === 'waiting');
        if (!job) break;
        await runJob(job);
      }
    } finally { running = false; hangUpLater(); emit(true); }
  }

  const WAIT = [2, 5, 10, 20, 30, 60];
  async function runJob(job) {
    job.state = 'running'; job.note = ''; job.rate = 0; job.cur = 0;
    emit(true);
    let lastAt = Date.now(), lastBytes = counted(job);
    const tick = () => {
      const now = Date.now(), b = counted(job) + job.cur;
      if (now - lastAt >= 500) { const r = (b - lastBytes) / ((now - lastAt) / 1000); job.rate = job.rate ? job.rate * 0.7 + r * 0.3 : r; lastAt = now; lastBytes = b; }
      emit();
    };
    const touched = new Set();
    try {
      if (conn) conn.dirs = null; // folders may have changed since
      // Folders first (so empty ones come along too).
      if (job.isDir && !job.stop) await withRetry(job, async (s) => {
        const join = job.direction === 'down' ? path.join : posix.join;
        const segs = (r) => (job.direction === 'down' ? r.split('/').map(winSafe) : r.split('/'));
        const all = [join(job.to, job.top)].concat(job.dirs.map((r) => join(job.to, job.top, ...segs(r))));
        for (const d of all) {
          if (job.direction === 'down') await fsp.mkdir(d, { recursive: true });
          else await s.mkdirp(d);
        }
      });
      for (const f of job.files) {
        if (job.stop) break;
        if (f.state !== 'waiting') continue;
        job.current = f.rel || job.name; job.cur = 0; job.phase = 'copy';
        lastBytes = counted(job); lastAt = Date.now();
        emit();
        try {
          await withRetry(job, async (s) => {
            job.cur = 0;
            const opts = { verify: verifyOn(), stopped: () => !!job.stop, onBytes: (n) => { job.cur += n; tick(); }, onCheck: () => { job.phase = 'check'; emit(); } };
            if (job.direction === 'up') await copyUp(s, f, opts); else await copyDown(s, f, opts);
          });
          if (f.state === 'waiting') f.state = 'done';
          if (job.direction === 'up') touched.add(posix.dirname(f.dst));
        } catch (e) {
          const err = S.friendly(e, host());
          if (err.code === 'STOPPED') break;
          f.state = 'failed'; f.error = err.message;
          log('Server Files: a file didn’t copy (' + (err.code || 'OTHER') + ')'); // never names or paths
          if (/^(HOST_|AUTH|NO_LOGIN|NO_SERVER)/.test(err.code)) { job.files.forEach((x) => { if (x.state === 'waiting') { x.state = 'failed'; x.error = err.message; } }); break; }
        } finally { if (!(job.stop && f.state === 'waiting')) job.cur = 0; job.phase = ''; } // paused: what arrived still shows
      }
    } catch (e) {
      const err = S.friendly(e, host());
      if (err.code !== 'STOPPED') job.files.forEach((x) => { if (x.state === 'waiting') { x.state = 'failed'; x.error = err.message; } });
    }
    job.current = ''; job.note = ''; job.rate = 0;
    const stop = job.stop; job.stop = null;
    if (stop === 'cancel') await cancelled(job);
    else if (stop === 'pause') job.state = 'paused';
    else job.state = job.files.some((f) => f.state === 'failed') ? 'failed' : job.files.some((f) => f.state === 'waiting') ? 'paused' : 'done';
    emit(true);
    // New files in your Plex library: Plex is asked to look (if you turned that on for Send to Plex).
    if (touched.size && job.direction === 'up') rescan([...touched]).catch(() => {});
  }
  async function rescan(dirs) {
    const c = cfg() || {}, token = getSecret('plex');
    if (!token || ((c.options || {}).scan === false) || !(c.libraries || []).length) return;
    await withSession((s) => S.plexRefresh(s, token, c.libraries, dirs));
  }
  // A dropped connection, the server restarting, Wi-Fi coming back: tries again for about two minutes.
  async function withRetry(job, fn) {
    for (let attempt = 0; ; attempt++) {
      try { const s = await open(); return await fn(s); } catch (e) {
        const err = S.friendly(e, host());
        if (err.code === 'STOPPED' || job.stop) throw problem('STOPPED', 'Stopped');
        const again = (err.code === 'LOST' || err.code === 'UNREACHABLE') && attempt < WAIT.length;
        if (err.code === 'LOST' || err.code === 'UNREACHABLE') dropConn();
        if (!again) throw err;
        for (let left = WAIT[attempt]; left > 0 && !job.stop; left--) {
          job.note = 'Connection dropped. Trying again in ' + left + ' second' + (left === 1 ? '' : 's') + ' (' + (attempt + 1) + ' of ' + WAIT.length + ')…';
          emit();
          await new Promise((r) => setTimeout(r, 1000));
        }
        job.note = '';
        if (job.stop) throw problem('STOPPED', 'Stopped');
      }
    }
  }
  async function copyUp(s, f, o) {
    const mine = await fsp.stat(f.src).catch(() => null);
    if (!mine || !mine.isFile()) throw problem('MISSING', 'That file isn’t on this PC any more.');
    f.size = mine.size; f.mtime = Math.floor(mine.mtimeMs / 1000);
    const there = await s.stat(f.dst);
    if (there && f.both) { // Keep Both: a name nobody has taken since
      const dir = posix.dirname(f.dst), list = await listRemoteAll(s, dir).catch(() => []);
      const names = new Set(list.map((e) => lowerKey(e.name)));
      f.dst = posix.join(dir, keepBothName(posix.basename(f.dst), (n) => names.has(lowerKey(n)), false));
    } else if (there && there.isDirectory()) throw problem('EXISTS', 'There’s a folder with this name on the server.');
    else if (there && !f.replace) {
      if (sameFile(f, { size: there.size, mtime: there.mtime })) { f.state = 'skipped'; return; }
      throw problem('EXISTS', 'A file with this name showed up on the server meanwhile, so it was left alone.');
    }
    await s.upload(f.src, f.dst, { verify: o.verify, replace: !!f.replace, stopped: o.stopped, onBytes: o.onBytes, onCheck: o.onCheck });
    await s.p((cb) => s.sftp.utimes(f.dst, f.mtime, f.mtime, cb)).catch(() => {}); // the same date as on this PC
  }
  async function copyDown(s, f, o) {
    const st = await s.stat(f.src);
    if (!st || !st.isFile()) throw problem('MISSING', 'That file isn’t on the server any more.');
    f.size = Number(st.size) || 0; f.mtime = Number(st.mtime) || 0;
    await fsp.mkdir(path.dirname(f.dst), { recursive: true });
    const there = await fsp.stat(f.dst).catch(() => null);
    if (there && f.both) f.dst = path.join(path.dirname(f.dst), keepBothName(path.basename(f.dst), (n) => fs.existsSync(path.join(path.dirname(f.dst), n)), false));
    else if (there && there.isDirectory()) throw problem('EXISTS', 'There’s a folder with this name on this PC.');
    else if (there && !f.replace) {
      if (sameFile(f, { size: there.size, mtime: Math.floor(there.mtimeMs / 1000) })) { f.state = 'skipped'; return; }
      throw problem('EXISTS', 'A file with this name showed up on this PC meanwhile, so it was left alone.');
    }
    const part = partOfLocal(f.dst);
    try { await pull(s, f.src, part, f.size, o); } catch (e) {
      if (e && (e.code === 'ENOSPC')) throw problem('FULL', 'This PC’s drive is full.');
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) throw problem('FOLDER', 'Windows won’t let Shelf save in that folder.');
      throw e;
    }
    if (f.mtime) await fsp.utimes(part, f.mtime, f.mtime).catch(() => {});
    if (!f.replace && fs.existsSync(f.dst)) throw problem('EXISTS', 'A file with this name showed up on this PC meanwhile, so it was left alone.');
    try { await fsp.rename(part, f.dst); } catch (e) { throw problem('FOLDER', e.code === 'EBUSY' || e.code === 'EPERM' ? 'The file on this PC is open in another app, so it couldn’t be replaced.' : 'Couldn’t give the copy its name.'); }
  }
  // A cancelled copy: the unfinished piece is removed (files that were already complete stay).
  async function cancelled(job) {
    for (const f of job.files) {
      if (f.state !== 'waiting' || !f.dst) continue;
      if (job.direction === 'down') await fsp.rm(partOfLocal(f.dst), { force: true }).catch(() => {});
      else if (conn && !conn.closed) await conn.unlink(partOfRemote(f.dst)).catch(() => {});
    }
    jobs = jobs.filter((j) => j !== job);
  }

  handle('shelf:xferQueue', async () => snapshot());
  handle('shelf:xferAction', async (id, what) => {
    const job = jobs.find((j) => j.id === Number(id));
    if (!job) return snapshot();
    if (what === 'pause') {
      if (job.state === 'running') job.stop = 'pause';
      else if (job.state === 'waiting') job.state = 'paused';
    } else if (what === 'resume') {
      if (job.state === 'paused') { job.state = 'waiting'; kick(); }
    } else if (what === 'retry') {
      if (job.state === 'failed' || job.state === 'paused') {
        job.files.forEach((f) => { if (f.state === 'failed' && !/where (this|the) (file|folder) would go/.test(f.error || '')) { f.state = 'waiting'; f.error = ''; } });
        if (job.files.some((f) => f.state === 'waiting')) { job.state = 'waiting'; kick(); }
      }
    } else if (what === 'cancel') {
      if (job.state === 'running') job.stop = 'cancel';
      else if (job.state === 'done' || job.state === 'failed') jobs = jobs.filter((j) => j !== job);
      else await cancelled(job);
    }
    emit(true);
    return snapshot();
  });
  handle('shelf:xferClear', async () => { jobs = jobs.filter((j) => j.state !== 'done'); emit(true); return snapshot(); });
  handle('shelf:xferPauseAll', async (on) => {
    jobs.forEach((j) => {
      if (on) { if (j.state === 'running') j.stop = 'pause'; else if (j.state === 'waiting') j.state = 'paused'; }
      else if (j.state === 'paused') j.state = 'waiting';
    });
    if (!on) kick();
    emit(true);
    return snapshot();
  });

  return {
    close: () => { jobs.forEach((j) => { if (j.state === 'running') j.stop = 'pause'; }); clearTimeout(idle); dropConn(); },
    forget: () => { jobs.forEach((j) => { j.stop = 'cancel'; }); jobs = []; plans.clear(); dropConn(); },
    _snapshot: snapshot
  };
}

module.exports = { setup, cleanName, winSafe, keepBothName, sameFile, commonParent, pull, removeRemote, systemFolder };
