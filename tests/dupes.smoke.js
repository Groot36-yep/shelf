// End-to-end in the real window: Find Duplicate Episodes against a pretend Plex server (tests/fakeplex.js).
// SpongeBob's first half-hour of season 2 is there as one file and as two separate files (in another folder,
// as when some were split by hand), and one episode is there twice. Shelf groups them, keeps one copy of each
// (two-part files, or one file per episode: your choice), sets the rest aside (renamed, never deleted, their
// subtitles too), and Undo puts them back.
// Run with: node tests/dupes.smoke.js   (needs the "playwright" package; SHOTS=dir saves screenshots)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fake = require('./fakeplex');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOGETHER = '/srv/disk1/TV/SpongeBob SquarePants {tmdb-387}/Season 02/SpongeBob SquarePants - S02E01-E02 - Something Smells & Bossy Boots.mkv';
const ONE = '/srv/disk1/TV/Spongebob/Season 2/SpongeBob.SquarePants.S02E01.Something.Smells.mkv';
const ONE_SUB = '/srv/disk1/TV/Spongebob/Season 2/SpongeBob.SquarePants.S02E01.Something.Smells.en.srt';
const TWO = '/srv/disk1/TV/Spongebob/Season 2/SpongeBob.SquarePants.S02E02.Bossy.Boots.mkv';
const COPY_A = '/srv/disk1/TV/SpongeBob SquarePants {tmdb-387}/Season 02/SpongeBob SquarePants - S02E05 - Big Pink Loser.mkv';
const COPY_B = '/srv/disk1/TV/SpongeBob SquarePants {tmdb-387}/Season 02/SpongeBob SquarePants - S02E05 - Big Pink Loser (1).mkv';

