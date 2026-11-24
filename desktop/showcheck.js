/*
 * Shelf desktop — Missing Episodes, the server side: which TV show folders your Plex server has, and the video
 * files in one show's folders (names only). The window compares them with the show's episode list
 * (app/js/missing.js). Read only: nothing on the server is changed, and nothing but names is read.
 * Same SSH connection as Send to Plex; only folders inside your TV library folders can be listed.
 */
'use strict';

const posix = require('path').posix;
const S = require('./server');
const { VIDEO_EXT } = require('../app/js/parser.js');

const VIDEO = new Set(VIDEO_EXT);
const MAX_SHOWS = 5000;
const MAX_FILES = 20000;
const PARALLEL = 8;
const SKIP = /^\.|^@eaDir$|^#recycle$|^\$RECYCLE\.BIN$|^lost\+found$/i;

/** Your TV library folders on the server (from Plex, else the TV folder you picked for Send to Plex). */
function tvRoots(c) {
  c = c || {};
  const fromPlex = (c.libraries || []).filter((l) => l.kind === 'tv' && l.folders && l.folders.length)
    .reduce((a, l) => a.concat(l.folders.map((f) => ({ root: f, lib: l.title || 'TV Shows' }))), []);
  const list = fromPlex.length ? fromPlex : c.tv ? [{ root: c.tv, lib: 'TV Shows' }] : [];
  const seen = new Set();
  return list.map((x) => ({ root: S.cleanRoot(x.root), lib: x.lib })).filter((x) => x.root && !seen.has(x.root) && seen.add(x.root));
}

/** A show folder you may list: a folder right inside one of your TV library folders. Its root, or null. */
function rootOf(p, roots) {
  const clean = S.cleanRoot(p);
  if (!clean) return null; // (cleaned: no "..")
  return roots.find((x) => clean !== x.root && posix.dirname(clean) === x.root) || null;
}

/** The video files in a show's folder and the folders inside it (seasons), sorted: [{ name, folders, size }]. */
async function videosIn(s, dir, stopped) {
  const out = [];
  const queue = [{ dir, inside: [] }];
  let active = 0, truncated = false;
  await new Promise((resolve) => {
    const pump = () => {
      if (truncated || (stopped && stopped())) queue.length = 0;
      if (!queue.length && !active) { resolve(); return; }
      while (active < PARALLEL && queue.length) {
        const at = queue.shift();
        active++;
        s.entries(at.dir).then((entries) => {
          for (const e of entries) {
            if (SKIP.test(e.name)) continue;
            if (e.dir) { if (at.inside.length < 3) queue.push({ dir: posix.join(at.dir, e.name), inside: at.inside.concat(e.name) }); continue; }
            if (!e.file || !VIDEO.has(posix.extname(e.name).slice(1).toLowerCase())) continue;
            if (out.length >= MAX_FILES) { truncated = true; break; }
            out.push({ name: e.name, folders: at.inside, size: e.size });
          }
        }, () => {}).then(() => { active--; pump(); });
      }
    };
    pump();
  });
  out.sort((a, b) => a.folders.concat(a.name).join('/').localeCompare(b.folders.concat(b.name).join('/'), undefined, { numeric: true }));
  return { files: out, truncated };
}

function setup(ctx, api) {
  const { log } = ctx;
  const { withSession, cfg, handle } = api;

  // The show folders in your TV libraries: [{ path, name, lib }] (one folder listing per library folder).
  handle('shelf:showFolders', async () => {
    const c = cfg();
    if (!c || !c.fingerprint) throw S.problem('NO_SERVER', 'Set up your Plex server first.');
    const roots = tvRoots(c);
    if (!roots.length) throw S.problem('FOLDER', 'Connect Plex (or pick your TV Shows folder) first.');
    return withSession(async (s) => {
      const shows = [];
      for (const r of roots) {
        const names = await s.list(r.root).catch(() => []);
        for (const name of names) {
          if (SKIP.test(name) || shows.length >= MAX_SHOWS) continue;
          shows.push({ path: posix.join(r.root, name), name, lib: r.lib });
        }
      }
      return { shows, libs: roots.length };
    });
  });

  // The video files in these show folders: [{ path, files: [{ name, folders, size }], truncated }].
  handle('shelf:showFiles', async (paths) => {
    const c = cfg();
    if (!c || !c.fingerprint) throw S.problem('NO_SERVER', 'Set up your Plex server first.');
    const roots = tvRoots(c);
    const want = (Array.isArray(paths) ? paths : []).slice(0, 12).map((p) => (rootOf(p, roots) ? S.cleanRoot(p) : null));
    if (want.some((p) => !p)) throw S.problem('FOLDER', 'Shelf only looks in your TV library folders.');
    return withSession(async (s) => {
      const out = [];
      for (const p of want) out.push(Object.assign({ path: p }, await videosIn(s, p)));
      log('Missing Episodes: listed ' + out.reduce((n, x) => n + x.files.length, 0) + ' files in ' + out.length + ' show folder(s)');
      return out;
    });
  });
}

module.exports = { setup, tvRoots, rootOf, videosIn };
