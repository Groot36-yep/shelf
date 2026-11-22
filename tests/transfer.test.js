// Server Files (desktop/transfer.js) against the pretend Plex server (tests/fakeplex.js), so it runs anywhere:
// listing both sides, copying folders both ways (bytes and dates kept, no half files), files already there
// (skip the same ones, Keep Both, Replace), pause and pick up where it stopped, cancel, a failed file tried again,
// and New Folder / Rename / Delete on the server (with the folders it must never delete).
// Run: node tests/transfer.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const fake = require('./fakeplex');
const S = require('../desktop/server');
const T = require('../desktop/transfer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ---- The small helpers ----
assert.strictEqual(T.winSafe('Who: Me? *now*.'), 'Who_ Me_ _now_');
assert.strictEqual(T.winSafe('CON.txt'), '_CON.txt');
assert.strictEqual(T.cleanName(' New Folder '), 'New Folder');
['', '.', '..', 'a/b', 'a\\b', 'x\ny'].forEach((n) => assert.strictEqual(T.cleanName(n), '', JSON.stringify(n)));
const taken = new Set(['Movie (2).mkv']);
assert.strictEqual(T.keepBothName('Movie.mkv', (n) => taken.has(n)), 'Movie (3).mkv');
assert.strictEqual(T.keepBothName('Season 01', () => false, true), 'Season 01 (2)');
assert.strictEqual(T.keepBothName('.hidden', () => false), '.hidden (2)');
assert.ok(T.sameFile({ size: 5, mtime: 100 }, { size: 5, mtime: 101 }) && !T.sameFile({ size: 5, mtime: 100 }, { size: 6, mtime: 100 }) && !T.sameFile({ size: 5, mtime: 100 }, { size: 5, mtime: 200 }));
assert.strictEqual(T.commonParent(['/mnt/media/Movies', '/mnt/media/TV']), '/mnt/media');
assert.strictEqual(T.commonParent(['/mnt/a/Movies', '/srv/TV']), '/');
if (process.platform === 'win32') assert.ok(T.systemFolder(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')) && !T.systemFolder(os.homedir()));
ok('names made safe for Windows, Keep Both names, “same size and date”, the folder that holds the library folders');

(async () => {
  const bytes = (n) => crypto.randomBytes(n);
  const A = bytes(3 << 20), B = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  const net = { mbps: 100000, ms: 0 }; // the pretend network: slowed down later, so there's time to pause
  const srv = await fake.start({ keep: true, net, content: {
    '/srv/disk1/Movies/Slow.mkv': bytes(8 << 20),
    '/srv/disk1/TV/Show X/Season 01/Show X - S01E01.mkv': A,
    '/srv/disk1/TV/Show X/Season 01/Show X - S01E01.en.srt': B,
    '/srv/disk1/Movies/Big.mkv': bytes(12 << 20)
  } });
  srv.dirs.add('/srv/disk1/TV/Show X/Extras'); // an empty folder comes along too
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-xfer-'));
  const pc = path.join(tmp, 'PC'); fs.mkdirSync(pc);
  const cfg = { host: '127.0.0.1', port: srv.port, user: 'me', fingerprint: srv.fp, home: '/home/me', movies: '/mnt/media/Movies', tv: '/mnt/media/TV', options: { verify: true },
    libraries: [{ key: '2', kind: 'tv', title: 'TV Shows', folders: ['/mnt/media/TV'] }] };
  const dial = () => S.connect({ host: '127.0.0.1', port: srv.port, username: 'me', password: srv.pass, pinned: srv.fp });
  let shared = null;
  const handlers = {}, events = [];
  const api = {
    handle: (ch, fn) => { handlers[ch] = async (...a) => { try { return await fn(...a); } catch (e) { const f = S.friendly(e, ''); throw new Error('[' + f.code + '] ' + f.message); } }; },
    withSession: async (fn) => { if (!shared || shared.closed) shared = await dial(); return fn(shared); },
    connect: dial, cfg: () => cfg, getSecret: () => ''
  };
  const xfer = T.setup({ app: { getPath: (n) => (n === 'videos' ? pc : n === 'home' ? tmp : '') }, log: () => {}, readPrefs: () => ({}), send: (m) => events.push(m) }, api);
  const call = (ch, ...a) => handlers[ch](...a);
  const job = async (id) => (await call('shelf:xferQueue')).jobs.find((j) => j.id === id);
  const settled = async (id) => {
    for (let i = 0; i < 600; i++) { const j = await job(id); if (!j || !['waiting', 'running'].includes(j.state)) return j; await sleep(50); }
    throw new Error('the copy never finished');
  };
  const copy = async (dir, sources, dest, policy) => {
    const plan = await call('shelf:xferPlan', dir, sources, dest);
    const q = await call('shelf:xferGo', plan.id, policy || {});
    return { plan, job: await settled(q.jobs[q.jobs.length - 1].id) };
  };
  const noParts = (d) => { for (const f of fs.readdirSync(d, { recursive: true })) assert.ok(!/shelf-part/.test(f), 'a half file was left: ' + f); };
  try {
    // ---- Where things are ----
    const start = await call('shelf:xferStart');
    assert.strictEqual(start.server.start, '/mnt/media', 'starts at the folder that holds the library folders');
    assert.deepStrictEqual(start.server.places.map((p) => p.label), ['Movies', 'TV Shows', 'Home']);
    assert.strictEqual(start.pc.start, pc);
    const tv = await call('shelf:xferListServer', '/mnt/media/TV');
    assert.deepStrictEqual(tv.entries.map((e) => e.name + (e.dir ? '/' : '')).sort(), ['Good Show/', 'Show X/', 'Spongebob/']);
    const movies = await call('shelf:xferListServer', '/mnt/media/Movies');
    const big = movies.entries.find((e) => e.name === 'Big.mkv');
    assert.ok(big && big.size === 12 << 20 && big.mtime === 1700000000, JSON.stringify(big));
    await assert.rejects(call('shelf:xferListServer', '/root'), /\[FOLDER\]/);
    await assert.rejects(call('shelf:xferListServer', '/nope'), /\[MISSING\]/);
    fs.writeFileSync(path.join(pc, 'note.txt'), 'hi'); fs.writeFileSync(path.join(pc, '.hidden'), 'x'); fs.mkdirSync(path.join(pc, 'Folder'));
    const here = await call('shelf:xferListPC', pc);
    assert.deepStrictEqual(here.entries.map((e) => e.name + (e.dir ? '/' : '')).sort(), ['Folder/', 'note.txt']);
    assert.strictEqual(here.parent, tmp);
    if (process.platform === 'win32') assert.ok((await call('shelf:xferListPC', '')).entries.some((d) => d.drive), 'drives');
    ok('both sides list their folders (sizes, dates); a folder you can’t open says why; hidden files stay out of the way');

    // ---- Server → this PC: a whole folder ----
    let r = await copy('down', ['/mnt/media/TV/Show X'], pc);
    assert.strictEqual(r.plan.files, 2); assert.strictEqual(r.plan.conflicts, 0); assert.strictEqual(r.plan.bytes, A.length + B.length);
    assert.strictEqual(r.job.state, 'done', JSON.stringify(r.job));
    const ep = path.join(pc, 'Show X', 'Season 01', 'Show X - S01E01.mkv');
    assert.ok(fs.readFileSync(ep).equals(A), 'the same bytes');
    assert.ok(fs.readFileSync(path.join(pc, 'Show X', 'Season 01', 'Show X - S01E01.en.srt')).equals(B));
    assert.strictEqual(Math.floor(fs.statSync(ep).mtimeMs / 1000), 1700000000, 'the server’s date kept');
    assert.ok(fs.statSync(path.join(pc, 'Show X', 'Extras')).isDirectory(), 'the empty folder too');
    noParts(pc);
    assert.ok(events.some((e) => e.jobs && e.jobs.some((j) => j.state === 'running')), 'progress was sent to the window');
    ok('a folder copies from the server to this PC: same bytes, same dates, empty folders too, no half files');

    // ---- Already there ----
    r = await copy('down', ['/mnt/media/TV/Show X'], pc);
    assert.strictEqual(r.plan.conflicts, 2); assert.strictEqual(r.plan.same, 2);
    assert.strictEqual(r.job.filesSkipped, 2); assert.strictEqual(r.job.state, 'done');
    fs.writeFileSync(ep, 'changed here');
    r = await copy('down', ['/mnt/media/TV/Show X'], pc, { other: 'both' });
    assert.strictEqual(r.plan.conflicts, 2); assert.strictEqual(r.plan.same, 1, 'the subtitle is the same, the video isn’t');
    assert.strictEqual(r.job.filesDone, 1); assert.strictEqual(r.job.filesSkipped, 1);
    assert.ok(fs.readFileSync(path.join(pc, 'Show X', 'Season 01', 'Show X - S01E01 (2).mkv')).equals(A), 'Keep Both: a second copy');
    assert.strictEqual(fs.readFileSync(ep, 'utf8'), 'changed here', 'and the first left alone');
    r = await copy('down', ['/mnt/media/TV/Show X/Season 01/Show X - S01E01.mkv'], path.join(pc, 'Show X', 'Season 01'), { other: 'skip' });
    assert.strictEqual(r.job.filesSkipped, 1);
    assert.strictEqual(fs.readFileSync(ep, 'utf8'), 'changed here', 'Skip leaves it');
    r = await copy('down', ['/mnt/media/TV/Show X/Season 01/Show X - S01E01.mkv'], path.join(pc, 'Show X', 'Season 01'), { other: 'replace' });
    assert.strictEqual(r.job.filesDone, 1);
    assert.ok(fs.readFileSync(ep).equals(A), 'Replace');
    noParts(pc);
    ok('files already there: the same ones skipped, Keep Both makes “(2)”, Skip leaves it, Replace replaces');

    // ---- This PC → server ----
    const up = path.join(tmp, 'Up Movie (2020)'); fs.mkdirSync(path.join(up, 'Extras'), { recursive: true });
    const U = bytes(2 << 20); fs.writeFileSync(path.join(up, 'Up Movie (2020).mkv'), U);
    fs.utimesSync(path.join(up, 'Up Movie (2020).mkv'), 1600000000, 1600000000);
    r = await copy('up', [up], '/mnt/media/Movies');
    assert.strictEqual(r.job.state, 'done', JSON.stringify(r.job));
    const there = '/srv/disk1/Movies/Up Movie (2020)/Up Movie (2020).mkv';
    assert.ok(srv.kept.get(there).equals(U), 'the same bytes on the server');
    assert.strictEqual(srv.mtimes.get(there), 1600000000, 'this PC’s date kept');
    assert.ok(srv.dirs.has('/srv/disk1/Movies/Up Movie (2020)/Extras'), 'the empty folder too');
    assert.ok(![...srv.files.keys()].some((f) => /shelf-part|shelf-old/.test(f)), 'no half files on the server');
    const U2 = bytes(1 << 20); fs.writeFileSync(path.join(up, 'Up Movie (2020).mkv'), U2);
    r = await copy('up', [path.join(up, 'Up Movie (2020).mkv')], '/mnt/media/Movies/Up Movie (2020)', { other: 'replace' });
    assert.strictEqual(r.plan.conflicts, 1); assert.strictEqual(r.job.filesDone, 1);
    assert.ok(srv.kept.get(there).equals(U2), 'Replace on the server (even without OpenSSH’s rename-over)');
    assert.ok(![...srv.files.keys()].some((f) => /shelf-part|shelf-old/.test(f)));
    r = await copy('up', [path.join(up, 'Up Movie (2020).mkv')], '/mnt/media/Movies/Up Movie (2020)', { same: 'ask', other: 'both' });
    assert.ok(srv.kept.get('/srv/disk1/Movies/Up Movie (2020)/Up Movie (2020) (2).mkv').equals(U2), 'Keep Both on the server');
    ok('a folder copies from this PC to the server (bytes, dates, empty folders); Replace and Keep Both there too');

    // ---- Pause, then pick up where it stopped ----
    const slow = srv;
    net.mbps = 40; net.ms = 2;
    const plan = await call('shelf:xferPlan', 'down', ['/mnt/media/Movies/Slow.mkv'], pc);
    let q = await call('shelf:xferGo', plan.id, {});
    const id = q.jobs[q.jobs.length - 1].id;
    for (let i = 0; i < 200 && !((await job(id)).bytesDone > 1 << 20); i++) await sleep(25);
    await call('shelf:xferAction', id, 'pause');
    let j = await settled(id);
    assert.strictEqual(j.state, 'paused');
    const part = path.join(pc, '.Slow.mkv.shelf-part');
    const had = fs.statSync(part).size;
    assert.ok(had > 0 && had < 8 << 20, 'part of it is here: ' + had);
    assert.ok(!fs.existsSync(path.join(pc, 'Slow.mkv')), 'and not under its real name');
    const readBefore = slow.reads.bytes;
    net.mbps = 4000;
    await call('shelf:xferAction', id, 'resume');
    j = await settled(id);
    assert.strictEqual(j.state, 'done');
    assert.ok(fs.readFileSync(path.join(pc, 'Slow.mkv')).equals(slow.kept.get('/srv/disk1/Movies/Slow.mkv')));
    assert.ok(slow.reads.bytes - readBefore <= (8 << 20) - had + (1 << 20), 'only the rest was copied');
    assert.ok(!fs.existsSync(part));
    ok('Pause keeps what arrived (under a temporary name); Resume copies only the rest (' + Math.round(had / 1024) + ' KB were already here)');

    // ---- Cancel ----
    net.mbps = 40;
    const plan2 = await call('shelf:xferPlan', 'down', ['/mnt/media/Movies/Slow.mkv'], path.join(pc, 'Folder'));
    q = await call('shelf:xferGo', plan2.id, {});
    const id2 = q.jobs[q.jobs.length - 1].id;
    for (let i = 0; i < 200 && !((await job(id2)).bytesDone > 1 << 20); i++) await sleep(25);
    await call('shelf:xferAction', id2, 'cancel');
    for (let i = 0; i < 100 && (await job(id2)); i++) await sleep(50);
    assert.ok(!(await job(id2)), 'gone from the list');
    assert.deepStrictEqual(fs.readdirSync(path.join(pc, 'Folder')), [], 'nothing left behind');
    ok('Cancel stops the copy and removes the unfinished piece');

    // ---- A file that fails says why, and can be tried again ----
    net.mbps = 4000;
    const plan3 = await call('shelf:xferPlan', 'down', ['/mnt/media/Movies/Slow.mkv'], path.join(pc, 'Folder'));
    const keep = slow.files.get('/srv/disk1/Movies/Slow.mkv');
    slow.files.delete('/srv/disk1/Movies/Slow.mkv');
    q = await call('shelf:xferGo', plan3.id, {});
    j = await settled(q.jobs[q.jobs.length - 1].id);
    assert.strictEqual(j.state, 'failed');
    const said = j.errors[0].why;
    assert.match(said, /isn’t on the server any more/);
    slow.files.set('/srv/disk1/Movies/Slow.mkv', keep);
    await call('shelf:xferAction', j.id, 'retry');
    j = await settled(j.id);
    assert.strictEqual(j.state, 'done');
    assert.strictEqual(fs.statSync(path.join(pc, 'Folder', 'Slow.mkv')).size, 8 << 20);
    await call('shelf:xferClear');
    assert.ok(!(await call('shelf:xferQueue')).jobs.some((x) => x.state === 'done'), 'Clear Finished');
    ok('a file that couldn’t be copied says why in plain words (“' + said + '”), and Retry copies it');

    // ---- New Folder, Rename, Delete on the server ----
    const made = await call('shelf:xferMkdir', 'server', '/mnt/media/Movies', 'New Stuff');
    assert.strictEqual(made, '/mnt/media/Movies/New Stuff');
    await assert.rejects(call('shelf:xferMkdir', 'server', '/mnt/media/Movies', 'New Stuff'), /\[EXISTS\]/);
    await assert.rejects(call('shelf:xferMkdir', 'server', '/mnt/media/Movies', '../x'), /\[NAME\]/);
    await call('shelf:xferRename', '/mnt/media/Movies', 'New Stuff', 'Newer Stuff');
    assert.ok(slow.dirs.has('/srv/disk1/Movies/Newer Stuff') && !slow.dirs.has('/srv/disk1/Movies/New Stuff'));
    await assert.rejects(call('shelf:xferRename', '/mnt/media/Movies', 'Newer Stuff', 'Slow.mkv'), /\[EXISTS\]/);
    await call('shelf:xferRename', '/mnt/media/Movies', 'Slow.mkv', 'Fast.mkv');
    assert.ok(slow.kept.has('/srv/disk1/Movies/Fast.mkv'));
    slow.dirs.add('/srv/disk1/Movies/Newer Stuff/Inside');
    slow.files.set('/srv/disk1/Movies/Newer Stuff/Inside/x.mkv', 5);
    const del = await call('shelf:xferDelete', ['/mnt/media/Movies/Newer Stuff', '/mnt/media/Movies/Fast.mkv']);
    assert.deepStrictEqual(del, { deleted: 2, failed: [] });
    assert.ok(![...slow.dirs].some((d) => d.includes('Newer Stuff')) && !slow.files.has('/srv/disk1/Movies/Fast.mkv'));
    for (const p of ['/mnt/media/Movies', '/mnt', '/', '/home/me', '/mnt/media/TV']) await assert.rejects(call('shelf:xferDelete', [p]), /\[FOLDER\]/, p);
    await assert.rejects(call('shelf:xferRename', '/mnt/media', 'Movies', 'Films'), /\[FOLDER\]/);
    await assert.rejects(call('shelf:xferMkdir', 'pc', process.env.SystemRoot || 'C:\\Windows', 'x'), /\[FOLDER\]/);
    if (process.platform === 'win32') await assert.rejects(call('shelf:xferPlan', 'down', ['/mnt/media/Movies/Charade.mkv'], process.env.SystemRoot || 'C:\\Windows'), /\[FOLDER\]/);
    ok('New Folder, Rename and Delete on the server; never the library folders, home, or the main folders; never into Windows’ own folders');

    xfer.close();
    if (shared) shared.close();
    console.log('\nServer Files: ' + passed + ' checks passed');
  } finally {
    srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
