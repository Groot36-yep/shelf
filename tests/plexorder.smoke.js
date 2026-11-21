// End-to-end: a file named right that Plex shows as another episode (Plex using another episode order for the
// show). Fix My Plex Library lists it with the reason, and Shelf sets the show's episode order in Plex.
// Against the pretend Plex server (tests/fakeplex.js); lookups mocked. Run with: node tests/plexorder.smoke.js
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
const EPS = [[1, 'Pilot'], [2, 'Second'], [3, 'Third']];
const DIR = '/srv/disk1/TV/Good Show/Season 01/';

(async () => {
  const srv = await fake.start({
    extra: { [DIR + 'Good Show - S01E02 - Second.mkv']: 2100 },
    // Plex shows "S01E02 - Second" as episode 3 (its order differs); S01E01 as it should be.
    plexEpisodes: [{ grandparentGuid: 'plex://show/1', grandparentRatingKey: '77', parentIndex: 1, index: 3, title: 'Third', Media: [{ Part: [{ file: '/mnt/media/TV/Good Show/Season 01/Good Show - S01E02 - Second.mkv' }] }] }]
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const errors = [];
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + profile, ROOT] });
  await app.evaluate(({ app: a, safeStorage }, s) => {
    const fsm = process.mainModule.require('fs'), pm = process.mainModule.require('path');
    const dir = a.getPath('userData');
    fsm.writeFileSync(pm.join(dir, 'shelf-prefs.json'), JSON.stringify({ server: { host: '127.0.0.1', port: s.port, user: 'me', fingerprint: s.fp, keyType: 'ED25519', auth: 'password', home: '/home/me',
      movies: '/mnt/media/Movies', tv: '/mnt/media/TV', libraries: [{ key: '2', kind: 'tv', title: 'TV Shows', folders: ['/mnt/media/TV'] }] } }));
    fsm.writeFileSync(pm.join(dir, 'server-pass.bin'), safeStorage.encryptString(s.pass));
    fsm.writeFileSync(pm.join(dir, 'plex-token.bin'), safeStorage.encryptString('tok12345'));
  }, { port: srv.port, fp: srv.fp, pass: srv.pass });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('api.tvmaze.com') && u.includes('search')) return route.fulfill({ status: 200, body: JSON.stringify([{ score: 1, show: { id: 900, name: 'Good Show', premiered: '2010-01-01' } }]), headers: H });
    if (u.includes('api.tvmaze.com')) return route.fulfill({ status: 200, body: JSON.stringify(EPS.map(([n, name]) => ({ season: 1, number: n, name, summary: '<p>Episode ' + name + '.</p>' }))), headers: H });
    return route.continue();
  });
  await win.waitForLoadState();
  await win.evaluate(() => window.ShelfSend.refresh());
  await win.waitForSelector('#fixLibBtn:not([hidden])', { state: 'attached', timeout: 5000 });
  await win.click('#menuBtn'); await win.click('#fixLibBtn');
  await win.waitForSelector('#fixPickSheet[open]', { timeout: 15000 });
  const groups = await win.$$eval('#fpList .fp-row', (rows) => rows.map((r) => r.querySelector('b').textContent + ': ' + r.querySelector('small').textContent));
  const good = groups.find((g) => g.startsWith('Good Show'));
  assert.ok(good && /1 Plex shows as another episode/.test(good), 'the file Plex shows wrongly is listed, with why: ' + JSON.stringify(groups));
  console.log('  ✓ listed: ' + good);
  // Only that show.
  for (const g of groups) if (!g.startsWith('Good Show')) await win.click('#fpList .fp-show[data-name="' + g.split(':')[0].toLowerCase() + '"] .fp-row input');
  await win.click('#fpGo');
  const it = () => win.evaluate(() => window.Shelf.items().filter((i) => /S01E02/.test(i.name)).map((i) => ({ s: i.status, ep: i.episode && i.episode.number, says: i.plexSays, err: i.error }))[0]);
  for (let i = 0; i < 80; i++) { const x = await it(); if (x && x.ep) break; await sleep(150); }
  const before = await it();
  assert.strictEqual(before.ep, 2, 'Shelf agrees with the name');
  assert.deepStrictEqual(before.says, { season: 1, number: 3, title: 'Third' });
  assert.strictEqual(before.s, 'review'); assert.match(before.err, /Plex shows this file as S01E03 “Third”, but its name is right/);
  // Its question offers to fix the show's order in Plex.
  await win.evaluate(() => { const i = window.Shelf.items().find((x) => /S01E02/.test(x.name)); document.querySelector('[data-id="' + i.id + '"]').click(); });
  await sleep(400);
  const btn = await win.waitForSelector('button:has-text("Use TheTVDB (Aired) in Plex")', { timeout: 5000 });
  await btn.click();
  for (let i = 0; i < 60 && !srv.showOrdering['77']; i++) await sleep(150);
  assert.strictEqual(srv.showOrdering['77'], 'aired', 'the show’s order in Plex is now TheTVDB (Aired)');
  assert.ok(srv.plexAsked.includes('PUT /library/metadata/77/prefs?showOrdering=aired') && srv.plexAsked.includes('PUT /library/metadata/77/refresh'), JSON.stringify(srv.plexAsked));
  await sleep(300);
  const after = await it();
  assert.strictEqual(after.s, 'matched', 'nothing left to do for it: ' + JSON.stringify(after));
  console.log('  ✓ the show’s episode order in Plex set to TheTVDB (Aired), and Plex asked to refresh it');
  assert.deepStrictEqual(errors, []);
  await app.close(); srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('Plex episode order test passed');
})().catch((e) => { console.error(e); process.exit(1); });
