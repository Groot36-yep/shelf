// End-to-end: the list as shelves (one per show, one for movies), plain-words reasons,
// the show-level question and Read Title Cards on the shelf, Next to Check, and the Rename count.
// Run with: xvfb-run -a node tests/shelves.smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = require('./fixtures/cartoons.json');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-shelves-'));
  const dir = path.join(tmp, 'Downloads', 'SpongeBob'); fs.mkdirSync(dir, { recursive: true });
  // Out of order on purpose: the shelf shows them in episode order.
  ['SpongeBob.S01E09.mkv', 'SpongeBob.S01E06.mkv', 'SpongeBob.S01E07.mkv'].forEach((n) => fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-title-card.mkv'), path.join(dir, n)));
  fs.writeFileSync(path.join(tmp, 'Downloads', 'Charade.1963.1080p.mkv'), 'x');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const exe = process.env.PACKAGED ? path.join(ROOT, 'dist/linux-unpacked/shelf') : path.join(ROOT, 'node_modules/electron/dist/electron');
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--user-data-dir=' + profile].concat(process.env.PACKAGED ? [] : [ROOT]) });
  await app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }); global.__prompts = []; global.__shelfConsent = async (o) => { global.__prompts.push(o.title); return false; }; }, path.join(tmp, 'Downloads'));
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1320, height: 840 }).catch(() => {});
  const errors = []; win.on('pageerror', (e) => errors.push(String(e)));
  await win.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('api.tvmaze.com/search')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([{ score: 1, show: { id: 713, name: 'SpongeBob SquarePants', premiered: '1999-05-01', weight: 99 } }]) });
    if (u.includes('api.tvmaze.com/shows/713/episodes')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify(F.spongebob.map(([season, number, name, airdate, runtime]) => ({ season, number, name, airdate, runtime }))) });
    return route.continue();
  });
  await win.waitForLoadState();
  await win.click('#chooseFolder');
  for (let i = 0; i < 80; i++) { await sleep(100); if (await win.evaluate(() => window.Shelf.items().length === 4 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)))) break; }
  await sleep(300);

  const heads = await win.$$eval('.shelf-head h3', (x) => x.map((n) => n.textContent));
  assert.deepStrictEqual(heads, ['SpongeBob SquarePants', 'Movies'], 'one shelf per show, movies last');
  const codes = await win.$$eval('.shelf:first-child .r-code', (x) => x.map((n) => n.textContent));
  assert.deepStrictEqual(codes, ['S01E06', 'S01E07', 'S01E09'], 'episodes in order');
  assert.ok(await win.isVisible('#autoMode'), 'Read Title Cards is in the top bar whenever there are TV videos');
  assert.strictEqual(await win.$$eval('.shelf-head button.pill', (x) => x.length), 0, 'no second copy of it on the shelves');
  assert.ok(await win.isVisible('.shelf:first-child .shelf-ask'), 'the cartoon / half-hour question is asked once, on the shelf');
  const reasons = await win.$$eval('.r-file.reason', (x) => x.map((n) => n.textContent));
  assert.ok(reasons.some((r) => /TMDB key/.test(r)), 'the movie says why: ' + JSON.stringify(reasons));
  assert.strictEqual(await win.textContent('#allCount'), '4');

  // N walks through the files that need a look, in the order shown.
  const sel = () => win.evaluate(() => { const r = document.querySelector('.row-item.is-selected'); return r && r.dataset.id; });
  await win.keyboard.press('n'); const a = await sel();
  await win.keyboard.press('n'); const b = await sel();
  assert.ok(a && b && a !== b, 'N moves on: ' + a + ' → ' + b);

  // Answer the shelf's question once: the whole show is settled.
  await win.click('.shelf:first-child .shelf-ask button:has-text("One cartoon")'); await sleep(500);
  const st = await win.evaluate(() => window.Shelf.items().filter((i) => i.kind === 'episode').map((i) => i.episode && i.episode.number));
  assert.deepStrictEqual(st.sort(), [6, 7, 9]);
  assert.match(await win.textContent('#renameBtn'), /^Rename 3$/, 'the button says how many');
  assert.match(await win.textContent('.shelf:first-child .shelf-meta'), /all ready/);

  // Read Title Cards asks first (and here we say no); while it waits, Shelf says what it's doing.
  await win.click('#autoMode'); await sleep(400);
  assert.deepStrictEqual(await app.evaluate(() => global.__prompts), ['Read the title cards of 3 videos?']);
  assert.ok(await win.isHidden('#activity'), 'nothing left “working” after saying no');
  assert.deepStrictEqual(errors, []);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  console.log('Shelves test passed');
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
