/*
 * Shelf desktop — "Fix My Plex Library": tidy the files already on your Plex server, from this PC.
 *
 * How (nothing is installed on the server; the same SSH connection as Send to Plex is used):
 *  1. Shelf lists the video and subtitle files in your Plex libraries' folders (SFTP, names only).
 *  2. If Plex is connected, it asks Plex which of them it matched, which it couldn't match, and
 *     which it never picked up at all (through the SSH connection; Plex isn't opened to the network).
 *  3. The files that need a look go into Shelf's list like files on this PC, and are matched the
 *     same way. Nothing is changed until you click Rename.
 *  4. Rename moves each file to its Plex name *on the server* (an instant rename, nothing is
 *     copied over the network), then Plex is asked to rescan. Undo puts everything back.
 *
 * Safety: only files Shelf listed can be renamed, only within your Plex library folders, never over
 * an existing file. Folders are only removed when they're empty.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const posix = path.posix;
const S = require('./server');
const { VIDEO_EXT, SUB_EXT } = require('../app/js/parser.js');

const WANTED = new Set(VIDEO_EXT.concat(SUB_EXT));
const MAX_FILES = 50000;
const TOP = { movies: 'Movies', tv: 'TV Shows' };

// ---- Is this file already named the way Plex likes? ----
// Movies:  Title (Year)[ {id}]/Title (Year)…ext
// TV:      Show[ (Year)][ {id}]/Season 01|Specials/Show… - S01E02…ext
function looksRight(kind, rel) {
  const parts = rel.split('/');
  if (kind === 'movies') {
    if (parts.length !== 2) return false;
    const m = /^(.+ \(\d{4}\))(?: \{(?:tmdb|imdb|tvdb)-[\w]+\})?$/.exec(parts[0]);
    return !!m && parts[1].startsWith(m[1]);
  }
  if (parts.length !== 3) return false;
  if (!/^(Season \d{2,}|Specials)$/.test(parts[1])) return false;
  const show = parts[0].replace(/ \{(?:tmdb|imdb|tvdb)-[\w]+\}$/, '');
  return parts[2].startsWith(show + ' - ') && /\bS\d{2,}E\d{2,}/.test(parts[2]);
}

// ---- What Plex thinks of each file ----
/** file path on the server → 'matched' | 'unmatched', for one library. */
async function plexFiles(s, token, lib) {
  const out = new Map();
  const type = lib.kind === 'movies' ? 1 : 4; // movies, or episodes
  for (let start = 0; start < 200000; start += 400) {
    const body = await s.plex(token, '/library/sections/' + encodeURIComponent(lib.key) + '/all?type=' + type +
      '&X-Plex-Container-Start=' + start + '&X-Plex-Container-Size=400');
    const mc = (JSON.parse(body) || {}).MediaContainer || {};
    const list = mc.Metadata || [];
    for (const m of list) {
      // An episode is as matched as its show; Plex marks unmatched items with a local:// guid.
      const g = String(m.grandparentGuid || m.guid || '');
      const state = !g || /^local:\/\/|agents\.none/.test(g) ? 'unmatched' : 'matched';
      for (const media of m.Media || []) for (const part of media.Part || []) if (part.file) out.set(String(part.file), state);
    }
    if (list.length < 400) break;
  }
  return out;
}

// ---- Walking a library folder on the server ----
async function walk(s, root, onFile, stats) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = await s.entries(dir); } catch (e) { stats.unreadable++; continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      if (e.name.startsWith('.') || /^@eaDir$|^#recycle$|^\$RECYCLE\.BIN$|^lost\+found$/i.test(e.name)) continue;
      const full = posix.join(dir, e.name);
      // Linked folders are followed (the depth limit stops a link that points back up).
      if (e.dir) { if (depth < 6) queue.push({ dir: full, depth: depth + 1 }); continue; }
      // A linked file can't be renamed safely (only the link would move): left alone.
      if (!e.file || e.link) continue;
      if (!WANTED.has(posix.extname(e.name).slice(1).toLowerCase())) continue;
      if (stats.files >= MAX_FILES) { stats.truncated = true; return; }
      stats.files++;
      onFile({ path: full, size: e.size });
    }
  }
}

