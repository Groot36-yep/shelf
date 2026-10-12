// The Send to Plex queue, against a real OpenSSH server: several files (each one checked while the next
// is sent), Stop and pick up where it stopped, a damaged copy sent again by itself, and freeing up space.
// Needs Linux, root and sshd (skipped elsewhere). Run: node tests/plexsend.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const sshd = require('./sshd');
if (!sshd.available()) { console.log('Send to Plex queue checks skipped (needs Linux, root and sshd)'); process.exit(0); }
const S = require('../desktop/server');
const plexsend = require('../desktop/plexsend');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = await sshd.start('shelfqueue');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-queue-'));
  const lib = path.join(tmp, 'Library');
  let prefs = { library: lib };
  const handlers = {}, events = [], trashed = [];
  const api = plexsend.setup({
    handle: (ch, fn) => { handlers[ch] = fn; },
    app: { getPath: () => path.join(tmp, 'userData') },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from('ENC' + Buffer.from(t).toString('base64')), decryptString: (b) => Buffer.from(b.toString().slice(3), 'base64').toString() },
    shell: { trashItem: async (f) => { trashed.push(f); fs.rmSync(f); } },
    readPrefs: () => JSON.parse(JSON.stringify(prefs)), writePrefs: (p) => { prefs = p; },
    log: () => {}, send: (m) => events.push(m),
    tidyDirs: async () => {}
  });
  const call = (ch, ...a) => handlers[ch](...a);
  const ended = async (n0) => { for (let i = 0; i < 1200; i++) { if (events.slice(n0).some((e) => e.kind === 'end')) return events.slice(n0); await sleep(100); } throw new Error('the send never ended'); };
  let passed = 0;
  const ok = (m) => { passed++; console.log('  ✓ ' + m); };
  try {
    // Set up, as the window would.
    const probe = await call('shelf:serverProbe', '127.0.0.1', srv.port);
    assert.strictEqual(probe.fingerprint, srv.fp);
    const st = await call('shelf:serverLogin', { user: srv.user, password: srv.pass, trust: probe.fingerprint });
    assert.strictEqual(st.auth, 'key');
    assert.ok(!JSON.stringify(prefs).includes(srv.pass));
    await call('shelf:serverFolder', 'tv', srv.media + '/TV Shows');
    await call('shelf:serverFolder', 'movies', srv.media + '/Movies');
    await assert.rejects(call('shelf:serverFolder', 'tv', '/etc'), /\[FOLDER\]/);
    ok('set up with a key, folders chosen, a folder you can’t save in is refused');

    // Only library files, never anything else.
    const season = path.join(lib, 'TV Shows', 'Show', 'Season 01'); fs.mkdirSync(season, { recursive: true });
    for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(season, 'Show - S01E0' + i + '.mkv'), crypto.randomBytes(24 << 20));
    fs.writeFileSync(path.join(season, 'Show - S01E01.en.srt'), 'subs');
    fs.writeFileSync(path.join(season, 'notes.txt'), 'not a video');
    fs.writeFileSync(path.join(tmp, 'secret.mkv'), 'outside the library');
    fs.symlinkSync(path.join(tmp, 'secret.mkv'), path.join(season, 'link.mkv'));
    const plan = await call('shelf:sendPlan', [path.join(tmp, 'secret.mkv'), path.join(season, 'link.mkv'), path.join(season, 'Show - S01E01.mkv'), '/etc/passwd']);
    assert.strictEqual(plan.files, 1, 'only the library file counts');
    ok('only files inside the library’s Movies / TV Shows can be sent');

    // Send the whole library: 4 episodes + subtitles. Each is checked while the next is sent.
    let n0 = events.length, t0 = Date.now();
    assert.deepStrictEqual(await call('shelf:send', null, {}), { queued: 5 });
    let ev = await ended(n0);
    const secs = (Date.now() - t0) / 1000;
    const results = ev.filter((e) => e.kind === 'file').map((e) => e.result);
    assert.strictEqual(results.length, 5);
    assert.ok(results.every((r) => r.ok && r.checked === 'sha256'), JSON.stringify(results));
    const remoteSeason = path.join(srv.media, 'TV Shows', 'Show', 'Season 01');
    for (const f of fs.readdirSync(season).filter((x) => /\.(mkv|srt)$/.test(x) && x !== 'link.mkv')) assert.strictEqual(sha(path.join(remoteSeason, f)), sha(path.join(season, f)), f);
    assert.ok(!fs.readdirSync(remoteSeason).some((f) => f.startsWith('.')), 'no temporary files left');
    assert.ok(!fs.existsSync(path.join(remoteSeason, 'link.mkv')) && !fs.existsSync(path.join(remoteSeason, 'notes.txt')));
    const last = ev[ev.length - 1];
    assert.strictEqual(last.sent, 5); assert.strictEqual(last.bytesDone, last.bytesTotal);
    ok('5 files sent and each checked with SHA-256 (' + Math.round(96 / secs) + ' MB/s here, checks included)');

    // Again: nothing new.
    n0 = events.length;
    await call('shelf:send', null, {});
    ev = await ended(n0);
    assert.strictEqual(ev[ev.length - 1].skipped, 5);
    ok('sending again skips what’s already there');

    // Stop part-way, then pick up where it stopped.
    const big = path.join(lib, 'Movies', 'Big (2020)', 'Big (2020).mkv'); fs.mkdirSync(path.dirname(big), { recursive: true });
    fs.writeFileSync(big, crypto.randomBytes(160 << 20));
    n0 = events.length;
    await call('shelf:send', [big], {});
    for (let i = 0; i < 600 && !events.slice(n0).some((e) => e.bytesDone > (40 << 20)); i++) await sleep(20);
    await call('shelf:sendStop');
    ev = await ended(n0);
    assert.ok(ev[ev.length - 1].stopped);
    const plan2 = await call('shelf:sendPlan', [big]);
    assert.strictEqual(plan2.partial, 1, 'the half-sent file is noticed');
    assert.ok(plan2.bytes < (130 << 20), 'only the rest is left to send: ' + plan2.bytes);
    n0 = events.length;
    await call('shelf:send', [big], {});
    ev = await ended(n0);
    assert.ok(ev.find((e) => e.kind === 'file').result.ok);
    assert.strictEqual(sha(path.join(srv.media, 'Movies', 'Big (2020)', 'Big (2020).mkv')), sha(big));
    ok('Stop, then Send again picks up where it stopped');

    // A copy that doesn't match is sent again, by itself.
    const realConnect = S.connect;
    let spoiled = 0;
    S.connect = async (o) => { const s = await realConnect(o); const real = s.sha256.bind(s); s.sha256 = async (f) => (spoiled++ === 0 ? '0'.repeat(64) : real(f)); return s; };
    api.close(); // a fresh connection, so the spoiled checksum is used
    const ep5 = path.join(season, 'Show - S01E05.mkv'); fs.writeFileSync(ep5, crypto.randomBytes(5 << 20));
    n0 = events.length;
    await call('shelf:send', [ep5], {});
    ev = await ended(n0);
    S.connect = realConnect;
    const r5 = ev.filter((e) => e.kind === 'file').map((e) => e.result);
    assert.strictEqual(r5.length, 1); assert.ok(r5[0].ok && r5[0].checked === 'sha256', JSON.stringify(r5));
    assert.strictEqual(sha(path.join(remoteSeason, 'Show - S01E05.mkv')), sha(ep5));
    ok('a copy that didn’t match was removed and sent again automatically');

    // Free up space: only after the checksum matched.
    await call('shelf:serverOptions', { tidy: true });
    const ep6 = path.join(season, 'Show - S01E06.mkv'); fs.writeFileSync(ep6, crypto.randomBytes(1 << 20));
    const ep6sum = sha(ep6);
    n0 = events.length;
    await call('shelf:send', [ep6], {});
    ev = await ended(n0);
    assert.ok(ev.find((e) => e.kind === 'file').result.tidied);
    assert.ok(!fs.existsSync(ep6) && trashed.includes(ep6));
    assert.strictEqual(sha(path.join(remoteSeason, 'Show - S01E06.mkv')), ep6sum);
    ok('“Free up space” moves a file to the Recycle Bin only once it’s on the server and checked');

    // FileZilla with a key file instead of a password: one click works too.
    const { execFileSync } = require('child_process');
    const kf = path.join(tmp, 'fz_key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'filezilla', '-f', kf]);
    fs.appendFileSync(path.join(srv.home, '.ssh', 'authorized_keys'), fs.readFileSync(kf + '.pub'));
    const fzDir = path.join(tmp, 'FileZilla'); fs.mkdirSync(fzDir);
    fs.writeFileSync(path.join(fzDir, 'sitemanager.xml'), '<FileZilla3><Servers><Server><Host>127.0.0.1</Host><Port>' + srv.port + '</Port><Protocol>1</Protocol><Logontype>5</Logontype><User>' + srv.user + '</User><Keyfile>' + kf + '</Keyfile><Name>Box</Name></Server></Servers></FileZilla3>');
    global.__shelfFileZillaDir = fzDir;
    await call('shelf:serverForget', true);
    const fzl = await call('shelf:serverFileZilla');
    assert.deepStrictEqual(fzl.map((x) => [x.name, x.hasPassword, x.hasKey]), [['Box', false, true]]);
    const p2 = await call('shelf:serverProbe', '127.0.0.1', srv.port);
    const st2 = await call('shelf:serverLogin', { fz: 0, trust: p2.fingerprint });
    assert.strictEqual(st2.auth, 'key');
    assert.match(srv.authorizedKeys(), /shelf@/);
    assert.ok(!JSON.stringify(prefs).includes(fs.readFileSync(kf, 'utf8').split('\n')[1]), 'FileZilla’s key isn’t copied anywhere');
    ok('FileZilla’s key-file login works in one click, and Shelf then uses its own key');

    // Forget: everything secret is gone from this PC, and the key from the server.
    const r = await call('shelf:serverForget', true);
    assert.strictEqual(r.removed, true);
    assert.ok(!/shelf@/.test(srv.authorizedKeys()));
    assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'userData')).filter((f) => /server|plex/.test(f)), []);
    assert.ok(!prefs.server);
    ok('Forget removes the key from the server and every secret from this PC');
    console.log(passed + ' Send to Plex queue checks passed');
  } finally {
    api.close();
    srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e); process.exit(1); });
