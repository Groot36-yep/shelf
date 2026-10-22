// End-to-end in the real window: reading the title cards of a video on the Plex server. The pretend
// server (tests/fakeplex.js) serves a real SpongeBob half-hour's bytes; Fix My Plex Library lists it,
// Auto Mode asks first (saying it reads from the server), and both cartoons' title cards are read
// through Shelf's 127.0.0.1 reader without the file being downloaded. Timed against reading the
// same file on this PC.
// Run with: node tests/remotecards.smoke.js   (needs "playwright"; SB_FILE=a SpongeBob S05E03 .mkv,
// NET="940 0.3" to make the pretend server as fast and as far away as a network: Mbit/s, ms)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fake = require('./fakeplex');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = process.env.SB_FILE || 'D:/TV Shows/SpongeBob SquarePants v2/Season 5/SpongeBob.SquarePants.S05E03.720p.mkv';
const REMOTE = '/srv/disk1/TV/Spongebob/Season 5/SpongeBob.SquarePants.S05E03.720p.mkv';
const S5 = require('./fixtures/sb-titles-s3-s7.json').filter((e) => e[0] === 5);

(async () => {
  if (!fs.existsSync(LOCAL)) { console.log('skipped: no SpongeBob S05E03 at ' + LOCAL + ' (set SB_FILE)'); process.exit(0); }
  const net = process.env.NET ? { mbps: +process.env.NET.split(' ')[0], ms: +(process.env.NET.split(' ')[1] || 0) } : null;
  const srv = await fake.start({ real: { [REMOTE]: LOCAL }, net });
  const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('shelf-scan-')));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const errors = [];
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + profile, ROOT] });
  await app.evaluate(({ app: a, safeStorage }, s) => {
    const fsm = process.mainModule.require('fs'), pm = process.mainModule.require('path');
    const dir = a.getPath('userData');
    const prefs = pm.join(dir, 'shelf-prefs.json');
    let p = {}; try { p = JSON.parse(fsm.readFileSync(prefs, 'utf8')); } catch (e) { /* new */ }
    p.server = { host: '127.0.0.1', port: s.port, user: 'me', fingerprint: s.fp, keyType: 'ED25519', auth: 'password', home: '/home/me',
      movies: '/mnt/media/Movies', tv: '/mnt/media/TV', libraries: [
        { key: '1', kind: 'movies', title: 'Movies', folders: ['/mnt/media/Movies'] },
        { key: '2', kind: 'tv', title: 'TV Shows', folders: ['/mnt/media/TV'] }] };
    fsm.writeFileSync(prefs, JSON.stringify(p));
    fsm.writeFileSync(pm.join(dir, 'server-pass.bin'), safeStorage.encryptString(s.pass));
    fsm.writeFileSync(pm.join(dir, 'plex-token.bin'), safeStorage.encryptString('tok12345'));
    // Your click in Shelf's permission window (kept so the test can check what it said).
    global.__prompts = [];
    global.__shelfConsent = async (o) => { global.__prompts.push(o); return true; };
  }, { port: srv.port, fp: srv.fp, pass: srv.pass });
  if (process.env.DEBUG) app.process().stderr.on('data', (d) => process.stdout.write('[main] ' + d));
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('api.tvmaze.com/search')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([{ score: 1, show: { id: 713, name: 'SpongeBob SquarePants', premiered: '1999-05-01', weight: 99 } }]) });
    if (u.includes('api.tvmaze.com/shows/713/episodes')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify(S5.map(([season, number, name]) => ({ season, number, name, airdate: '2007-01-01', runtime: 11 }))) });
    if (u.includes('api.tvmaze.com') || u.includes('api.themoviedb.org')) return route.fulfill({ status: 200, headers: H, body: '[]' });
    return route.continue();
  });
  await win.waitForLoadState();

  // Fix My Plex Library lists the server's files (the SpongeBob half-hour among them).
  await win.evaluate(() => window.ShelfSend.refresh());
  await win.waitForSelector('#fixLibBtn:not([hidden])', { state: 'attached', timeout: 5000 });
  await win.click('#menuBtn'); await win.click('#fixLibBtn');
  await win.waitForSelector('#fixPickSheet[open]', { timeout: 15000 }).then(() => win.click('#fpGo'), () => {}); // which shows: all
  const sb = () => win.evaluate(() => window.Shelf.items().find((i) => /S05E03.*\.mkv$/.test(i.name)) || null);
  for (let i = 0; i < 80; i++) { const it = await sb(); if (it && !['pending', 'matching'].includes(it.status)) break; await sleep(250); }
  const listed = await sb();
  assert.ok(listed && listed.remote === '/mnt/media/TV/Spongebob/Season 5/SpongeBob.SquarePants.S05E03.720p.mkv' && !listed.fullPath, JSON.stringify(listed && { remote: listed.remote, status: listed.status }));
  console.log('  ✓ Check Library lists the SpongeBob half-hour on the server (' + listed.status + ')');

  // Auto Mode is offered for it, asks first (saying the video is on the server), and reads both cards.
  await win.waitForSelector('#autoMode:not([hidden])', { timeout: 5000 });
  const t0 = Date.now();
  await win.click('#autoMode');
  for (let i = 0; i < 900; i++) {
    await sleep(200);
    if (await win.evaluate(() => { const it = window.Shelf.items().find((x) => /S05E03.*\.mkv$/.test(x.name)); return !!(it && it.cards) && document.getElementById('activity').hidden; })) break;
  }
  const took = Date.now() - t0;
  const prompts = await app.evaluate(() => global.__prompts.map((p) => ({ title: p.title, files: p.files, points: p.points.map((x) => x.text) })));
  assert.strictEqual(prompts.length, 1, JSON.stringify(prompts));
  assert.deepStrictEqual(prompts[0].files, ['SpongeBob.SquarePants.S05E03.720p.mkv']);
  assert.ok(prompts[0].points.some((t) => /Plex server/.test(t)) && prompts[0].points.some((t) => /nothing is installed/i.test(t)), JSON.stringify(prompts[0]));
  console.log('  ✓ Shelf asked first: “' + prompts[0].title + '” — ' + prompts[0].points.join(' · '));
  const it = await sb();
  const names = ((it.episode && it.episode.entries) || []).map((e) => e.name);
  assert.ok(it.cards && it.cards.length, 'title cards were read');
  assert.deepStrictEqual(names.slice().sort(), ['Fungus Among Us', 'Rise and Shine'], JSON.stringify({ episode: it.episode, cards: it.cards }));
  assert.strictEqual(it.episode.how, 'card');
  assert.ok(it.minutes > 20, 'its length came from the header on the server: ' + it.minutes);
  console.log('  ✓ Both title cards read from the server in ' + (took / 1000).toFixed(1) + ' s: ' + names.join(' + ') + ' (' + Math.round(it.minutes) + ' min)');

  // Only part of the file crossed over, everything on the server was closed, nothing was saved.
  const size = fs.statSync(LOCAL).size;
  assert.ok(srv.reads.bytes < size * 0.7, 'read ' + srv.reads.bytes + ' of ' + size + ' bytes');
  assert.strictEqual(srv.reads.opens, srv.reads.closes, 'every file opened on the server was closed');
  const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('shelf-scan-') && !tmpBefore.has(n));
  assert.deepStrictEqual(left, [], 'no frames left behind');
  console.log('  ✓ ' + (srv.reads.bytes / 1e6).toFixed(0) + ' of ' + (size / 1e6).toFixed(0) + ' MB read, every server file closed, no frames left');

  // The reader was shut when the scan ended: nothing on this PC answers for it any more.
  const listening = await app.evaluate(() => process._getActiveHandles().filter((h) => h && h.constructor && h.constructor.name === 'Server' && h.address && h.address() && h.address().address === '127.0.0.1').map((h) => h.address().port));
  assert.deepStrictEqual(listening, [], 'no 127.0.0.1 server left open: ' + listening.join(','));
  console.log('  ✓ The 127.0.0.1 reader was closed after the scan');

  // Check Episodes plays it straight from the server (asks first), and lets go of the server when it's closed.
  await win.evaluate(() => { const x = window.Shelf.items().find((i) => /S05E03.*\.mkv$/.test(i.name)); document.querySelector('[data-id="' + x.id + '"]').click(); });
  await sleep(400);
  await win.click('#checkEps');
  await win.waitForSelector('#editorSheet[open]', { timeout: 30000 });
  for (let i = 0; i < 80 && !(await win.evaluate(() => document.getElementById('edVideo').videoWidth > 0 || !document.getElementById('edFrame').hidden)); i++) await sleep(250);
  const ed = await win.evaluate(() => ({ w: document.getElementById('edVideo').videoWidth, frame: !document.getElementById('edFrame').hidden, modeHidden: document.getElementById('edMode').hidden, file: document.getElementById('edFile').textContent, total: document.getElementById('edTotal').textContent }));
  assert.ok(ed.w > 0 || ed.frame, 'the video shows in Check Episodes: ' + JSON.stringify(ed));
  assert.ok(!ed.modeHidden && /Plex server/.test(ed.file), 'it says the video is on the server, and can be split: ' + JSON.stringify(ed));
  const asked = await app.evaluate(() => global.__prompts.slice(-1).map((p) => ({ title: p.title, points: p.points.map((x) => x.text) }))[0]);
  assert.ok(/Check Episodes/.test(asked.title) && asked.points.some((t) => /SSH/.test(t)), JSON.stringify(asked));
  const strip = await win.evaluate(() => { const i = document.getElementById('edStripBase'); return new Promise((res) => { const ok = () => res(i.naturalWidth); if (i.complete && i.naturalWidth) ok(); else { i.onload = ok; i.onerror = () => res(0); setTimeout(() => res(i.naturalWidth), 30000); } }); });
  assert.ok(strip > 0, 'the timeline pictures come from the server too');
  if (process.env.SHOTS) await win.screenshot({ path: path.join(process.env.SHOTS, 'check-episodes-remote.png') });
  console.log('  ✓ Check Episodes plays the video from the server (' + (ed.w ? ed.w + ' px video' : 'frame preview') + ', ' + ed.total.replace('/ ', '') + ', timeline pictures ' + strip + ' px wide)');
  await win.keyboard.press('Escape'); await sleep(1500);
  const after = await app.evaluate(() => process._getActiveHandles().filter((h) => h && h.constructor && h.constructor.name === 'Server' && h.address && h.address() && h.address().address === '127.0.0.1').map((h) => h.address().port));
  assert.deepStrictEqual(after, [], 'Check Episodes let go of the server reader');
  assert.strictEqual(srv.reads.opens, srv.reads.closes, 'every file opened on the server was closed (Check Episodes too)');
  console.log('  ✓ Closing Check Episodes closed the reader and the file on the server');

  // Its two episodes aren't next to each other: the Needs-you card offers to split it (no pile of guesses), and
  // Rename splits it on the server, keeping the original under a name Plex ignores. Undo puts it back.
  const card = await win.evaluate(() => ({ q: (document.querySelector('#needs .needs-q') || {}).textContent, answers: [...document.querySelectorAll('#needs .answer')].map((b) => b.textContent) }));
  assert.ok(/2 separate episodes/.test(card.q), JSON.stringify(card));
  assert.ok(/^Split into 2 Files/.test(card.answers[0]), JSON.stringify(card));
  assert.strictEqual(card.answers.filter((a) => /Check Episodes/.test(a)).length, 1, 'Check Episodes once: ' + JSON.stringify(card.answers));
  assert.ok(card.answers.length <= 3, 'just the answers that make sense: ' + JSON.stringify(card.answers));
  await win.click('#needs .answer.primary');
  for (let i = 0; i < 160 && !(await sb()).split; i++) await sleep(250);
  const cut = (await sb()).split;
  assert.ok(cut && cut.pieces.length === 2, 'split planned: ' + JSON.stringify(cut));
  const cutAt = cut.pieces[1].start;
  console.log('  ✓ Needs you: “' + card.q + '” → ' + card.answers.join(' | ') + '; Split into 2 Files found the gap at ' + cutAt.toFixed(1) + ' s');
  await win.click('#renameBtn'); await sleep(500);
  assert.match(await win.textContent('#renameSummary'), /will be split there/);
  const sizeBefore = srv.files.get(REMOTE), writesBefore = srv.writes.bytes;
  await win.click('#renameNow');
  const piecesOn = () => [...srv.files.keys()].filter((k) => /Season 05\/SpongeBob SquarePants - S05E(01|30) - .*\.mkv$/.test(k));
  for (let i = 0; i < 480 && !(piecesOn().length === 2 && srv.files.has(REMOTE + '.shelf-original')); i++) await sleep(250);
  const made = piecesOn();
  if (made.length !== 2) { const x = await sb(); console.log('ITEM', x.status, x.error, await win.textContent('#toast').catch(() => '')); }
  assert.strictEqual(made.length, 2, [...srv.files.keys()].join(' | '));
  assert.ok(srv.files.has(REMOTE + '.shelf-original') && !srv.files.has(REMOTE), 'the original is kept, under a name Plex ignores');
  const total = made.reduce((t, k) => t + srv.files.get(k), 0);
  assert.ok(Math.abs(total - sizeBefore) < sizeBefore * 0.05, 'the pieces add up to the original: ' + total + ' vs ' + sizeBefore);
  assert.ok(srv.writes.bytes - writesBefore >= total, 'both pieces were sent');
  for (let i = 0; i < 40 && (await sb()) && (await sb()).status !== 'done'; i++) await sleep(250);
  console.log('  ✓ Split on the server: ' + made.map((k) => k.split('/').pop() + ' (' + (srv.files.get(k) / 1e6).toFixed(0) + ' MB)').join(' + ') + '; original kept as ' + REMOTE.split('/').pop() + '.shelf-original');
  await win.click('#undoBar');
  for (let i = 0; i < 80 && !srv.files.has(REMOTE); i++) await sleep(250);
  assert.ok(srv.files.has(REMOTE) && !srv.files.has(REMOTE + '.shelf-original') && piecesOn().length === 0, 'Undo: the original is back, the pieces are gone');
  console.log('  ✓ Undo put the original back and removed the pieces');

  // The same file read on this PC, for comparison.
  const local = await app.evaluate(async (x, a) => {
    const req = process.mainModule.require, pm = req('path');
    const scan = req(pm.join(a.root, 'desktop/scan')), probe = req(pm.join(a.root, 'desktop/probe')), P = req(pm.join(a.root, 'app/js/parser.js'));
    const entries = a.names.map((name, n) => ({ name, number: n + 1, season: 1 }));
    const t = Date.now();
    await scan.scanFile(a.file, await probe.duration(a.file), { isMatch: (texts) => P.matchCardText(texts, entries, []) });
    await scan.stopOcr();
    return Date.now() - t;
  }, { file: LOCAL, root: ROOT, names: S5.map((e) => e[2]) }).catch((e) => { console.log('  (local timing failed: ' + e.message + ')'); return null; });
  if (local) console.log('  · the same file read on this PC: ' + (local / 1000).toFixed(1) + ' s (from the server: ' + (took / 1000).toFixed(1) + ' s, including the prompt and working out the episodes)');

  assert.deepStrictEqual(errors.filter((e) => !/favicon|net::ERR/.test(e)), []);
  await app.close();
  // Pieces of the video from around both title cards (the parts that were read) appear in no file Shelf could have written.
  const fd = fs.openSync(LOCAL, 'r');
  const pieces = [0.02, 0.04, 0.48, 0.52].map((at) => { const b = Buffer.alloc(64); fs.readSync(fd, b, 0, 64, Math.floor(size * at)); return b; });
  fs.closeSync(fd);
  const holders = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) { const b = fs.readFileSync(p); if (pieces.some((x) => b.indexOf(x) >= 0)) holders.push(p); }
    }
  })(profile);
  assert.deepStrictEqual(holders, [], 'no piece of the video saved');
  console.log('  ✓ No piece of the video was saved in Shelf’s profile');
  srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('Remote title cards smoke test passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