/** Where a file should go: its library folder + the Plex folders + name. null if anything's off. */
function targetFor(root, folder, file) {
  const segs = (Array.isArray(folder) ? folder : []).map(String).slice(1).concat([String(file || '')]); // drop Movies / TV Shows
  if (!segs.length || segs.some((x) => !x || x === '.' || x === '..' || /[\/\0\n\r]/.test(x) || x.length > 255)) return null;
  const clean = S.cleanRoot(root);
  if (!clean) return null;
  const full = posix.join(clean, ...segs);
  return full.startsWith(clean === '/' ? '/' : clean + '/') ? full : null;
}

function setup(ctx, api) {
  const { app, log } = ctx;
  const { withSession, cfg, getSecret, handle } = api;
  const journalFile = () => path.join(app.getPath('userData'), 'plex-fix-journal.json');
  const listed = new Map(); // server path → { root, kind, lib } (only these can be renamed)

  /** Your Plex libraries' folders (from Plex, else the folders you picked for Send to Plex). */
  function libraries() {
    const c = cfg() || {};
    const libs = (c.libraries || []).filter((l) => l.folders && l.folders.length);
    if (libs.length) return libs;
    return ['movies', 'tv'].filter((k) => c[k]).map((k) => ({ key: '', kind: k, title: TOP[k], folders: [c[k]] }));
  }

  // only: 'problems' (default: files Plex didn't match, didn't pick up, or that aren't named the
  // Plex way) or 'all'.
  handle('shelf:plexLibraryScan', async (only) => {
    const c = cfg();
    if (!c || !c.fingerprint) throw S.problem('NO_SERVER', 'Set up your Plex server first.');
    const libs = libraries();
    if (!libs.length) throw S.problem('FOLDER', 'Connect Plex (or pick your Movies and TV Shows folders) first.');
    const token = getSecret('plex');
    const stats = { files: 0, unreadable: 0, truncated: false, matched: 0, unmatched: 0, missing: 0, named: 0, plex: !!token };
    const files = [];
    await withSession(async (s) => {
      for (const lib of libs) {
        let known = null;
        if (token && lib.key) { try { known = await plexFiles(s, token, lib); } catch (e) { log('Plex library list didn’t work (' + (S.friendly(e, '').code || 'OTHER') + ')'); } }
        for (const root of lib.folders) {
          const clean = S.cleanRoot(root);
          if (!clean) continue;
          await walk(s, clean, (f) => {
            const rel = posix.relative(clean, f.path);
            const isSub = SUB_EXT.includes(posix.extname(f.path).slice(1).toLowerCase());
            const plex = isSub ? '' : known ? known.get(f.path) || 'missing' : '';
            const named = looksRight(lib.kind, rel);
            if (plex) stats[plex]++;
            if (named) stats.named++;
            files.push({ path: f.path, size: f.size, rel, root: clean, kind: lib.kind, lib: lib.key, plex, named });
          }, stats);
        }
      }
    });
    // A subtitle needs a look when its video does (they're renamed together).
    const stem = (p) => p.replace(/\.[^./]+$/, '').replace(/(\.(?:[a-z]{2,3}|forced|sdh|cc|hi))+$/i, '').toLowerCase();
    const videoNeeds = new Map();
    files.forEach((f) => { if (f.plex || !SUB_EXT.includes(posix.extname(f.path).slice(1).toLowerCase())) videoNeeds.set(stem(f.path), !(f.named && f.plex !== 'unmatched' && f.plex !== 'missing')); });
    const pick = only === 'all' ? files : files.filter((f) => {
      const isSub = !f.plex && SUB_EXT.includes(posix.extname(f.path).slice(1).toLowerCase());
      return isSub ? videoNeeds.get(stem(f.path)) === true : !(f.named && f.plex !== 'unmatched' && f.plex !== 'missing');
    }).slice(0, 5000);
    listed.clear();
    files.forEach((f) => listed.set(f.path, { root: f.root, kind: f.kind, lib: f.lib }));
    return {
      stats, total: files.length,
      files: pick.map((f) => ({
        remote: f.path, size: f.size, name: posix.basename(f.path),
        // Shelf reads the folders too ("TV Shows/Show/Season 1/x.mkv"), like files on this PC.
        relPath: TOP[f.kind] + '/' + f.rel, plex: f.plex, named: f.named
      }))
    };
  });

  async function readJournal() { try { return JSON.parse(await fsp.readFile(journalFile(), 'utf8')); } catch (e) { return null; } }
  async function writeJournal(j) { await fsp.mkdir(path.dirname(journalFile()), { recursive: true }); await fsp.writeFile(journalFile(), JSON.stringify(j)); }

  // Remove a folder (and its parents, up to the library folder) only when it's empty.
  async function tidy(s, dir, root) {
    while (dir && dir !== root && dir.startsWith(root + '/')) {
      const ok = await new Promise((done) => s.sftp.rmdir(dir, (e) => done(!e))); // fails unless empty
      if (!ok) return;
      dir = posix.dirname(dir);
    }
  }
  async function rescan(s, touched) {
    const token = getSecret('plex');
    if (!token) return 0;
    let n = 0;
    for (const key of touched) { if (!key) continue; try { await s.plex(token, '/library/sections/' + encodeURIComponent(key) + '/refresh'); n++; } catch (e) { /* Plex will find them at its next scan */ } }
    return n;
  }

  /** ops: [{ remote, folder: ['TV Shows', 'Show', 'Season 01'], file }] → [{ remote, ok, to, skipped, error }] */
  handle('shelf:plexLibraryFix', async (ops) => {
    if (!Array.isArray(ops) || !ops.length) return { results: [] };
    const results = [], done = [], touched = new Set(), oldDirs = new Set();
    const c = cfg() || {};
    // A file that turns out to be the other kind goes to a library folder of that kind.
    const rootOf = (kind) => { const l = libraries().find((x) => x.kind === kind); return l ? { root: S.cleanRoot(l.folders[0]), lib: l.key } : null; };
    await withSession(async (s) => {
      for (const op of ops.slice(0, 5000)) {
        const from = String((op && op.remote) || '');
        const info = listed.get(from);
        const r = { remote: from };
        results.push(r);
        if (!info) { r.error = 'Shelf didn’t list this file. Check your Plex library again.'; continue; }
        const kind = Array.isArray(op.folder) && op.folder[0] === 'Movies' ? 'movies' : 'tv';
        const home = kind === info.kind ? { root: info.root, lib: info.lib } : rootOf(kind) || { root: info.root, lib: info.lib };
        const to = targetFor(home.root, op.folder, op.file);
        if (!to) { r.error = 'That name won’t work on the server.'; continue; }
        if (to === from) { r.ok = true; r.skipped = 'Already named right'; continue; }
        try {
          if (await s.stat(to)) { r.skipped = 'A file with that name is already there'; continue; }
          await s.mkdirp(posix.dirname(to));
          await s.rename(from, to, false);
          r.ok = true; r.to = to;
          done.push({ from, to });
          listed.delete(from); listed.set(to, { root: home.root, kind, lib: home.lib });
          touched.add(info.lib); touched.add(home.lib);
          oldDirs.add(JSON.stringify([posix.dirname(from), info.root]));
        } catch (e) {
          const f = S.friendly(e, c.host || '');
          r.error = /failure/i.test(String(e && e.message)) && home.root !== info.root ? 'Couldn’t move it to the other library (it may be on a different drive).' : f.message;
        }
      }
      for (const d of oldDirs) { const [dir, root] = JSON.parse(d); await tidy(s, dir, root); }
      if (done.length) await writeJournal({ at: Date.now(), done });
      results.rescanned = await rescan(s, touched);
    });
    if (done.length) log('Plex library: renamed ' + done.length + ' file(s) on the server');
    return { results, rescanned: results.rescanned || 0 };
  });

  handle('shelf:plexLibraryCanUndo', async () => { const j = await readJournal(); return !!(j && j.done && j.done.length); });
  handle('shelf:plexLibraryUndo', async () => {
    const j = await readJournal();
    if (!j || !j.done || !j.done.length) return { nothing: true };
    let undone = 0, kept = 0;
    const touched = new Set();
    await withSession(async (s) => {
      for (const { from, to } of j.done.slice().reverse()) {
        try {
          if (!(await s.stat(to)) || (await s.stat(from))) { kept++; continue; } // changed since: left alone
          await s.mkdirp(posix.dirname(from));
          await s.rename(to, from, false);
          undone++;
          const lib = libraries().find((l) => l.folders.some((f) => from.startsWith(S.cleanRoot(f) + '/')));
          if (lib) { touched.add(lib.key); await tidy(s, posix.dirname(to), S.cleanRoot(lib.folders.find((f) => to.startsWith(S.cleanRoot(f) + '/')) || lib.folders[0])); }
        } catch (e) { kept++; }
      }
      await rescan(s, touched);
    });
    await fsp.rm(journalFile(), { force: true });
    return { undone, kept };
  });

  return { forget: () => { listed.clear(); fs.rmSync(journalFile(), { force: true }); } };
}

module.exports = { setup, looksRight, targetFor, plexFiles };
