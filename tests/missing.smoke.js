// End-to-end in the real window: Missing Episodes, with SpongeBob's first two seasons (77 cartoons on TVmaze,
// mocked) and a pretend Plex server (tests/fakeplex.js).
//  - Season 1 is in Shelf's list as 20 files of two or three cartoons each ("S01E01-E02-E03", "S01E04E05").
//  - Season 2 is on the server, as one file per cartoon and some two-part files, with two episodes left out.
//    A second, oddly named folder ("Spongebob") holds an episode TVmaze doesn't list, which is said apart.
// The shelf's "Missing Episodes" lists exactly the two missing ones; once they're on the server, it says you have
// all 77. From the ⚙ menu, a show that's only on the server can be checked too.
// Run with: node tests/missing.smoke.js   (needs the "playwright" package; SHOTS=dir saves screenshots)
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
const pad = (x) => (x < 10 ? '0' : '') + x;

const F = require('./fixtures/cartoons.json');
const SPONGE = F.spongebob.map(([season, number, name, airdate, runtime]) => ({ season, number, name, airdate, runtime }));
const show = (id, name, premiered, extra) => Object.assign({ id, name, premiered, weight: 99, network: { name: 'Net', country: { code: 'US' } }, url: 'https://www.tvmaze.com/shows/' + id }, extra || {});
const SEARCH = {
  'spongebob squarepants': [show(713, 'SpongeBob SquarePants', '1999-05-01', { externals: { thetvdb: 75886 } })],
  'good show': [show(5000, 'Good Show', '2010-01-01')]
};
const EPISODES = {
  713: SPONGE.concat([{ season: 0, number: 1, name: 'Christmas Who?', airdate: '2000-12-06' }]),
  5000: [{ season: 1, number: 1, name: 'Pilot', airdate: '2010-01-01' }, { season: 1, number: 2, name: 'The Second One', airdate: '2010-01-08' }]
};