(async () => {
  const srv = await fake.start({ extra: { [TOGETHER]: 700e6, [ONE]: 350e6, [ONE_SUB]: 2e4, [TWO]: 340e6, [COPY_A]: 300e6, [COPY_B]: 320e6 } });
  const shots = process.env.SHOTS;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const errors = [];
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + profile, ROOT] });
  await app.evaluate(({ app: a, safeStorage }, s) => {
    const fsm = process.mainModule.require('fs'), pm = process.mainModule.require('path');
    const dir = a.getPath('userData');
    fsm.writeFileSync(pm.join(dir, 'shelf-prefs.json'), JSON.stringify({ server: { host: '127.0.0.1', port: s.port, user: 'me', fingerprint: s.fp, keyType: 'ED25519', auth: 'password', home: '/home/me',
      movies: '/mnt/media/Movies', tv: '/mnt/media/TV', libraries: [
        { key: '1', kind: 'movies', title: 'Movies', folders: ['/mnt/media/Movies'] },
        { key: '2', kind: 'tv', title: 'TV Shows', folders: ['/mnt/media/TV'] }] } }));
    fsm.writeFileSync(pm.join(dir, 'server-pass.bin'), safeStorage.encryptString(s.pass));
    fsm.writeFileSync(pm.join(dir, 'plex-token.bin'), safeStorage.encryptString('tok12345'));
  }, { port: srv.port, fp: srv.fp, pass: srv.pass });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.waitForLoadState();
  await win.evaluate(() => window.ShelfSend.refresh());
  await win.waitForSelector('#dupesBtn:not([hidden])', { state: 'attached', timeout: 5000 });
  await win.click('#menuBtn'); await win.click('#dupesBtn');
  await win.waitForSelector('#dupesSheet[open]', { timeout: 20000 });
  const groups = () => win.$$eval('#dpList .dp-group', (gs) => gs.map((g) => ({
    head: g.querySelector('.dp-head').textContent, lost: g.classList.contains('lost'),
    files: [...g.querySelectorAll('.dp-file')].map((r) => (r.querySelector('input').checked ? 'KEEP ' : 'aside ') + r.querySelector('.dp-name').textContent)
  })));
  let g = await groups();
  assert.strictEqual(g.length, 2, JSON.stringify(g));
  assert.match(g[0].head, /S02E01–E02/); assert.match(g[1].head, /S02E05/);
  // Two-part files to start with (there are more of those here): the one file stays, the separate ones go.
  assert.deepStrictEqual(g[0].files.map((f) => f.split(' ')[0]), ['KEEP', 'aside', 'aside'], JSON.stringify(g[0]));
  assert.ok(g[1].files.some((f) => f === 'KEEP SpongeBob SquarePants - S02E05 - Big Pink Loser (1).mkv'), 'of two copies, the bigger stays: ' + JSON.stringify(g[1]));
  assert.strictEqual(await win.textContent('#dpGo'), 'Set Aside 3 Files');
  if (shots) await win.screenshot({ path: path.join(shots, 'dupes-together.png') });
  console.log('  ✓ Found 2 groups: ' + g.map((x) => x.head + ' [' + x.files.join(', ') + ']').join(' | '));
  // One file per episode instead.
  await win.click('#dpPref [data-pref="separate"]');
  g = await groups();
  assert.deepStrictEqual(g[0].files.map((f) => f.split(' ')[0]), ['aside', 'KEEP', 'KEEP'], JSON.stringify(g[0]));
  // Keeping no copy of an episode isn't allowed.
  await win.click('#dpList .dp-group:first-child .dp-file:nth-child(2) input');
  g = await groups();
  assert.ok(g[0].lost && (await win.isDisabled('#dpGo')), 'every episode keeps a copy');
  assert.match(await win.textContent('#dpList .dp-warn'), /Keep at least one copy of S02E01/);
  await win.click('#dpList .dp-group:first-child .dp-file:nth-child(2) input');
  assert.strictEqual(await win.textContent('#dpGo'), 'Set Aside 2 Files');
  if (shots) await win.screenshot({ path: path.join(shots, 'dupes-separate.png') });
  console.log('  ✓ One File per Episode keeps the separate ones; a group can’t lose its last copy of an episode');
  await win.click('#dpGo');
  for (let i = 0; i < 60 && !srv.files.has(TOGETHER + '.shelf-duplicate'); i++) await sleep(200);
  await sleep(300);
  assert.ok(srv.files.has(TOGETHER + '.shelf-duplicate') && !srv.files.has(TOGETHER), 'the two-part file was set aside (renamed)');
  assert.ok(srv.files.has(COPY_A + '.shelf-duplicate') && srv.files.has(COPY_B), 'the smaller copy was set aside');
  assert.ok(srv.files.has(ONE) && srv.files.has(TWO) && srv.files.has(ONE_SUB), 'the separate files (and the subtitle) stay');
  assert.ok(srv.plexAsked.some((u) => /\/library\/sections\/2\/refresh$/.test(u)), 'Plex was asked to rescan the TV library');
  assert.ok(await win.isVisible('#undoBar'), 'Undo is offered');
  console.log('  ✓ Set aside on the server (renamed to .shelf-duplicate, nothing deleted), and Plex rescans');
  await win.click('#undoBar');
  for (let i = 0; i < 60 && !srv.files.has(TOGETHER); i++) await sleep(200);
  assert.ok(srv.files.has(TOGETHER) && srv.files.has(COPY_A) && ![...srv.files.keys()].some((k) => k.endsWith('.shelf-duplicate')), 'Undo put them back');
  console.log('  ✓ Undo put them back');

  // Set them aside again (two-part files this time), then Free Up Space deletes them for good, after asking.
  await win.click('#menuBtn'); await win.click('#dupesBtn');
  await win.waitForSelector('#dupesSheet[open]', { timeout: 20000 }); await sleep(400);
  await win.click('#dpGo');
  const aside = [ONE + '.shelf-duplicate', ONE_SUB + '.shelf-duplicate', TWO + '.shelf-duplicate', COPY_A + '.shelf-duplicate'];
  for (let i = 0; i < 80 && !aside.every((f) => srv.files.has(f)); i++) await sleep(200);
  assert.ok(aside.every((f) => srv.files.has(f)), 'set aside: ' + [...srv.files.keys()].filter((k) => /shelf-/.test(k)).join(' | '));
  srv.files.set('/srv/disk1/TV/Spongebob/Season 4/SpongeBob.SquarePants.4x34.mkv.shelf-original', 500e6); // as after a split there
  srv.dirs.add('/srv/disk1/TV/Spongebob/Season 4');
  await sleep(1500);
  await win.click('#menuBtn'); await win.click('#spaceBtn');
  await win.waitForSelector('#spaceSheet[open]', { timeout: 20000 }); await sleep(400);
  const rows = await win.$$eval('#spList .dp-file .dp-name', (x) => x.map((n) => n.textContent));
  assert.strictEqual(rows.length, 5, JSON.stringify(rows));
  assert.ok(rows.includes('SpongeBob.SquarePants.4x34.mkv') && rows.includes('SpongeBob.SquarePants.S02E01.Something.Smells.en.srt'), JSON.stringify(rows));
  assert.match(await win.textContent('#spGo'), /^Delete 5 Files \(1\.5 GB\)$/);
  assert.match(await win.textContent('#spWarn'), /can’t be put back/);
  if (shots) await win.screenshot({ path: path.join(shots, 'free-space.png') });
  await win.click('#spList .dp-file:last-child input'); // keep one for now
  assert.match(await win.textContent('#spGo'), /^Delete 4 Files/);
  await win.click('#spGo');
  for (let i = 0; i < 60 && [...srv.files.keys()].filter((k) => /\.shelf-(original|duplicate)$/.test(k)).length > 1; i++) await sleep(200);
  const left = [...srv.files.keys()].filter((k) => /\.shelf-(original|duplicate)$/.test(k));
  assert.strictEqual(left.length, 1, 'deleted the four picked, kept the one unticked: ' + left.join(' | '));
  assert.ok(srv.files.has(TOGETHER) && srv.files.has(COPY_B), 'the copies in the library are untouched');
  await sleep(800);
  assert.ok(await win.isHidden('#undoBar'), 'Undo can’t bring deleted files back, so it isn’t offered for them');
  console.log('  ✓ Free Up Space on Server: listed 5 set-aside files (1.5 GB), deleted the 4 picked, Undo cleared');
  assert.deepStrictEqual(errors, []);
  await app.close();
  srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('Duplicate episodes smoke test passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
