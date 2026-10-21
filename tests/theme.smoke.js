// End-to-end: choosing a look (Studio / Living Room), and it being remembered.
// Run with: xvfb-run -a node tests/theme.smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = process.env.PACKAGED ? path.join(ROOT, 'dist/linux-unpacked/shelf') : path.join(ROOT, 'node_modules/electron/dist/electron');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  const launch = async () => {
    const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--user-data-dir=' + profile].concat(process.env.PACKAGED ? [] : [ROOT]) });
    const win = await app.firstWindow();
    const errors = [];
    win.on('pageerror', (e) => errors.push(String(e)));
    win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); // e.g. a font or picture blocked by the page's rules
    await win.waitForLoadState();
    return { app, win, errors };
  };
  let { app, win, errors } = await launch();
  const theme = () => win.evaluate(() => document.documentElement.dataset.theme);
  assert.strictEqual(await theme(), 'studio', 'Studio is the default');

  await win.click('#menuBtn'); await win.click('#mainMenu [data-open=settings]'); await sleep(300);
  assert.strictEqual(await win.getAttribute('[data-theme-pick=studio]', 'aria-checked'), 'true');
  await win.click('[data-theme-pick=seventies]'); await sleep(900);
  assert.strictEqual(await theme(), 'seventies');
  assert.strictEqual(await win.getAttribute('[data-theme-pick=seventies]', 'aria-checked'), 'true');
  await win.keyboard.press('Escape'); await sleep(200);
  assert.match(await win.evaluate(() => getComputedStyle(document.querySelector('.shows')).backgroundImage), /wood\.png/, 'walnut shows column');
  await win.evaluate(() => document.fonts.ready);
  const fonts = await win.evaluate(() => ['Fraunces', 'Nunito', 'Courier Prime'].map((f) => document.fonts.check('16px "' + f + '"')));
  assert.deepStrictEqual(fonts, [true, true, true], 'bundled fonts load');
  const looks = await win.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily, h1: getComputedStyle(document.querySelector('.wordmark')).fontFamily,
    icon: getComputedStyle(document.querySelector('.brand .app-icon')).content
  }));
  assert.match(looks.body, /Nunito/); assert.match(looks.h1, /Fraunces/); assert.match(looks.icon, /icon-70s\.svg/);
  const prefs = JSON.parse(fs.readFileSync(path.join(profile, 'shelf-prefs.json'), 'utf8'));
  assert.strictEqual(prefs.theme, 'seventies', 'the app remembers it too (window colour at start-up)');
  assert.deepStrictEqual(errors, []);
  await app.close();

  // Remembered after a restart, from the very first paint.
  ({ app, win, errors } = await launch());
  assert.strictEqual(await theme(), 'seventies', 'remembered');
  const bg = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor());
  assert.match(bg, /#E8DCC6|#17100B/i, 'window opens in the room’s colour: ' + bg);
  // Arrow keys move between looks.
  await win.click('#menuBtn'); await win.click('#mainMenu [data-open=settings]'); await sleep(300);
  await win.focus('[data-theme-pick=seventies]'); await win.keyboard.press('ArrowLeft'); await sleep(900);
  assert.strictEqual(await theme(), 'studio');
  assert.deepStrictEqual(errors, []);
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('Theme test passed');
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
