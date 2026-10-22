// Sending to your server picks up where it stopped without leaving a gap: when the connection drops, a later
// piece may have arrived while an earlier one didn't, so the size of the part file says more than what's really
// there. A pretend SFTP server (in memory, any OS) loses one early piece and then drops the connection; the
// send is started again and the file on the "server" must be byte-for-byte the one on this PC. Also: a connection
// that stops moving is given up on (and retried), not waited on forever.
// Run with: node tests/resume.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const base = path.join(__dirname, '..');
const S = require(path.join(base, 'desktop', 'server.js'));
const { Server, utils } = require(path.join(base, 'node_modules', 'ssh2'));
const { STATUS_CODE } = utils.sftp;

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

function server(behaviour) {
  const keys = utils.generateKeyPairSync('ed25519');
  const files = new Map(), dirs = new Set(['/', '/tv']);
  const state = { writes: 0, conns: 0 };
  const srv = new Server({ hostKeys: [keys.private] }, (client) => {
    state.conns++;
    client.on('error', () => {});
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (a) => { const ch = a(); ch.exit(127); ch.end(); });
      session.on('sftp', (a) => {
        const sftp = a(); const handles = new Map(); let next = 0;
        const attrs = (p) => (dirs.has(p) ? { mode: 0o40755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 } : files.has(p) ? { mode: 0o100644, size: files.get(p).length, uid: 0, gid: 0, atime: 0, mtime: 0 } : null);
        const st = (id, p) => { const x = attrs(p); return x ? sftp.attrs(id, x) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE); };
        sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p === '.' ? '/tv' : p, longname: '', attrs: {} }]));
        sftp.on('STAT', st); sftp.on('LSTAT', st);
        sftp.on('MKDIR', (id, p) => { dirs.add(p); sftp.status(id, STATUS_CODE.OK); });
        sftp.on('OPEN', (id, p) => { if (!files.has(p)) files.set(p, Buffer.alloc(0)); const h = Buffer.alloc(4); h.writeUInt32BE(next++); handles.set(h.toString('hex'), p); sftp.handle(id, h); });
        sftp.on('WRITE', (id, h, off, data) => {
          const p = handles.get(h.toString('hex'));
          const n = ++state.writes;
          const act = behaviour(n, off, data, client, state);
          if (act === 'lose') return; // never written, never answered
          if (act === 'hang') return;
          let buf = files.get(p);
          if (buf.length < off + data.length) { const b = Buffer.alloc(off + data.length); buf.copy(b); buf = b; }
          data.copy(buf, off); files.set(p, buf);
          sftp.status(id, STATUS_CODE.OK);
          if (act === 'drop') setImmediate(() => client.end());
        });
        sftp.on('FSTAT', (id, h) => st(id, handles.get(h.toString('hex'))));
        sftp.on('CLOSE', (id, h) => { handles.delete(h.toString('hex')); sftp.status(id, STATUS_CODE.OK); });
        sftp.on('RENAME', (id, x, y) => { files.set(y, files.get(x)); files.delete(x); sftp.status(id, STATUS_CODE.OK); });
        sftp.on('REMOVE', (id, p) => { files.delete(p); sftp.status(id, STATUS_CODE.OK); });
        sftp.on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
      });
    }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => {
    const pinned = 'SHA256:' + crypto.createHash('sha256').update(utils.parseKey(keys.public).getPublicSSH()).digest('base64').replace(/=+$/, '');
    r({ port: srv.address().port, pinned, files, state, close: () => srv.close() });
  }));
}
const connect = (s) => S.connect({ host: '127.0.0.1', port: s.port, username: 'me', password: 'x', pinned: s.pinned });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-resume-'));
  const local = path.join(tmp, 'Show - S01E01.mkv');
  fs.writeFileSync(local, crypto.randomBytes(12 << 20));
  const want = fs.readFileSync(local);

  // 1. Piece 3 (offset 256 KB) is lost; after 20 more pieces arrive, the connection drops.
  let lostAt = -1;
  const s1 = await server((n, off) => {
    if (n === 3) { lostAt = off; return 'lose'; }
    if (n === 24) return 'drop';
    return 'ok';
  });
  let a = await connect(s1);
  await assert.rejects(a.upload(local, '/tv/Show/Season 01/Show - S01E01.mkv', { verify: false }));
  a.close();
  const partPath = '/tv/Show/Season 01/.Show - S01E01.mkv.shelf-part';
  const part = s1.files.get(partPath);
  assert.ok(part && part.length > lostAt + (1 << 20), 'the part file looks further along than it is (' + (part && part.length) + ' bytes, gap at ' + lostAt + ')');
  assert.ok(part.subarray(lostAt, lostAt + 1024).equals(Buffer.alloc(1024)), 'and has a gap');
  ok('a dropped send leaves a part file with a gap in it (' + (part.length >> 10) + ' KB long, nothing at ' + (lostAt >> 10) + ' KB)');
  // Sent again: picks up, backing up past the gap.
  s1.state.writes = 1000; // (no more losses)
  a = await connect(s1);
  const r = await a.upload(local, '/tv/Show/Season 01/Show - S01E01.mkv', { verify: false });
  a.close();
  const got = s1.files.get('/tv/Show/Season 01/Show - S01E01.mkv');
  assert.ok(got && got.equals(want), 'the file on the server is exactly the one on this PC');
  assert.ok(r.resumed <= lostAt, 'picked up from ' + r.resumed + ', before the gap at ' + lostAt);
  ok('sent again, it picks up before the gap (from ' + (r.resumed >> 10) + ' KB) and the copy is byte-for-byte right');
  s1.close();

  // 2. A connection that stops answering (but stays open) is given up on, as a dropped one.
  const s2 = await server((n) => (n >= 5 ? 'hang' : 'ok'));
  const b = await connect(s2);
  b.stallMs = 1500; // (a minute in the app)
  const t0 = Date.now();
  await assert.rejects(b.upload(local, '/tv/x.mkv', { verify: false }), (e) => e.code === 'LOST');
  b.close();
  assert.ok(Date.now() - t0 < 15000, 'gave up in ' + (Date.now() - t0) + ' ms');
  ok('a send that stops moving is given up on as a dropped connection (then tried again), not waited on forever');
  s2.close();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(passed + ' resume checks passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
