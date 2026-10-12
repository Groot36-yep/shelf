/*
 * Send to Plex: checks against a real OpenSSH server (started just for this test).
 * Needs Linux, root and sshd; skipped elsewhere (the pure checks at the top always run).
 * Run: node tests/server.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const S = require('../desktop/server');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- Pure checks (every platform) ----
test('files go only into the folder you chose for their kind', () => {
  const roots = { movies: '/srv/media/Movies', tv: '/srv/media/TV/' };
  assert.strictEqual(S.remoteFor('Movies/Up (2009)/Up (2009).mkv', roots), '/srv/media/Movies/Up (2009)/Up (2009).mkv');
  assert.strictEqual(S.remoteFor('TV Shows\\Lost\\Season 01\\Lost - s01e01.mkv', roots), '/srv/media/TV/Lost/Season 01/Lost - s01e01.mkv');
  assert.strictEqual(S.remoteFor('TV Shows/../../etc/passwd', roots), null);
  assert.strictEqual(S.remoteFor('TV Shows/Lost/../../../x', roots), null);
  assert.strictEqual(S.remoteFor('Other/x.mkv', roots), null);
  assert.strictEqual(S.remoteFor('Movies/x.mkv', { movies: 'relative/path' }), null);
  assert.strictEqual(S.remoteFor('Movies/a\nb.mkv', roots), null);
  assert.strictEqual(S.remoteFor('Movies', roots), null);
});
test('FileZilla: only SFTP servers are offered, passwords decoded, duplicates dropped', () => {
  const xml = '<FileZilla3><Servers><Folder><Server><Host>192.168.1.20</Host><Port>22</Port><Protocol>1</Protocol><User>sam</User>' +
    '<Pass encoding="base64">' + Buffer.from('p&ss<word>').toString('base64') + '</Pass><Name>Plex &amp; Stuff</Name></Server></Folder>' +
    '<Server><Host>192.168.1.20</Host><Port>22</Port><Protocol>1</Protocol><User>sam</User></Server>' +
    '<Server><Host>ftp.example.com</Host><Port>21</Port><Protocol>0</Protocol><User>x</User><Pass encoding="base64">eHg=</Pass></Server>' +
    '<Server><Host>nas</Host><Port>2200</Port><Protocol>1</Protocol><User>me</User><Pass encoding="crypt" pubkey="abc">zzz</Pass></Server></Servers></FileZilla3>';
  const list = S.parseFileZilla(xml);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list[0], { name: 'Plex & Stuff', host: '192.168.1.20', port: 22, user: 'sam', password: 'p&ss<word>', keyfile: '' });
  assert.deepStrictEqual(list[1], { name: 'nas', host: 'nas', port: 2200, user: 'me', password: '', keyfile: '' }); // master-password protected: not read
  const k = S.parseFileZilla('<Server><Host>box</Host><Port>22</Port><Protocol>1</Protocol><Logontype>5</Logontype><User>u</User><Keyfile>C:\\Users\\u\\.ssh\\id_ed25519</Keyfile></Server>');
  assert.strictEqual(k[0].keyfile, 'C:\\Users\\u\\.ssh\\id_ed25519');
});
test('Shelf’s own problems keep their meaning (so dropped connections and bad copies are retried)', () => {
  for (const code of ['LOST', 'BAD_COPY', 'CONFLICT', 'HOST_CHANGED', 'NO_PLEX', 'FOLDER']) assert.strictEqual(S.friendly(S.problem(code, 'x')).code, code);
  assert.strictEqual(S.friendly(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'h').code, 'UNREACHABLE');
  assert.strictEqual(S.friendly(new Error('All configured authentication methods failed')).code, 'AUTH');
});
test('quoting for the server’s shell survives apostrophes and dollar signs', () => {
  assert.strictEqual(S.quote("Bob's $HOME `x`"), "'Bob'\\''s $HOME `x`'");
});

// ---- Real server ----
const canRun = process.platform === 'linux' && process.getuid && process.getuid() === 0 && fs.existsSync('/usr/sbin/sshd');
const USER = 'shelftest', PASS = 'Popcorn-' + crypto.randomBytes(4).toString('hex');
const PORT = 22000 + Math.floor(Math.random() * 1000);
let sshd, tmp, hostFp, media, log = '';
const opts = (o) => Object.assign({ host: '127.0.0.1', port: PORT, username: USER }, o);

function setup() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sshd-'));
  try { execFileSync('id', [USER], { stdio: 'ignore' }); } catch (e) { execFileSync('useradd', ['-m', '-s', '/bin/bash', USER]); }
  execFileSync('chpasswd', { input: USER + ':' + PASS + '\n' });
  const home = '/home/' + USER;
  fs.rmSync(path.join(home, '.ssh'), { recursive: true, force: true });
  media = path.join(home, 'media');
  fs.rmSync(media, { recursive: true, force: true });
  fs.mkdirSync(path.join(media, 'Movies'), { recursive: true }); fs.mkdirSync(path.join(media, 'TV'), { recursive: true });
  execFileSync('chown', ['-R', USER, media]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(tmp, 'host')]);
  hostFp = execFileSync('ssh-keygen', ['-lf', path.join(tmp, 'host.pub')]).toString().split(' ')[1];
  fs.mkdirSync('/run/sshd', { recursive: true });
  fs.writeFileSync(path.join(tmp, 'cfg'), ['Port ' + PORT, 'ListenAddress 127.0.0.1', 'HostKey ' + path.join(tmp, 'host'), 'PasswordAuthentication yes',
    'KbdInteractiveAuthentication no', 'UsePAM yes', 'PidFile ' + path.join(tmp, 'pid'), 'Subsystem sftp internal-sftp', 'AllowUsers ' + USER, 'LogLevel VERBOSE'].join('\n') + '\n');
  sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(tmp, 'cfg')], { stdio: ['ignore', 'ignore', 'pipe'] });
  sshd.stderr.on('data', (d) => { log += d; });
  return new Promise((r) => setTimeout(r, 700));
}
async function randomFile(name, size) {
  const f = path.join(tmp, name);
  const fh = await fs.promises.open(f, 'w');
  for (let left = size; left > 0;) { const n = Math.min(left, 4 << 20); await fh.write(crypto.randomBytes(n)); left -= n; }
  await fh.close();
  return f;
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

if (canRun) {
  test('first contact: Shelf learns the fingerprint and sends no password', async () => {
    const before = log.length;
    await assert.rejects(S.connect(opts({ password: PASS, probe: true })), (e) => e.code === 'HOST_UNKNOWN' && e.fingerprint === hostFp && e.keyType === 'ED25519');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!/Accepted|Failed password|Postponed/.test(log.slice(before)), 'nothing was sent to log in');
  });
  test('a different fingerprint stops Shelf before it sends your password', async () => {
    const before = log.length;
    await assert.rejects(S.connect(opts({ password: PASS, pinned: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })), (e) => e.code === 'HOST_CHANGED' && e.fingerprint === hostFp);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!/Accepted|Failed password|Postponed/.test(log.slice(before)), 'no password went out');
  });
  test('wrong password is explained in plain words', async () => {
    await assert.rejects(S.connect(opts({ password: 'nope', pinned: hostFp })), (e) => e.code === 'AUTH');
  });
  test('nothing listening: "couldn’t reach"', async () => {
    await assert.rejects(S.connect({ host: '127.0.0.1', port: PORT + 1, username: USER, password: PASS, pinned: hostFp }), (e) => e.code === 'UNREACHABLE');
  });
  let key;
  test('password works, folders list, and Shelf can tell where it may save', async () => {
    const s = await S.connect(opts({ password: PASS, pinned: hostFp }));
    try {
      assert.strictEqual(await s.home(), '/home/' + USER);
      assert.deepStrictEqual(await s.list('/home/' + USER + '/media'), ['Movies', 'TV']);
      assert.strictEqual(await s.writable(media + '/Movies'), true);
      assert.strictEqual(await s.writable('/etc'), false);
      assert.ok((await s.free(media)) > 1e6);
      key = S.makeKey('shelf@test');
      assert.strictEqual(await S.installKey(s, key.public), true);
      assert.strictEqual(await S.installKey(s, key.public), false, 'not added twice');
    } finally { s.close(); }
    const st = fs.statSync('/home/' + USER + '/.ssh'), ak = fs.statSync('/home/' + USER + '/.ssh/authorized_keys');
    assert.strictEqual(st.mode & 0o777, 0o700); assert.strictEqual(ak.mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync('/home/' + USER + '/.ssh/authorized_keys').uid, Number(execFileSync('id', ['-u', USER]).toString()));
  });
  test('Shelf’s own key logs in without the password', async () => {
    const s = await S.connect(opts({ privateKey: key.private, pinned: hostFp }));
    s.close();
  });
  test('a 64 MB file arrives complete, checked with SHA-256, under its real name only at the end', async () => {
    const f = await randomFile('big.mkv', 64 << 20);
    const s = await S.connect(opts({ privateKey: key.private, pinned: hostFp }));
    const remote = media + '/TV/Bob’s Show/Season 01/Bob\'s Show - s01e01 - "Pilot" $1.mkv';
    let seen = 0; const t0 = Date.now();
    try {
      const r = await s.upload(f, remote, { onBytes: (n, resumed) => { seen += n; }, verify: true });
      assert.strictEqual(r.checked, 'sha256'); assert.strictEqual(r.resumed, 0);
    } finally { s.close(); }
    const secs = (Date.now() - t0) / 1000;
    console.log('    (' + Math.round(64 / secs) + ' MB/s on this machine)');
    assert.strictEqual(seen, 64 << 20);
    assert.strictEqual(sha(remote), sha(f));
    assert.deepStrictEqual(fs.readdirSync(path.dirname(remote)), [path.basename(remote)], 'no temporary file left');
    assert.ok(fs.statSync(remote).mode & 0o004, 'Plex can read it');
  });
  test('an interrupted send picks up where it stopped', async () => {
    const f = await randomFile('resume.mkv', 24 << 20);
    const remote = media + '/Movies/Resume (2020)/Resume (2020).mkv';
    const s = await S.connect(opts({ privateKey: key.private, pinned: hostFp }));
    let sent = 0;
    try {
      await assert.rejects(s.upload(f, remote, { onBytes: (n) => { sent += n; }, stopped: () => sent > (8 << 20) }), (e) => e.code === 'STOPPED');
      const part = path.join(path.dirname(remote), '.Resume (2020).mkv.shelf-part');
      assert.ok(fs.existsSync(part) && !fs.existsSync(remote));
      const r = await s.upload(f, remote, {});
      assert.ok(r.resumed > (8 << 20) - (4 << 20), 'resumed from ' + r.resumed);
      assert.strictEqual(r.checked, 'sha256');
    } finally { s.close(); }
    assert.strictEqual(sha(remote), sha(f));
  });
  test('a damaged half-sent file is caught by the checksum and removed', async () => {
    const f = await randomFile('bad.mkv', 3 << 20);
    const remote = media + '/Movies/Bad (2020)/Bad (2020).mkv';
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    const part = path.join(path.dirname(remote), '.Bad (2020).mkv.shelf-part');
    fs.writeFileSync(part, crypto.randomBytes(1 << 20)); execFileSync('chown', ['-R', USER, path.dirname(remote)]);
    const s = await S.connect(opts({ privateKey: key.private, pinned: hostFp }));
    try {
      await assert.rejects(s.upload(f, remote, {}), (e) => e.code === 'BAD_COPY');
      assert.ok(!fs.existsSync(part) && !fs.existsSync(remote));
      const r = await s.upload(f, remote, {});
      assert.strictEqual(r.resumed, 0);
    } finally { s.close(); }
    assert.strictEqual(sha(remote), sha(f));
  });
  test('never overwrites a file on the server unless you said Replace', async () => {
    const a = await randomFile('a.mkv', 100000), b = await randomFile('b.mkv', 120000);
    const remote = media + '/Movies/Same (2020)/Same (2020).mkv';
    const s = await S.connect(opts({ privateKey: key.private, pinned: hostFp }));
    try {
      await s.upload(a, remote, {});
      await assert.rejects(s.upload(b, remote, {}), (e) => e.code === 'CONFLICT');
      assert.strictEqual(sha(remote), sha(a));
      await s.upload(b, remote, { replace: true });
      assert.strictEqual(sha(remote), sha(b));
      assert.deepStrictEqual(fs.readdirSync(path.dirname(remote)), ['Same (2020).mkv']);
    } finally { s.close(); }
  });
  test('Plex is reached through the same encrypted connection, with its own token', async () => {
    const asked = [];
    const plex = http.createServer((req, res) => {
      asked.push([req.url, req.headers['x-plex-token']]);
      if (req.headers['x-plex-token'] !== 'tok123abcXYZ') { res.statusCode = 401; return res.end(); }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/library/sections') return res.end(JSON.stringify({ MediaContainer: { Directory: [
        { key: '1', type: 'movie', title: 'Movies', Location: [{ path: media + '/Movies' }] },
        { key: '2', type: 'show', title: 'TV Shows', Location: [{ path: media + '/TV' }] },
        { key: '3', type: 'artist', title: 'Music', Location: [{ path: '/music' }] }] } }));
      res.end('{}');
    });
    await new Promise((r) => plex.listen(32400, '127.0.0.1', r));
    const prefsDir = '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server';
    const made = !fs.existsSync(prefsDir);
    fs.mkdirSync(prefsDir, { recursive: true });
    fs.writeFileSync(prefsDir + '/Preferences.xml', '<?xml version="1.0"?><Preferences MachineIdentifier="x" PlexOnlineToken="tok123abcXYZ" FriendlyName="den"/>');
    const s = await S.connect(opts({ privateKey: key.private, pinned: hostFp }));
    try {
      const token = await S.findPlexToken(s);
      assert.strictEqual(token, 'tok123abcXYZ');
      const libs = await S.plexLibraries(s, token);
      assert.deepStrictEqual(libs.map((l) => [l.kind, l.title, l.folders[0]]), [['movies', 'Movies', media + '/Movies'], ['tv', 'TV Shows', media + '/TV']]);
      const n = await S.plexRefresh(s, token, libs, [media + '/TV/Bob’s Show', '/elsewhere/x']);
      assert.strictEqual(n, 1);
      assert.deepStrictEqual(asked[asked.length - 1], ['/library/sections/2/refresh?path=' + encodeURIComponent(media + '/TV/Bob’s Show'), 'tok123abcXYZ']);
      await assert.rejects(S.plexLibraries(s, 'wrong'), (e) => e.code === 'NO_PLEX');
    } finally {
      s.close(); plex.close();
      if (made) fs.rmSync('/var/lib/plexmediaserver', { recursive: true, force: true }); else fs.rmSync(prefsDir + '/Preferences.xml', { force: true });
    }
  });
  test('forgetting the server takes Shelf’s key back off it', async () => {
    const s = await S.connect(opts({ password: PASS, pinned: hostFp }));
    try { assert.strictEqual(await S.removeKey(s, key.public), true); } finally { s.close(); }
    assert.strictEqual(fs.statSync('/home/' + USER + '/.ssh/authorized_keys').mode & 0o777, 0o600);
    await assert.rejects(S.connect(opts({ privateKey: key.private, pinned: hostFp })), (e) => e.code === 'AUTH');
  });
} else {
  console.log('  (real-server checks skipped: needs Linux, root and sshd)');
}

(async () => {
  if (canRun) await setup();
  try {
    for (const [name, fn] of tests) {
      try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
    }
  } finally {
    if (sshd) { sshd.kill(); sshd.stderr.destroy(); }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (media) fs.rmSync(media, { recursive: true, force: true });
  }
  console.log(passed + ' of ' + tests.length + ' server checks passed');
  process.exit(process.exitCode || 0);
})();
