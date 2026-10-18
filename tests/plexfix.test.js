// Fix My Plex Library, end to end against a tiny SSH server inside this test (runs on Windows too):
// a media drive linked into /mnt, Plex answering through the SSH connection, renaming on the server,
// tidying empty folders, asking Plex to rescan, and undo. Also the server folder browser's fixes
// (linked folders show up; a folder you can't open says so).
//   node tests/plexfix.test.js
'use strict';
const path = require('path');
const posix = path.posix;
const assert = require('assert');

const S = require('../desktop/server.js');
const F = require('../desktop/plexfix.js');
const fake = require('./fakeplex');

(async () => {
  let n = 0;
  const ok = (msg) => { n++; console.log('  ✓ ' + msg); };

  // ---- Plain-named? ----
  assert.ok(F.looksRight('tv', 'SpongeBob SquarePants/Season 05/SpongeBob SquarePants - S05E03 - Rise and Shine.mkv'));
  assert.ok(F.looksRight('tv', 'SpongeBob SquarePants {tmdb-387}/Specials/SpongeBob SquarePants - S00E01.mkv'));
  assert.ok(!F.looksRight('tv', 'Spongebob/Season 5/SpongeBob.SquarePants.S05E03.720p.mkv'));
  assert.ok(F.looksRight('movies', 'Charade (1963)/Charade (1963) - 1080p.mkv'));
  assert.ok(F.looksRight('movies', 'Charade (1963) {tmdb-4808}/Charade (1963) {tmdb-4808}.mkv'));
  assert.ok(!F.looksRight('movies', 'new stuff/Charade.1963.1080p.BluRay.mkv'));
  ok('tells Plex-style names from messy ones');
  assert.strictEqual(F.targetFor('/mnt/media/TV', ['TV Shows', 'Show', 'Season 01'], 'Show - S01E01.mkv'), '/mnt/media/TV/Show/Season 01/Show - S01E01.mkv');
  assert.strictEqual(F.targetFor('/mnt/media/TV', ['TV Shows', '..', 'x'], 'y.mkv'), null);
  assert.strictEqual(F.targetFor('/mnt/media/TV', ['TV Shows', 'a/b'], 'y.mkv'), null);
  assert.strictEqual(F.targetFor('/mnt/media/TV', ['TV Shows', 'Show'], '../../etc/passwd'), null);
  ok('a new name can never leave the library folder');

  const srv = await fake.start();
  const { port, files, dirs, plexAsked } = srv, hostFp = srv.fp, PASS = srv.pass;
  const connect = () => S.connect({ host: '127.0.0.1', port, username: 'me', password: PASS, pinned: hostFp });

  // ---- The folder browser ----
  const s = await connect();
  assert.deepStrictEqual(await s.list('/mnt'), ['media'], 'a drive linked into /mnt shows up');
  assert.deepStrictEqual(await s.list('/mnt/media'), ['Movies', 'TV']);
  const e = await s.entries('/mnt');
  assert.ok(e[0].dir && e[0].link);
  await assert.rejects(s.list('/root'), (err) => S.friendly(err, '').code === 'FOLDER');
  s.close();
  ok('linked folders (like a drive in /mnt) show up; a folder you can’t open says so');

  // ---- Fix My Plex Library ----
  const handlers = {};
  const cfg = { host: '127.0.0.1', fingerprint: hostFp, libraries: [
    { key: '1', kind: 'movies', title: 'Movies', folders: ['/mnt/media/Movies'] },
    { key: '2', kind: 'tv', title: 'TV Shows', folders: ['/mnt/media/TV'] }
  ] };
  const api = {
    cfg: () => cfg, getSecret: (k) => (k === 'plex' ? 'tok12345' : ''),
    handle: (ch, fn) => { handlers[ch] = fn; },
    withSession: async (fn) => { const ss = await connect(); try { return await fn(ss); } finally { ss.close(); } }
  };
  const os = require('os');
  const tmp = require('fs').mkdtempSync(path.join(os.tmpdir(), 'shelf-fix-'));
  F.setup({ app: { getPath: () => tmp }, log: (m) => process.env.DEBUG && console.log('LOG', m) }, api);

  const scan = await handlers['shelf:plexLibraryScan']('problems');
  const names = scan.files.map((f) => f.name).sort();
  assert.deepStrictEqual(names, ['Charade.1963.1080p.BluRay.mkv', 'SpongeBob.SquarePants.S05E03.720p.en.srt', 'SpongeBob.SquarePants.S05E03.720p.mkv']);
  assert.strictEqual(scan.total, 4);
  const sb = scan.files.find((f) => f.name.endsWith('720p.mkv')), mv = scan.files.find((f) => f.name.startsWith('Charade'));
  assert.strictEqual(sb.plex, 'unmatched');
  assert.strictEqual(mv.plex, 'missing');
  assert.strictEqual(sb.relPath, 'TV Shows/Spongebob/Season 5/SpongeBob.SquarePants.S05E03.720p.mkv');
  assert.strictEqual(sb.remote, '/mnt/media/TV/Spongebob/Season 5/SpongeBob.SquarePants.S05E03.720p.mkv');
  assert.deepStrictEqual([scan.stats.matched, scan.stats.unmatched, scan.stats.missing], [1, 1, 1]);
  ok('finds what Plex couldn’t match (and its subtitle) and what Plex never added, through the /mnt link; skips what’s fine');
  const all = await handlers['shelf:plexLibraryScan']('all');
  assert.strictEqual(all.files.length, 4);
  ok('“include files that already look right” lists everything');
  await handlers['shelf:plexLibraryScan']('problems');

  plexAsked.length = 0;
  const fix = await handlers['shelf:plexLibraryFix']([
    { remote: sb.remote, folder: ['TV Shows', 'SpongeBob SquarePants', 'Season 05'], file: 'SpongeBob SquarePants - S05E03 - Rise and Shine.mkv' },
    { remote: sb.remote.replace('.mkv', '.en.srt'), folder: ['TV Shows', 'SpongeBob SquarePants', 'Season 05'], file: 'SpongeBob SquarePants - S05E03 - Rise and Shine.en.srt' },
    { remote: mv.remote, folder: ['Movies', 'Charade (1963)'], file: 'Charade (1963).mkv' },
    { remote: '/etc/passwd', folder: ['Movies', 'x'], file: 'x.mkv' },
    { remote: '/mnt/media/TV/Good Show/Season 01/Good Show - S01E01 - Pilot.mkv', folder: ['TV Shows', '..'], file: 'evil.mkv' }
  ]);
  const r = fix.results;
  assert.ok(r[0].ok && r[1].ok && r[2].ok, JSON.stringify(r));
  assert.ok(files.has('/srv/disk1/TV/SpongeBob SquarePants/Season 05/SpongeBob SquarePants - S05E03 - Rise and Shine.mkv'));
  assert.ok(files.has('/srv/disk1/TV/SpongeBob SquarePants/Season 05/SpongeBob SquarePants - S05E03 - Rise and Shine.en.srt'));
  assert.ok(files.has('/srv/disk1/Movies/Charade (1963)/Charade (1963).mkv'));
  assert.ok(r[3].error && r[4].error, 'unlisted files and bad names are refused');
  assert.ok(files.has('/srv/disk1/TV/Good Show/Season 01/Good Show - S01E01 - Pilot.mkv'), 'a refused file is left alone');
  assert.ok(!dirs.has('/srv/disk1/TV/Spongebob/Season 5') && !dirs.has('/srv/disk1/TV/Spongebob') && !dirs.has('/srv/disk1/Movies/new stuff'), 'emptied folders are removed');
  assert.ok(dirs.has('/srv/disk1/TV') && dirs.has('/srv/disk1/Movies'), 'library folders stay');
  assert.deepStrictEqual(plexAsked.filter((u) => /refresh/.test(u)).sort(), ['/library/sections/1/refresh', '/library/sections/2/refresh']);
  assert.strictEqual(fix.rescanned, 2);
  ok('renames on the server into Plex’s folders, tidies empty folders, refuses anything unlisted or unsafe, asks Plex to rescan');

  assert.strictEqual(await handlers['shelf:plexLibraryCanUndo'](), true);
  const u = await handlers['shelf:plexLibraryUndo']();
  assert.deepStrictEqual([u.undone, u.kept], [3, 0]);
  assert.ok(files.has('/srv/disk1/TV/Spongebob/Season 5/SpongeBob.SquarePants.S05E03.720p.mkv'));
  assert.ok(files.has('/srv/disk1/Movies/new stuff/Charade.1963.1080p.BluRay.mkv'));
  assert.ok(!dirs.has('/srv/disk1/TV/SpongeBob SquarePants'), 'Undo removes the folders it made, once empty');
  assert.strictEqual(await handlers['shelf:plexLibraryCanUndo'](), false);
  ok('Undo puts every file back where it was');

  require('fs').rmSync(tmp, { recursive: true, force: true });
  srv.close();
  console.log(n + ' Fix My Plex Library checks passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
