// End-to-end: the Settings window (pages, search, the names preview, key states) and the app icon styles.
// Run with: xvfb-run -a node tests/settings.smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = path.join(ROOT, 'node_modules/electron/dist/electron');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const lnkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-lnk-'));
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--user-data-dir=' + profile, ROOT] });
  // Windows only: a shortcut of our own (to this Electron) and one to something else, standing in for Shelf's.
  const win32 = process.platform === 'win32';
  const links = win32 ? await app.evaluate(({ shell }, d) => {
    const p = process.mainModule.require('path');
    const mine = p.join(d, 'Shelf.lnk'), other = p.join(d, 'Other.lnk');
    shell.writeShortcutLink(mine, 'create', { target: process.execPath });
    shell.writeShortcutLink(other, 'create', { target: p.join(process.env.SystemRoot || 'C:\\Windows', 'notepad.exe') });
    global.__shelfShortcutLinks = [mine, other];
    return { mine, other };
  }, lnkDir) : null;
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.waitForLoadState();
  const visible = (sel) => win.evaluate((s) => { const n = document.querySelector(s); return !!n && !!n.offsetParent; }, sel);

  // Pages: one at a time, Look first; Ctrl+, opens it too.
  await win.click('#menuBtn'); await win.click('#mainMenu [data-open=settings]'); await sleep(300);
  assert.ok(await visible('#themePicker') && !(await visible('#keyInput')), 'Look page first');
  await win.click('#setTabs [data-page=keys]');
  assert.ok(await visible('#keyInput') && !(await visible('#themePicker')), 'Keys page');
  assert.match(await win.textContent('#tmdbState'), /Not added/);
  assert.ok(await visible('#keysDot'), 'the Keys tab says a key is missing');
  await win.fill('#keyInput', 'tmdb-key'); await win.dispatchEvent('#keyInput', 'change'); await sleep(100);
  assert.match(await win.textContent('#tmdbState'), /^Added/);
  assert.ok(!(await visible('#keysDot')));
  // Arrow keys move between pages.
  await win.focus('#setTabs [data-page=keys]'); await win.keyboard.press('ArrowDown');
  assert.ok(await visible('#optGpu'), 'Speed page after Keys');
  console.log('  ✓ pages, key states, arrow keys');

  // Search: across pages, switch by switch.
  await win.fill('#setSearch', 'year'); await sleep(100);
  const found = await win.evaluate(() => [...document.querySelectorAll('#setBody .row')].filter((n) => n.offsetParent).map((n) => n.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)));
  assert.ok(found.some((t) => /year to show names/.test(t)) && found.some((t) => /year to album folders/.test(t)), JSON.stringify(found));
  assert.ok(!found.some((t) => /show’s number/.test(t)), 'only the matching switches');
  await win.fill('#setSearch', 'zzzz'); await sleep(100);
  assert.ok(await visible('#setNone'));
  await win.fill('#setSearch', 'acoustid'); await sleep(100);
  assert.ok(await visible('#acoustInput'));
  await win.fill('#setSearch', ''); await win.dispatchEvent('#setSearch', 'input'); await sleep(100);
  console.log('  ✓ search');

  // File names: the preview follows the switches.
  await win.click('#setTabs [data-page=names]');
  assert.match(await win.textContent('#npTv'), /Doctor Who \{tmdb-57243\} \/ Season 01 \/ Doctor Who - S01E01 - Rose\.mkv/);
  assert.doesNotMatch(await win.textContent('#npMovie'), /tmdb-4808/);
  await win.check('#optIds'); await win.check('#optShowYear'); await win.uncheck('#optMusicYear');
  assert.match(await win.textContent('#npMovie'), /Charade \(1963\) \{tmdb-4808\}\.mkv/);
  assert.match(await win.textContent('#npTv'), /Doctor Who \(2005\) \{tmdb-57243\}/);
  assert.match(await win.textContent('#npSong'), /ABBA \/ Gold - Greatest Hits \/ 01 - Dancing Queen\.flac/);
  assert.strictEqual(await win.evaluate(() => document.querySelectorAll('#npMovie mark').length), 2, 'folder and file');
  console.log('  ✓ names preview');

  // TV: a missing key is said where the order is chosen, with a way there.
  await win.click('#setTabs [data-page=tv]');
  await win.selectOption('#optOrder', 'tvdb'); await sleep(100);
  assert.match(await win.textContent('#orderNeedText'), /TheTVDB key/);
  await win.click('#orderNeed [data-goto=keys]');
  assert.ok(await visible('#tvdbInput'));
  await win.click('#setTabs [data-page=tv]'); await win.selectOption('#optOrder', 'tmdb');

  // The app icon: the picture in Shelf changes, and the window, Windows' icon file and our shortcut follow.
  await win.click('#setTabs [data-page=look]');
  assert.strictEqual(await win.getAttribute('[data-icon-pick=auto]', 'aria-checked'), 'true');
  assert.strictEqual(await win.evaluate(() => document.documentElement.dataset.icon), 'amber');
  await win.click('[data-icon-pick=sage]'); await sleep(1500);
  assert.strictEqual(await win.evaluate(() => document.documentElement.dataset.icon), 'sage');
  assert.match(await win.evaluate(() => getComputedStyle(document.querySelector('.brand .app-icon')).content), /icons\/sage\.svg/);
  const prefs = JSON.parse(fs.readFileSync(path.join(profile, 'shelf-prefs.json'), 'utf8'));
  assert.strictEqual(prefs.appIcon, 'sage'); assert.strictEqual(prefs.appIconUsed, 'sage');
  const ico = fs.readFileSync(path.join(profile, 'app-icon-sage.ico'));
  assert.strictEqual(ico.readUInt16LE(4), 6, 'six sizes in the .ico');
  // The 256 px picture is really the sage icon (green, not blank): look at a pixel in the background.
  const px = await app.evaluate(({ nativeImage }, f) => { const im = nativeImage.createFromPath(f); const b = im.toBitmap(); const s = im.getSize(); const i = (40 * s.width + 128) * 4; return { w: s.width, b: b[i], g: b[i + 1], r: b[i + 2], a: b[i + 3] }; }, path.join(profile, 'app-icon-sage.png'));
  assert.strictEqual(px.w, 256); assert.ok(px.a > 200 && px.g > px.r && px.g > px.b, 'green: ' + JSON.stringify(px));
  if (win32) {
    const read = () => app.evaluate(({ shell }, l) => ({ mine: shell.readShortcutLink(l.mine), other: shell.readShortcutLink(l.other) }), links);
    let s = await read();
    assert.match(s.mine.icon, /app-icon-sage\.ico$/, 'our shortcut has the new icon');
    assert.ok(!/app-icon/.test(s.other.icon || ''), 'someone else’s shortcut is left alone');
    assert.match(await win.textContent('#iconHelp'), /shortcuts use it now/);
    await win.click('[data-icon-pick=amber]'); await sleep(1500);
    s = await read();
    assert.ok(!/app-icon/.test(s.mine.icon || ''), 'Amber puts Shelf’s own icon back: ' + s.mine.icon);
    console.log('  ✓ app icon: window, .ico, shortcuts');
  } else console.log('  ✓ app icon: window and .ico (shortcuts are Windows only)');
  // Automatic follows the look.
  await win.click('[data-icon-pick=auto]'); await sleep(300);
  await win.click('[data-theme-pick=seventies]'); await sleep(1500);
  assert.strictEqual(await win.evaluate(() => document.documentElement.dataset.icon), 'walnut');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(profile, 'shelf-prefs.json'), 'utf8')).appIconUsed, 'walnut');
  console.log('  ✓ automatic icon follows the look');

  // Erasing everything forgets the icon too.
  await win.keyboard.press('Escape'); await sleep(200);

  await win.evaluate(() => document.getElementById('eraseAll').click()); await sleep(800);
  assert.ok(!fs.readdirSync(profile).some((f) => /^app-icon-/.test(f)), 'icon files erased');

  assert.deepStrictEqual(errors, []);
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(lnkDir, { recursive: true, force: true });
  console.log('Settings test passed');
})().catch((e) => { console.error(e); process.exit(1); });