// Season 1, in the list: the way a real season-pack names its files.
const S1 = ['S01E01-E02-E03 Help Wanted - Reef Blower-Tea at the Treedome'];
for (let e = 4; e <= 41; e += 2) S1.push('S01E' + pad(e) + 'E' + pad(e + 1) + ' ' + SPONGE.find((x) => x.season === 1 && x.number === e).name + ' - ' + SPONGE.find((x) => x.season === 1 && x.number === e + 1).name);
// Season 2, on the server: one file per cartoon, but E03 and E04 together, and E07 and E20 left out.
const SB = '/srv/disk1/TV/SpongeBob SquarePants (1999)/Season 02/';
const S2 = {};
for (const e of SPONGE.filter((x) => x.season === 2)) {
  if ([4, 7, 20].includes(e.number)) continue;
  const code = e.number === 3 ? 'S02E03-E04' : 'S02E' + pad(e.number);
  S2[SB + 'SpongeBob SquarePants - ' + code + ' - ' + e.name.replace(/[\\/:*?"<>|]/g, '') + '.mkv'] = 300e6;
}
const missingOn = (season) => SPONGE.filter((x) => x.season === season);

(async () => {
  const srv = await fake.start({ extra: S2 });
  const shots = process.env.SHOTS;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-missing-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const dl = path.join(tmp, 'SpongeBob SquarePants 1999.S01.720p', 'S01');
  fs.mkdirSync(dl, { recursive: true });
  const local = S1.map((n) => { const name = 'SpongeBob SquarePants ' + n + '.mkv'; fs.writeFileSync(path.join(dl, name), 'v'); return name; });

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
  }, { port: srv.port, fp: srv.fp, pass: srv.pass });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.route('**/*', (route) => {
    const u = route.request().url();
    if (!u.includes('api.tvmaze.com')) return route.continue();
    const sm = u.match(/search\/shows\?q=([^&]+)/);
    if (sm) return route.fulfill({ status: 200, body: JSON.stringify((SEARCH[decodeURIComponent(sm[1])] || []).map((s, i) => ({ score: 1 - i * 0.01, show: s }))), headers: H });
    const em = u.match(/shows\/(\d+)\/episodes/);
    return route.fulfill({ status: 200, body: JSON.stringify(em ? EPISODES[em[1]] || [] : []), headers: H });
  });
  await win.waitForLoadState();

  // Season 1's files go into the list, and Shelf works out each of them.
  await win.evaluate((files) => window.Shelf.addFiles(files), local.map((name) => ({ name, relPath: 'SpongeBob SquarePants 1999.S01.720p/S01/' + name, size: 1, fullPath: path.join(dl, name) })));
  const settled = () => win.evaluate(() => window.Shelf.items().length > 0 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)));
  for (let i = 0; i < 100 && !(await settled()); i++) await sleep(100);
  await sleep(400);
  const eps = await win.evaluate(() => window.Shelf.items().map((i) => (window.ShelfMissing.heldByItem(i) || []).length));
  assert.strictEqual(eps.reduce((a, b) => a + b, 0), 41, 'the 20 files hold all 41 cartoons of season 1: ' + JSON.stringify(eps));
  console.log('  ✓ Season 1 in the list: 20 files, 41 cartoons');

  // The shelf's Missing Episodes: the list and the server together.
  if (shots) await win.screenshot({ path: path.join(shots, 'missing-shelf.png'), clip: { x: 0, y: 60, width: 1320, height: 160 } });
  await win.click('.shelf-missing');
  await win.waitForSelector('#missingSheet[open]');
  await win.waitForSelector('#msSum .ms-big', { timeout: 20000 });
  const view = () => win.evaluate(() => ({
    big: document.querySelector('#msSum .ms-big b').textContent,
    seasons: [...document.querySelectorAll('#msList .ms-season')].map((s) => s.querySelector('.dp-head').textContent + ': ' + [...s.querySelectorAll('.ms-ep')].map((r) => r.querySelector('.ms-code').textContent + ' ' + r.querySelector('.ms-name').textContent).join(', ')),
    notes: [...document.querySelectorAll('#msList .ms-note')].map((p) => p.textContent),
    help: document.getElementById('msHelp').textContent, pick: document.getElementById('msShow').value,
    copy: !document.getElementById('msCopy').hidden
  }));
  let v = await view();
  assert.strictEqual(v.big, 'Missing 2 of 77 episodes', JSON.stringify(v));
  assert.deepStrictEqual(v.seasons, ['Season 2missing 2 of 36: S02E07 ' + missingOn(2)[6].name + ', S02E20 Gary Takes a Bath'], JSON.stringify(v));
  assert.ok(v.notes.some((x) => /Complete: Season 1/.test(x)), 'season 1 is complete: ' + JSON.stringify(v.notes));
  assert.ok(v.notes.some((x) => /S05E03/.test(x) && /isn’t on TVmaze’s list/.test(x)), 'the episode TVmaze doesn’t list is said apart: ' + JSON.stringify(v.notes));
  assert.ok(v.notes.some((x) => /Specials aren’t counted: you have 0 of 1/.test(x)), 'specials apart: ' + JSON.stringify(v.notes));
  assert.match(v.help, /20 files in this list and 34 files on your server \(TV Shows \/ SpongeBob SquarePants \(1999\), TV Shows \/ Spongebob\)/);
  assert.ok(v.copy, 'the list can be copied');
  if (shots) await win.screenshot({ path: path.join(shots, 'missing-two.png') });
  if (shots) { // and in the other looks
    for (const [theme, scheme] of [['seventies', 'light'], ['seventies', 'dark'], ['studio', 'dark']]) {
      await win.emulateMedia({ colorScheme: scheme });
      await win.evaluate((t) => window.Shelf.setTheme(t, true), theme); await sleep(300);
      await win.screenshot({ path: path.join(shots, 'missing-two-' + theme + '-' + scheme + '.png') });
    }
    await win.emulateMedia({ colorScheme: 'light' }); await win.evaluate(() => window.Shelf.setTheme('studio', true));
  }
  console.log('  ✓ ' + v.big + ': ' + v.seasons.join(' | '));
  await win.click('#missingSheet button[value="ok"]');

  // The two missing ones arrive on the server: now it has them all.
  srv.files.set(SB + 'SpongeBob SquarePants - S02E07 - ' + missingOn(2)[6].name + '.mkv', 300e6);
  srv.files.set(SB + 'SpongeBob SquarePants - S02E20 - Gary Takes a Bath.mkv', 300e6);
  await win.click('.shelf-missing');
  await win.waitForSelector('#msSum .ms-big.is-done', { timeout: 20000 });
  v = await view();
  assert.strictEqual(v.big, 'You have all 77 episodes');
  assert.match(await win.textContent('#msSum .ms-big small'), /^Seasons 1 and 2, every episode that has aired$/);
  assert.deepStrictEqual(v.seasons, []);
  assert.ok(!v.copy, 'nothing to copy');
  if (shots) await win.screenshot({ path: path.join(shots, 'missing-none.png') });
  console.log('  ✓ ' + v.big);
  await win.keyboard.press('Escape');
  await sleep(300);

  // From the ⚙ menu: a show only on the server ("Good Show", one of its two episodes there).
  await win.click('#menuBtn'); await win.click('#missingBtn');
  await win.waitForSelector('#msSum .ms-big', { timeout: 20000 });
  const options = await win.$$eval('#msShow option', (os) => os.map((o) => o.value + '=' + o.textContent));
  assert.ok(options.includes('list:TVmaze:713=SpongeBob SquarePants (1999)'), JSON.stringify(options));
  assert.ok(options.includes('server:/mnt/media/TV/Good Show=Good Show'), JSON.stringify(options));
  assert.ok(!options.some((o) => /server:.*SpongeBob SquarePants \(1999\)/.test(o)), 'a show in the list isn’t offered twice: ' + JSON.stringify(options));
  await win.selectOption('#msShow', 'server:/mnt/media/TV/Good Show');
  await win.waitForFunction(() => /Good Show/.test(document.getElementById('msTitle').textContent) && document.querySelector('#msSum .ms-big'), null, { timeout: 20000 });
  v = await view();
  assert.strictEqual(v.big, 'Missing 1 of 2 episodes', JSON.stringify(v));
  assert.deepStrictEqual(v.seasons, ['Season 1missing 1 of 2: S01E02 The Second One']);
  assert.match(v.help, /1 file on your server \(TV Shows \/ Good Show\)/);
  if (shots) await win.screenshot({ path: path.join(shots, 'missing-server.png') });
  console.log('  ✓ ⚙ → Missing Episodes… checks a show that’s only on the server: ' + v.seasons[0]);
  assert.ok(![...srv.files.keys()].some((k) => /shelf-/.test(k)), 'nothing on the server was changed');
  assert.deepStrictEqual(errors, []);
  await app.close();
  srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Missing episodes smoke test passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
