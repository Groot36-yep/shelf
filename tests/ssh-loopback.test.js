// Send to Plex on any computer: a tiny SSH server inside this test (no real server needed), so the
// encryption, fingerprint check, login, upload and checksum are tested on Windows too.
//   node tests/ssh-loopback.test.js                                      (the source)
//   ELECTRON_RUN_AS_NODE=1 dist/win-unpacked/Shelf.exe tests/ssh-loopback.test.js packaged   (the built app)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let base = ROOT;
if (process.argv.includes('packaged')) {
  base = ['win-unpacked', 'linux-unpacked', 'mac/Shelf.app/Contents'].map((d) => path.join(ROOT, 'dist', d, 'resources', 'app.asar')).find((p) => fs.existsSync(p));
  assert.ok(base, 'no packaged app found in dist/ (build it first)');
}
const S = require(path.join(base, 'desktop', 'server.js'));
const { Server, utils } = require(path.join(base, 'node_modules', 'ssh2'));
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

// ---- An SSH + SFTP server that keeps files in memory ----
const files = new Map(), dirs = new Set(['/', '/home', '/home/me']);
const PASS = 'right-' + crypto.randomBytes(3).toString('hex');
const hostKey = utils.generateKeyPairSync('ed25519');
const hostFp = S.fingerprint(utils.parseKey(hostKey.public).getPublicSSH());
let sawPassword = false;
function attrs(p) {
  if (dirs.has(p)) return { mode: 0o40755, uid: 0, gid: 0, size: 4096, atime: 0, mtime: 0 };
  if (files.has(p)) return { mode: 0o100644, uid: 0, gid: 0, size: files.get(p).length, atime: 0, mtime: 0 };
  return null;
}
const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password') sawPassword = true;
    if (ctx.method === 'password' && ctx.username === 'me' && ctx.password === PASS) return ctx.accept();
    ctx.reject(['password']);
  });
  client.on('error', () => {});
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept();
    session.on('exec', (ok, no, info) => {
      const stream = ok();
      const m = /^LC_ALL=C sha256sum -b -- '(.*)'$/.exec(info.command);
      const p = m && m[1].replace(/'\\''/g, "'");
      if (p && files.has(p)) { stream.write(crypto.createHash('sha256').update(files.get(p)).digest('hex') + ' *' + p + '\n'); stream.exit(0); }
      else stream.exit(1);
      stream.end();
    });
    session.on('sftp', (ok) => {
      const sftp = ok(), handles = new Map();
      let next = 0;
      sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p === '.' ? '/home/me' : path.posix.normalize(p), longname: '', attrs: {} }]));
      const stat = (id, p) => { const a = attrs(p); return a ? sftp.attrs(id, a) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE); };
      sftp.on('STAT', stat); sftp.on('LSTAT', stat);
      sftp.on('MKDIR', (id, p) => { if (attrs(p)) return sftp.status(id, STATUS_CODE.FAILURE); dirs.add(p); sftp.status(id, STATUS_CODE.OK); });
      sftp.on('OPEN', (id, p, flags) => {
        if (!dirs.has(path.posix.dirname(p))) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
        if ((flags & OPEN_MODE.EXCL) && files.has(p)) return sftp.status(id, STATUS_CODE.FAILURE);
        if ((flags & OPEN_MODE.TRUNC) || !files.has(p)) files.set(p, Buffer.alloc(0));
        const h = Buffer.alloc(4); h.writeUInt32BE(next++); handles.set(h.toString('hex'), p);
        sftp.handle(id, h);
      });
      sftp.on('WRITE', (id, h, offset, data) => {
        const p = handles.get(h.toString('hex')); let b = files.get(p);
        if (b.length < offset + data.length) { const n = Buffer.alloc(offset + data.length); b.copy(n); b = n; }
        data.copy(b, offset); files.set(p, b);
        sftp.status(id, STATUS_CODE.OK);
      });
      sftp.on('CLOSE', (id, h) => { handles.delete(h.toString('hex')); sftp.status(id, STATUS_CODE.OK); });
      sftp.on('RENAME', (id, from, to) => { if (files.has(to)) return sftp.status(id, STATUS_CODE.FAILURE); files.set(to, files.get(from)); files.delete(from); sftp.status(id, STATUS_CODE.OK); });
      sftp.on('REMOVE', (id, p) => { files.delete(p); sftp.status(id, STATUS_CODE.OK); });
    });
  }));
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const o = (x) => Object.assign({ host: '127.0.0.1', port, username: 'me' }, x);
  let n = 0;
  const ok = (msg) => { n++; console.log('  ✓ ' + msg); };

  await assert.rejects(S.connect(o({ password: PASS, probe: true })), (e) => e.code === 'HOST_UNKNOWN' && e.fingerprint === hostFp && e.keyType === 'ED25519');
  assert.strictEqual(sawPassword, false);
  ok('first contact gives the fingerprint and sends no password');
  await assert.rejects(S.connect(o({ password: PASS, pinned: 'SHA256:not-this-one' })), (e) => e.code === 'HOST_CHANGED');
  assert.strictEqual(sawPassword, false);
  ok('a different fingerprint stops before the password goes out');
  await assert.rejects(S.connect(o({ password: 'wrong', pinned: hostFp })), (e) => e.code === 'AUTH');
  ok('a wrong password is told apart');

  const s = await S.connect(o({ password: PASS, pinned: hostFp }));
  assert.ok(S.ALGORITHMS.cipher.includes('aes128-gcm@openssh.com'), 'fast AES-GCM is available');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-loop-'));
  const local = path.join(tmp, 'ep.mkv');
  fs.writeFileSync(local, crypto.randomBytes((5 << 20) + 12345));
  const remote = "/home/me/TV Shows/Bob's Burgers/Season 01/Bob's Burgers - S01E01 - Human Flesh.mkv";
  let got = 0;
  const r = await s.upload(local, remote, { onBytes: (b) => { got += b; } });
  assert.strictEqual(r.checked, 'sha256');
  assert.strictEqual(got, fs.statSync(local).size);
  assert.ok(files.get(remote).equals(fs.readFileSync(local)), 'arrived identical');
  assert.deepStrictEqual([...files.keys()], [remote], 'no temporary file left behind');
  ok('a 5 MB file arrives identical, checked with SHA-256, with no temporary file left');
  await assert.rejects(s.upload(local, remote, {}), (e) => e.code === 'CONFLICT');
  ok('an existing file is never overwritten without Replace');
  s.close();
  const k = S.makeKey('shelf@test');
  assert.match(k.public, /^ssh-ed25519 \S+ shelf@test$/);
  assert.ok(utils.parseKey(k.private).sign(Buffer.from('x')).length > 0);
  ok('Shelf can make and use its own key');
  fs.rmSync(tmp, { recursive: true, force: true });
  server.close();
  console.log(n + ' loopback SSH checks passed' + (base !== ROOT ? ' (packaged app)' : ''));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
