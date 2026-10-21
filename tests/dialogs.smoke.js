// End-to-end: Shelf's own permission window, and Check for Updates.
//  A. Read Title Cards opens the permission window (a separate window run by the app): Cancel and
//     Esc say no (nothing is read); the main window can't answer it; clicking the button says yes.
//  B. Updates: up to date; a newer version (notes, size) → Download & Install → checked → installer
//     started; a download that doesn't match its fingerprint is refused and deleted.
// Run with: xvfb-run -a node tests/dialogs.smoke.js   (SHOTS=dir saves screenshots)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = require('./fixtures/cartoons.json');
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: path.join(process.env.SHOTS, name + '.png') }) : null);

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-dialogs-'));
  const dir = path.join(tmp, 'Downloads', 'SpongeBob', 'Season 1'); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-title-card.mkv'), path.join(dir, 'SpongeBob.S01E06.mkv'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const exe = process.env.PACKAGED ? path.join(ROOT, 'dist/linux-unpacked/shelf') : path.join(ROOT, 'node_modules/electron/dist/electron');
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--user-data-dir=' + profile].concat(process.env.PACKAGED ? [] : [ROOT]) });
  await app.evaluate(({ dialog, nativeTheme }, a) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [a.d] }); if (a.dark) nativeTheme.themeSource = 'dark'; }, { d: path.join(tmp, 'Downloads'), dark: !!process.env.DARK });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1300, height: 820 }).catch(() => {});
  if (process.env.DARK) await win.emulateMedia({ colorScheme: 'dark' });
  const errors = []; win.on('pageerror', (e) => errors.push(String(e)));
  await win.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('api.tvmaze.com/search')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([{ score: 1, show: { id: 713, name: 'SpongeBob SquarePants', premiered: '1999-05-01', weight: 99 } }]) });
    if (u.includes('api.tvmaze.com/shows/713/episodes')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify(F.spongebob.map(([season, number, name, airdate, runtime]) => ({ season, number, name, airdate, runtime }))) });
    return route.continue();
  });
  await win.waitForLoadState();
  if (process.env.THEME) await win.evaluate((t) => window.Shelf.setTheme(t, true), process.env.THEME);
  await win.click('#menuBtn'); await win.click('#mainMenu [data-open=settings]'); await win.keyboard.press('Escape'); await sleep(200);
  await win.click('#chooseFolder');
  for (let i = 0; i < 60; i++) { await sleep(100); if (await win.evaluate(() => window.Shelf.items().length === 1 && !['pending', 'matching'].includes(window.Shelf.items()[0].status))) break; }
  await win.evaluate(() => document.querySelector('[data-id="' + window.Shelf.items()[0].id + '"]').click());
  const scanned = () => win.evaluate(() => !!window.Shelf.items()[0].cards);
  const seen = new Set();
  async function askWindow() {
    for (let i = 0; i < 50; i++) {
      const w = app.windows().find((p) => !p.isClosed() && p.url().endsWith('/consent.html') && !seen.has(p));
      if (w) { seen.add(w); if (process.env.DARK) await w.emulateMedia({ colorScheme: 'dark' }); await w.waitForSelector('body.in'); return w; }
      await sleep(100);
    }
    throw new Error('the permission window didn’t open');
  }

  // ---- A ----
  await win.click('#autoMode');
  let cw = await askWindow();
  assert.match(await cw.textContent('#cTitle'), /Read this video’s title cards\?/);
  assert.match(await cw.textContent('#cFiles'), /SpongeBob\.S01E06\.mkv/);
  assert.strictEqual(await cw.textContent('#cOk'), 'Read Title Cards');
  assert.strictEqual(await cw.$$eval('#cPoints li', (x) => x.length), 3);
  assert.ok(await win.evaluate(() => document.body.classList.contains('is-asking')), 'main window dims');
  // The main window has no way to answer it.
  assert.strictEqual(await win.evaluate(() => typeof (window.shelfNative.answer || window.shelfConsent)), 'undefined');
  const box = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ modal: w.isModal(), b: w.getContentBounds() })));
  console.log('windows:', JSON.stringify(box));
  await shot(cw, 'consent-cards'); await shot(win, 'consent-behind');
  await cw.click('#cCancel', { noWaitAfter: true }).catch(() => {}); await sleep(600);
  assert.ok(!(await scanned()), 'Cancel: nothing read');
  assert.ok(!(await win.evaluate(() => document.body.classList.contains('is-asking'))), 'main window back');
  await win.click('#autoMode');
  cw = await askWindow(); await cw.keyboard.press('Escape').catch(() => {}); await sleep(600); // (it closes on key-down)
  assert.ok(!(await scanned()), 'Esc: nothing read');
  await win.click('#autoMode');
  cw = await askWindow(); await cw.click('#cOk', { noWaitAfter: true }).catch(() => {});
  for (let i = 0; i < 300 && !(await scanned()); i++) await sleep(200);
  assert.ok(await scanned(), 'Yes: read');
  console.log('A: permission window ok');

  // Split View's permission window
  await win.click('#checkEps');
  cw = await askWindow();
  assert.match(await cw.textContent('#cTitle'), /Open this video in Check Episodes\?/);
  await shot(cw, 'consent-open');
  await cw.click('#cOk', { noWaitAfter: true }).catch(() => {}); await win.waitForSelector('#editorSheet[open]'); await win.click('#edCancel'); await sleep(300);

  // ---- B ----
  const good = Buffer.from('pretend installer ' + 'x'.repeat(300000));
  const sha = crypto.createHash('sha256').update(good).digest('hex');
  const upDir = path.join(tmp, 'update');
  await app.evaluate((ctx, a) => {
    global.__launched = [];
    const release = (version, body, sha256) => ({
      tag_name: 'v' + version, published_at: '2026-10-12T00:00:00Z', body,
      assets: [{ name: 'Shelf-Setup-' + version + '.exe', size: a.size, digest: 'sha256:' + sha256, browser_download_url: 'https://github.com/Groot36-yep/shelf/releases/download/v' + version + '/Shelf-Setup-' + version + '.exe' }]
    });
    global.__shelfUpdateTest = {
      kind: 'setup', dir: a.dir, launch: async (f) => { global.__launched.push(f); },
      release: null,
      fetch: async (url) => {
        const t = global.__shelfUpdateTest;
        if (url.includes('api.github.com')) return new Response(JSON.stringify(t.release), { status: 200, headers: { 'content-type': 'application/json' } });
        const bytes = Buffer.from(t.bad ? 'tampered' + 'y'.repeat(300000) : a.good, 'latin1');
        // Arrives in pieces, like a real download.
        let i = 0;
        return new Response(new ReadableStream({ async pull(c) { if (i >= bytes.length) { c.close(); return; } await new Promise((r) => setTimeout(r, 15)); c.enqueue(new Uint8Array(bytes.subarray(i, i + 32768))); i += 32768; } }), { status: 200 });
      }
    };
    global.__mk = release;
  }, { dir: upDir, size: good.length, good: good.toString('latin1') });
  const setRelease = (v, body, bad) => app.evaluate((ctx, a) => { global.__shelfUpdateTest.release = global.__mk(a.v, a.body, a.sha); global.__shelfUpdateTest.bad = a.bad; }, { v, body, sha, bad: !!bad });
  const version = await win.evaluate(() => window.shelfNative.version());

  await setRelease(version, '## What’s new\n- Nothing');
  await win.click('#menuBtn'); await win.click('#updatesNav'); await win.waitForSelector('#upBox[data-state=current]');
  assert.match(await win.textContent('#upTitle'), /Shelf is up to date/);
  await shot(win, 'update-current');
  await win.click('#upSecondary'); await sleep(200);

  await setRelease('9.9.9', '## What’s new\n- **Mark a title card** yourself\n- Faster scans\n  across the board\n\n## Shelf for Windows\nDownload the installer.', true);
  await win.click('#menuBtn'); await win.click('#updatesNav'); await win.waitForSelector('#upBox[data-state=available]');
  assert.match(await win.textContent('#upTitle'), /Shelf 9\.9\.9 is available/);
  assert.match(await win.textContent('#upSub'), new RegExp('You have ' + version.replace(/\./g, '\\.')));
  assert.deepStrictEqual(await win.$$eval('#upNotes li', (x) => x.map((n) => n.textContent)), ['Mark a title card yourself', 'Faster scans across the board']);
  assert.ok(!(await win.textContent('#upNotes')).includes('Download the installer'), 'only the What’s new part');
  assert.ok(await win.evaluate(() => !document.getElementById('updateDot').hidden && document.getElementById('menuBtn').classList.contains('has-update')), 'dot on the menu');
  await shot(win, 'update-available');
  await win.click('#upPrimary'); // tampered download
  await win.waitForSelector('#upBox[data-state=error]', { timeout: 20000 });
  assert.match(await win.textContent('#upSub'), /didn’t match/);
  assert.deepStrictEqual(await app.evaluate(() => global.__launched), [], 'never started');
  assert.deepStrictEqual(fs.existsSync(upDir) ? fs.readdirSync(upDir) : [], [], 'and deleted');
  await shot(win, 'update-error');

  await setRelease('9.9.9', '## What’s new\n- Faster', false);
  await win.click('#upPrimary'); await win.waitForSelector('#upBox[data-state=available]');
  await win.click('#upPrimary');
  await win.waitForSelector('#upBox[data-state=downloading]');
  await sleep(250); await shot(win, 'update-downloading');
  await win.waitForSelector('#upBox[data-state=starting]', { timeout: 20000 });
  const launched = await app.evaluate(() => global.__launched);
  assert.strictEqual(launched.length, 1, 'the installer was started');
  assert.strictEqual(fs.readFileSync(launched[0], 'utf8').slice(0, 17), 'pretend installer', 'the checked file');
  assert.deepStrictEqual(fs.readdirSync(upDir), ['Shelf-Setup-9.9.9.exe']);
  await shot(win, 'update-starting');
  console.log('B: updates ok');

  assert.deepStrictEqual(errors, []);
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  console.log('Dialogs test passed');
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
