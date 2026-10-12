// End-to-end check of the TheTVDB and TMDB TV paths (services mocked in their documented shapes).
// Run with: xvfb-run -a node tests/sources.smoke.js   (needs the "playwright" package)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = require('./fixtures/cartoons.json');
const SB = F.spongebob.map(([season, number, name, aired, runtime], i) => ({ id: 1000 + i, seasonNumber: season, number, name, aired, runtime }));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-src-'));
  const dl = path.join(tmp, 'Downloads'); const lib = path.join(tmp, 'Plex');
  fs.mkdirSync(path.join(dl, 'SpongeBob', 'Season 1'), { recursive: true }); fs.mkdirSync(lib);
  for (const f of ['SpongeBob.S01E02.Bubblestand.Ripped.Pants.mkv', 'SpongeBob.S01E06.Jellyfishing.mkv']) fs.writeFileSync(path.join(dl, 'SpongeBob', 'Season 1', f), 'v');

  const log = [];
  let tokenUsed = null;
  const handle = async (route) => {
    const req = route.request(); const u = req.url();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: H, body: '' });
    if (u.startsWith('https://api4.thetvdb.com/v4/')) {
      const p = u.slice('https://api4.thetvdb.com/v4'.length);
      log.push('TVDB ' + req.method() + ' ' + p.replace(/\?.*/, ''));
      if (p === '/login') {
        const body = JSON.parse(req.postData() || '{}');
        if (body.apikey !== 'tvdb-test-key') return route.fulfill({ status: 401, headers: H, body: '{"status":"failure"}' });
        return route.fulfill({ status: 200, headers: H, body: JSON.stringify({ status: 'success', data: { token: 'tok123' } }) });
      }
      tokenUsed = req.headers().authorization;
      if (tokenUsed !== 'Bearer tok123') return route.fulfill({ status: 401, headers: H, body: '{}' });
      if (p.startsWith('/search')) {
        return route.fulfill({ status: 200, headers: H, body: JSON.stringify({ status: 'success', data: [
          { tvdb_id: '75886', name: 'SpongeBob SquarePants', year: '1999', country: 'usa', slug: 'spongebob-squarepants', thumbnail: 'https://artworks.thetvdb.com/banners/x.jpg', translations: { eng: 'SpongeBob SquarePants' } },
          { tvdb_id: '9999', name: 'Kamp Koral: SpongeBob’s Under Years', year: '2021', country: 'usa' }
        ] }) });
      }
      const m = p.match(/^\/series\/(\d+)\/episodes\/(default|dvd)(\/eng)?\?page=(\d+)/);
      if (m) {
        const page = +m[4]; // two pages, to check paging
        const eps = page === 0 ? SB.slice(0, 50) : SB.slice(50);
        return route.fulfill({ status: 200, headers: H, body: JSON.stringify({ status: 'success', data: { series: { id: 75886 }, episodes: eps }, links: { next: page === 0 ? 'x' : null } }) });
      }
      return route.fulfill({ status: 404, headers: H, body: '{}' });
    }
    if (u.startsWith('https://api.themoviedb.org/3/')) {
      const p = u.slice('https://api.themoviedb.org/3'.length);
      log.push('TMDB ' + p.replace(/api_key=[^&]+/, 'api_key=…').replace(/append_to_response=[^&]+/, 'append_to_response=…'));
      if (p.startsWith('/search/tv')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify({ results: [{ id: 387, name: 'SpongeBob SquarePants', original_name: 'SpongeBob SquarePants', first_air_date: '1999-05-01', popularity: 300, origin_country: ['US'] }] }) });
      if (p.startsWith('/tv/387')) {
        const out = { id: 387, name: 'SpongeBob SquarePants', number_of_seasons: 2 };
        for (const sn of [1, 2]) out['season/' + sn] = { season_number: sn, episodes: SB.filter((e) => e.seasonNumber === sn).map((e) => ({ season_number: sn, episode_number: e.number, name: e.name, air_date: e.aired, runtime: e.runtime })) };
        return route.fulfill({ status: 200, headers: H, body: JSON.stringify(out) });
      }
      if (p.startsWith('/configuration')) return route.fulfill({ status: 200, headers: H, body: '{}' });
    }
    if (u.includes('api.tvmaze.com')) { log.push('TVMAZE ' + u); return route.fulfill({ status: 500, headers: H, body: '[]' }); }
    return route.continue();
  };

  const errors = [];
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-')), ROOT] });
  await app.evaluate(({ dialog }, dirs) => { const q = [...dirs]; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [q.shift()] }); }, [dl, lib, dl]);
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await win.route('**/*', handle);
  await win.waitForLoadState();

  // 1. TheTVDB: wrong key is refused, right key works; choose TheTVDB (Aired).
  await win.click('.side-item[data-open=settings]');
  await win.fill('#tvdbInput', 'wrong'); await win.click('#testTvdb'); await sleep(400);
  assert.match(await win.textContent('#tvdbStatusText'), /didn’t accept/);
  await win.fill('#tvdbInput', 'tvdb-test-key'); await win.click('#testTvdb'); await sleep(400);
  assert.match(await win.textContent('#tvdbStatusText'), /It works/);
  await win.selectOption('#optOrder', 'tvdb');
  await win.keyboard.press('Escape'); await sleep(300);
  assert.strictEqual(await win.textContent('#tvdbStatus .src-note'), 'Ready');

  await win.click('text=Choose Folder…');
  const settled = () => win.evaluate(() => window.Shelf.items().length > 0 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)));
  for (let i = 0; i < 60 && !(await settled()); i++) await sleep(100);
  await sleep(300); // let the list redraw
  const names = () => win.evaluate(() => window.Shelf.items().map((i) => i.status + ' ' + [...document.querySelectorAll('[data-id="' + i.id + '"] .newname, [data-id="' + i.id + '"] .new-cell .sub')].map((n) => n.textContent + (n.title ? ' [' + n.title + ']' : '')).join(' | ')));
  let n = await names();
  console.log('TheTVDB order:\n ', n.join('\n  '));
  console.log(' ', log.join('\n  '));
  assert.ok(n.every((x) => x.startsWith('matched')), 'matched without asking');
  assert.ok(n.some((x) => x.includes('SpongeBob SquarePants - S01E04-E05 - Bubblestand & Ripped Pants.mkv') && x.includes('{tvdb-75886}')), 'TVDB half-hour name');
  assert.ok(n.some((x) => x.includes('SpongeBob SquarePants - S01E06 - Jellyfishing.mkv')), 'TVDB single');
  assert.strictEqual(log.filter((l) => l.includes('/login')).length, 2, 'wrong key, right key; lookups reuse the sign-in');
  assert.ok(log.some((l) => l.includes('/episodes/default/eng')), 'aired order, English');
  assert.strictEqual(tokenUsed, 'Bearer tok123');
  assert.ok(!log.some((l) => l.startsWith('TVMAZE')), 'TVmaze not used when TheTVDB is set');

  // 2. Switch to The Movie Database order (Plex's default): re-matches with TMDB.
  log.length = 0;
  await win.click('.side-item[data-open=settings]');
  await win.fill('#keyInput', 'tmdb-key'); await win.dispatchEvent('#keyInput', 'change');
  await win.selectOption('#optOrder', 'tmdb');
  await win.keyboard.press('Escape'); await sleep(300);
  for (let i = 0; i < 60 && !(await settled()); i++) await sleep(100);
  await sleep(300);
  n = await names();
  console.log('TMDB order:\n ', n.join('\n  '));
  console.log(' ', log.join('\n  '));
  assert.ok(n.some((x) => x.includes('S01E04-E05') && x.includes('{tmdb-387}')), 'TMDB name with tmdb id');
  assert.strictEqual(log.filter((l) => l.startsWith('TMDB /tv/387')).length, 1, 'one request for the whole show');

  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ERRORS:', errors);
  assert.deepStrictEqual(errors, []);
  console.log('Sources test passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
