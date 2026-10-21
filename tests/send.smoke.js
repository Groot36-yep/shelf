// End-to-end: Send to Plex, against a real OpenSSH server.
//  Set up from FileZilla's saved server → check the fingerprint → log in (Shelf makes its own key and
//  forgets the password) → choose folders on the server → Rename Now also sends → files arrive, checked
//  → "already there" is skipped → a name clash asks Skip/Replace → a changed fingerprint stops
//  everything until you trust it → Forget takes the key off the server.
// Run with: xvfb-run -a node tests/send.smoke.js   (Linux, as root, with sshd. SHOTS=dir saves screenshots)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');
const sshd = require('./sshd');

if (!sshd.available()) { console.log('send smoke test skipped (needs Linux, root and sshd)'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: path.join(process.env.SHOTS, name + '.png') }) : null);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function until(fn, ms, what) {
  const end = Date.now() + (ms || 15000);
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + (what || 'something')); await sleep(100); }
}

(async () => {
  const srv = await sshd.start('shelfsend');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-send-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-'));
  let app;
  try {
    const dl = path.join(tmp, 'Downloads', 'The Office'); fs.mkdirSync(dl, { recursive: true });
    fs.writeFileSync(path.join(dl, 'The.Office.S01E01.720p.mkv'), crypto.randomBytes(6 << 20));
    fs.writeFileSync(path.join(dl, 'The.Office.S01E02.720p.mkv'), crypto.randomBytes(3 << 20));
    const library = path.join(tmp, 'Plex Library'); fs.mkdirSync(library);
    // FileZilla's saved server, as FileZilla writes it.
    const fz = path.join(tmp, 'FileZilla'); fs.mkdirSync(fz);
    fs.writeFileSync(path.join(fz, 'sitemanager.xml'), '<?xml version="1.0" encoding="UTF-8"?><FileZilla3><Servers><Server><Host>127.0.0.1</Host><Port>' + srv.port +
      '</Port><Protocol>1</Protocol><Type>0</Type><User>' + srv.user + '</User><Pass encoding="base64">' + Buffer.from(srv.pass).toString('base64') +
      '</Pass><Logontype>1</Logontype><Name>Plex Box</Name></Server></Servers></FileZilla3>');

    const exe = process.env.PACKAGED ? path.join(ROOT, 'dist/linux-unpacked/shelf') : path.join(ROOT, 'node_modules/electron/dist/electron');
    app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--user-data-dir=' + profile].concat(process.env.PACKAGED ? [] : [ROOT]) });
    await app.evaluate(({ dialog, nativeTheme }, a) => {
      dialog.showOpenDialog = async (w, o) => ({ canceled: false, filePaths: [/library/i.test((o || w || {}).title || '') ? a.lib : a.dl] });
      global.__shelfFileZillaDir = a.fz;
      if (a.dark) nativeTheme.themeSource = 'dark';
    }, { dl: path.join(tmp, 'Downloads'), lib: library, fz, dark: !!process.env.DARK });
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1300, height: 820 }).catch(() => {});
    if (process.env.DARK) await win.emulateMedia({ colorScheme: 'dark' });
    const errors = []; win.on('pageerror', (e) => errors.push(String(e)));
    await win.route('**/*', (route) => {
      const u = route.request().url();
      if (u.includes('api.tvmaze.com/search')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([{ score: 1, show: { id: 526, name: 'The Office', premiered: '2005-03-24', weight: 99 } }]) });
      if (u.includes('api.tvmaze.com/shows/526/episodes')) return route.fulfill({ status: 200, headers: H, body: JSON.stringify([[1, 1, 'Pilot'], [1, 2, 'Diversity Day'], [1, 3, 'Health Care']].map(([season, number, name]) => ({ season, number, name, airdate: '2005-03-24', runtime: 22 }))) });
      if (u.includes('tvmaze.com') || u.includes('themoviedb')) return route.fulfill({ status: 200, headers: H, body: '[]' });
      return route.continue();
    });
    await win.waitForLoadState();
    if (process.env.THEME) await win.evaluate((t) => window.Shelf.setTheme(t, true), process.env.THEME);
    const step = () => win.evaluate(() => document.getElementById('svBox').dataset.step);
    const visible = (sel) => win.isVisible(sel);

    // Before setup: the button is there, and leads to setup.
    assert.ok(await visible('#sendBtn'), 'Send to Plex is always in the toolbar');
    assert.strictEqual(await win.textContent('#serverName'), 'Not set up');
    await win.click('#chooseFolder');
    await until(() => win.evaluate(() => window.Shelf.items().length === 2 && window.Shelf.items().every((i) => i.status !== 'pending' && i.status !== 'matching')), 15000, 'matching');
    await win.click('#sendBtn');
    await until(() => win.evaluate(() => document.getElementById('serverSheet').open), 5000, 'setup to open');

    // 1. From FileZilla, one click.
    await win.waitForSelector('#fzList .fz-item');
    assert.match(await win.textContent('#fzList'), new RegExp('Plex Box.*' + srv.user + '@127\\.0\\.0\\.1:' + srv.port + '.*password saved'));
    await shot(win, 'sv-1-find');
    await win.click('#fzList .fz-item');
    await until(async () => (await step()) === 'trust', 10000, 'the fingerprint step');
    assert.strictEqual(await win.textContent('#fpValue'), srv.fp, 'shows the real fingerprint');
    assert.ok(!/Accepted|Failed password/.test(srv.log), 'no password sent before you said yes');
    await shot(win, 'sv-2-trust');
    await win.click('#svNext');
    assert.strictEqual(await step(), 'login');
    assert.ok(await visible('#svFzPass') && !(await visible('#svPassRow')), 'uses FileZilla’s saved password');
    assert.strictEqual(await win.inputValue('#svUser'), srv.user);
    assert.ok(await win.isChecked('#svUseKey'), 'the key is the default');
    await shot(win, 'sv-3-login');
    await win.click('#svNext');
    await until(async () => (await step()) === 'ready', 20000, 'logging in');
    assert.match(await win.textContent('#svNote'), /secure key and forgot your password/);
    assert.match(await win.textContent('#svHow'), /Shelf’s own key/);
    // What's on disk: no password; the key is encrypted (or kept in memory where it can't be).
    assert.ok(!fs.existsSync(path.join(profile, 'server-pass.bin')), 'password not kept');
    const keyFile = path.join(profile, 'server-key.bin');
    if (fs.existsSync(keyFile)) assert.ok(!/PRIVATE KEY/.test(fs.readFileSync(keyFile, 'latin1')), 'key is encrypted');
    const prefs = JSON.parse(fs.readFileSync(path.join(profile, 'shelf-prefs.json'), 'utf8'));
    assert.strictEqual(prefs.server.auth, 'key'); assert.strictEqual(prefs.server.fingerprint, srv.fp);
    assert.ok(!JSON.stringify(prefs).includes(srv.pass), 'password nowhere in settings');
    assert.match(srv.authorizedKeys(), /^ssh-ed25519 \S+ shelf@/m);
    await shot(win, 'sv-4-ready');

    // 2. Folders on the server.
    async function pickFolder(kind, names) {
      await win.click('[data-pick=' + kind + ']');
      for (const n of names) {
        await until(() => win.evaluate((n) => [...document.querySelectorAll('#brList .br-name')].some((b) => b.textContent === n), n), 8000, 'folder ' + n);
        await win.evaluate((n) => [...document.querySelectorAll('#brList .br-item')].find((b) => b.querySelector('.br-name').textContent === n).click(), n);
        await until(() => win.evaluate((n) => document.getElementById('brPath').textContent.endsWith('/' + n) && document.getElementById('svBusy').hidden, n), 8000, 'opening ' + n);
      }
      assert.match(await win.textContent('#brWritable'), /You can save files here/);
      if (kind === 'tv') await shot(win, 'sv-5-browse');
      await win.click('#svNext');
      await until(async () => (await step()) === 'ready', 8000, 'saving the folder');
    }
    await pickFolder('movies', ['media', 'Movies']);
    await pickFolder('tv', ['media', 'TV Shows']);
    assert.strictEqual(await win.textContent('#svMovies'), srv.media + '/Movies');
    assert.strictEqual(await win.textContent('#svTv'), srv.media + '/TV Shows');
    await win.click('#optAutoSend');
    await sleep(200);
    await shot(win, 'sv-6-ready-folders');
    await win.click('#svNext');
    assert.strictEqual(await win.textContent('#serverNote'), 'Ready');

    // 3. Rename Now also sends.
    await win.click('#renameBtn');
    await win.click('#pickLib');
    await sleep(300);
    assert.ok(await visible('#renameSendRow'));
    assert.ok(await win.isChecked('#renameSend'), 'follows "Send after renaming"');
    await shot(win, 'send-1-rename');
    await win.click('#renameNow');
    await until(() => win.evaluate(() => !document.getElementById('sendTray').hidden), 8000, 'the tray');
    await shot(win, 'send-2-sending');
    await until(async () => (await win.textContent('#sendTitle')) === 'Sent to Plex', 30000, 'sending to finish');
    assert.match(await win.textContent('#sendDetail'), /2 sent/);
    await shot(win, 'send-3-sent');
    const season = path.join(srv.media, 'TV Shows', 'The Office', 'Season 01');
    await until(() => fs.existsSync(season) && fs.readdirSync(season).filter((f) => !f.startsWith('.')).length === 2, 5000, 'files on the server');
    const remoteNames = fs.readdirSync(season).sort();
    assert.deepStrictEqual(remoteNames.map((n) => n.replace(/ \{.*\}/, '')), ['The Office - S01E01 - Pilot.mkv', 'The Office - S01E02 - Diversity Day.mkv']);
    const localSeason = path.join(library, 'TV Shows', fs.readdirSync(path.join(library, 'TV Shows'))[0], 'Season 01');
    for (const n of remoteNames) assert.strictEqual(sha(path.join(season, n)), sha(path.join(localSeason, n)), n + ' arrived identical');
    assert.strictEqual(await win.evaluate(() => [...document.querySelectorAll('.known.done')].filter((n) => n.textContent === 'On Plex').length), 2, 'rows say On Plex');
    assert.strictEqual(await win.evaluate(() => document.getElementById('sendCount').hidden), true, 'nothing left to send');

    // 4. Everything in the library: all there already.
    await win.click('#sendBtn');
    await until(() => win.evaluate(() => /Already on your server/.test(document.getElementById('sdFacts').textContent)), 10000, 'the plan');
    assert.match(await win.textContent('#sdFacts'), /Already on your server2 \(skipped\)/);
    assert.ok(await win.isDisabled('#sdGo'));
    assert.ok(await win.isDisabled('#sdScope [data-scope=renamed]'));
    await shot(win, 'send-4-all-there');
    await win.keyboard.press('Escape');

    // 5. A different file with the same name on the server: you choose.
    const upLocal = path.join(library, 'Movies', 'Up (2009)'); fs.mkdirSync(upLocal, { recursive: true });
    fs.writeFileSync(path.join(upLocal, 'Up (2009).mkv'), crypto.randomBytes(2 << 20));
    const upRemote = path.join(srv.media, 'Movies', 'Up (2009)'); fs.mkdirSync(upRemote, { recursive: true });
    fs.writeFileSync(path.join(upRemote, 'Up (2009).mkv'), 'an older copy');
    require('child_process').execFileSync('chown', ['-R', srv.user, upRemote]);
    await win.click('#sendBtn');
    await until(() => win.evaluate(() => !document.getElementById('sdConflict').hidden), 10000, 'the clash');
    assert.match(await win.textContent('#sdConflictText'), /1 file has the same name as a different file already on your server \(for example “Up \(2009\)\.mkv”\)/);
    assert.ok(await win.isDisabled('#sdGo'), 'skipping is the default, so nothing to send');
    await win.click('#sdReplace [data-replace="1"]');
    await until(async () => (await win.textContent('#sdGo')) === 'Send 1 File', 8000, 'replace');
    await shot(win, 'send-5-clash');
    await win.click('#sdGo');
    await until(async () => (await win.textContent('#sendTitle')) === 'Sent to Plex' && /1 sent/.test(await win.textContent('#sendDetail')), 20000, 'replacing');
    assert.strictEqual(sha(path.join(upRemote, 'Up (2009).mkv')), sha(path.join(upLocal, 'Up (2009).mkv')));

    // 6. The server's fingerprint changes: nothing is sent until you trust the new one.
    await srv.rekey();
    fs.writeFileSync(path.join(upLocal, 'Up (2009).en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
    await win.click('#sendBtn');
    await until(() => win.evaluate(() => !document.getElementById('sdWarn').hidden), 15000, 'the warning');
    assert.match(await win.textContent('#sdWarn'), /fingerprint has changed.*sent nothing/);
    await shot(win, 'send-6-changed');
    await win.click('#sdServer');
    await until(async () => (await step()) === 'trust', 10000, 'the recheck');
    assert.match(await win.textContent('#svTitle'), /Is this your server/);
    assert.ok(await win.evaluate(() => document.getElementById('fpCard').classList.contains('changed')));
    assert.strictEqual(await win.textContent('#fpValue'), srv.fp);
    assert.strictEqual(await win.textContent('#svNext'), 'Trust the New Fingerprint');
    await shot(win, 'sv-7-changed');
    await win.click('#svNext');
    await until(async () => (await step()) === 'ready', 8000, 'trusting');
    await win.click('#svNext');
    await win.click('#sendBtn');
    await until(async () => (await win.textContent('#sdGo')) === 'Send 1 File', 10000, 'the plan after trusting');
    await win.click('#sdGo');
    await until(() => fs.existsSync(path.join(upRemote, 'Up (2009).en.srt')), 15000, 'the subtitle to arrive');

    // 7. Forget: the key comes off the server too.
    await win.click('#serverStatus');
    await until(async () => (await step()) === 'ready', 5000);
    await win.click('#svForget');
    assert.strictEqual(await step(), 'forget');
    await shot(win, 'sv-8-forget');
    await win.click('#svNext');
    await until(async () => (await step()) === 'find', 10000, 'forgetting');
    assert.ok(!/shelf@/.test(srv.authorizedKeys()), 'key removed from the server');
    assert.ok(!fs.existsSync(keyFile));
    assert.ok(!JSON.parse(fs.readFileSync(path.join(profile, 'shelf-prefs.json'), 'utf8')).server);
    assert.strictEqual(await win.textContent('#serverName'), 'Not set up');
    assert.deepStrictEqual(errors, []);
    console.log('send smoke test passed');
  } catch (e) {
    try {
      const w = app && app.windows()[0];
      if (w) {
        console.log('state:', JSON.stringify(await w.evaluate(() => ({ step: document.getElementById('svBox').dataset.step, error: document.getElementById('svError').textContent, warn: document.getElementById('sdWarn').textContent, tray: document.getElementById('sendTitle').textContent + ' / ' + document.getElementById('sendDetail').textContent }))));
        if (process.env.SHOTS) await w.screenshot({ path: path.join(process.env.SHOTS, 'failed.png') });
        try { console.log(fs.readFileSync(path.join(profile, 'startup.log'), 'utf8').split('\n').filter((l) => /Send to Plex|ERROR|Key setup|Plex scan/.test(l)).join('\n')); } catch (x) {}
      }
    } catch (x) { /* best effort */ }
    throw e;
  } finally {
    if (app) await app.close().catch(() => {});
    srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAIL', e.stack || e); process.exit(1); });
