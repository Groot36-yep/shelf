// A pretend Plex server for tests: SSH + SFTP kept in memory (a media drive on /srv/disk1 linked into
// /mnt/media, a folder you can't open) and Plex answering through the SSH connection. Runs anywhere.
'use strict';
const fs = require('fs');
const path = require('path');
const posix = path.posix;
const crypto = require('crypto');
const assert = require('assert');
const S = require('../desktop/server.js');
const { Server, utils } = require('ssh2');
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

async function start(opts) {
  opts = opts || {};
  let server;
  // ---- The server's disk: real folders on /srv/disk1, linked into /mnt/media ----
  const dirs = new Set(['/', '/home', '/home/me', '/mnt', '/srv', '/srv/disk1', '/srv/disk1/TV', '/srv/disk1/Movies', '/root',
    '/srv/disk1/TV/Spongebob', '/srv/disk1/TV/Spongebob/Season 5', '/srv/disk1/TV/Good Show', '/srv/disk1/TV/Good Show/Season 01', '/srv/disk1/Movies/new stuff']);
  const links = new Map([['/mnt/media', '/srv/disk1']]);
  const denied = new Set(['/root']);
  const files = new Map([
    ['/srv/disk1/TV/Spongebob/Season 5/SpongeBob.SquarePants.S05E03.720p.mkv', 1000],
    ['/srv/disk1/TV/Spongebob/Season 5/SpongeBob.SquarePants.S05E03.720p.en.srt', 10],
    ['/srv/disk1/TV/Good Show/Season 01/Good Show - S01E01 - Pilot.mkv', 2000],
    ['/srv/disk1/Movies/new stuff/Charade.1963.1080p.BluRay.mkv', 3000]
  ]);
  // opts.extra: { 'server path': size }: more files (and their folders).
  for (const [p, size] of Object.entries(opts.extra || {})) {
    files.set(p, size);
    for (let d = posix.dirname(p); d && d !== '/' && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
  }
  // opts.real: { 'server path': 'file on this PC' }: that file's real bytes are served (for reading title cards).
  for (const [p, local] of Object.entries(opts.real || {})) files.set(p, fs.statSync(local).size);
  const reads = { opens: 0, closes: 0, count: 0, bytes: 0 }, writes = { bytes: 0 }, fds = {};
  let netFree = 0;
  // Follow links in any part of a path (like the real server does).
  function real(p) {
    p = posix.normalize(p);
    for (let i = 0; i < 10; i++) {
      let changed = false;
      for (const [l, t] of links) if (p === l || p.startsWith(l + '/')) { p = t + p.slice(l.length); changed = true; }
      if (!changed) return p;
    }
    return p;
}
const isDenied = (p) => [...denied].some((d) => p === d || p.startsWith(d + '/'));
function attrs(p, follow) {
  if (!follow && links.has(posix.normalize(p))) return { mode: 0o120777, uid: 0, gid: 0, size: 10, atime: 0, mtime: 0 };
  const r = real(p);
  if (dirs.has(r)) return { mode: 0o40755, uid: 0, gid: 0, size: 4096, atime: 0, mtime: 0 };
  if (files.has(r)) return { mode: 0o100644, uid: 0, gid: 0, size: files.get(r), atime: 0, mtime: 0 };
  return null;
}
const kids = (d) => {
  const r = real(d), out = [];
  for (const x of dirs) if (x !== '/' && posix.dirname(x) === r) out.push(x);
  for (const x of files.keys()) if (posix.dirname(x) === r) out.push(x);
  for (const x of links.keys()) if (posix.dirname(x) === r) out.push(x);
  return out.map((x) => posix.basename(x));
};

// ---- Plex, reached only through the SSH connection ----
const PLEX = {
  1: [{ guid: 'local://9', Media: [{ Part: [{ file: '/mnt/media/Movies/old/gone.mkv' }] }] }],
  2: [
    { grandparentGuid: 'plex://show/1', Media: [{ Part: [{ file: '/mnt/media/TV/Good Show/Season 01/Good Show - S01E01 - Pilot.mkv' }] }] },
    { grandparentGuid: 'local://42', Media: [{ Part: [{ file: '/mnt/media/TV/Spongebob/Season 5/SpongeBob.SquarePants.S05E03.720p.mkv' }] }] }
  ]
};
const plexAsked = [];
const hostKey = utils.generateKeyPairSync('ed25519');
const hostFp = S.fingerprint(utils.parseKey(hostKey.public).getPublicSSH());
const PASS = 'right-' + crypto.randomBytes(3).toString('hex');

server = new Server({ hostKeys: [hostKey.private] }, (client) => {
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === PASS ? ctx.accept() : ctx.reject(['password'])));
  client.on('error', () => {});
  client.on('tcpip', (accept, reject, info) => {
    if (info.destPort !== 32400) return reject();
    const stream = accept();
    let req = '';
    stream.on('data', (d) => {
      req += d;
      if (!req.includes('\r\n\r\n')) return;
      const url = req.split(' ')[1];
      plexAsked.push(url);
      assert.ok(/X-Plex-Token: tok12345/i.test(req), 'the token goes to Plex');
      const m = /^\/library\/sections\/(\d+)\/all\?type=\d+&X-Plex-Container-Start=(\d+)/.exec(url);
      const body = JSON.stringify({ MediaContainer: m ? { Metadata: +m[2] ? [] : PLEX[m[1]] || [] } : {} });
      stream.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body);
    });
  });
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept();
    session.on('sftp', (ok) => {
      const sftp = ok(), handles = new Map();
      let next = 0;
      const handle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next++); handles.set(h.toString('hex'), v); return h; };
      sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p === '.' ? '/home/me' : posix.normalize(p), longname: '', attrs: {} }]));
      const stat = (follow) => (id, p) => {
        if (isDenied(p) && p !== '/root') return sftp.status(id, STATUS_CODE.PERMISSION_DENIED);
        const a = attrs(p, follow); return a ? sftp.attrs(id, a) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
      };
      sftp.on('STAT', stat(true)); sftp.on('LSTAT', stat(false));
      sftp.on('OPENDIR', (id, p) => {
        if (isDenied(p)) return sftp.status(id, STATUS_CODE.PERMISSION_DENIED);
        if (!dirs.has(real(p))) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
        sftp.handle(id, handle({ dir: p, sent: false }));
      });
      sftp.on('READDIR', (id, h) => {
        const st = handles.get(h.toString('hex'));
        if (st.sent) return sftp.status(id, STATUS_CODE.EOF);
        st.sent = true;
        sftp.name(id, kids(st.dir).map((n) => ({ filename: n, longname: n, attrs: attrs(posix.join(st.dir, n), false) })));
      });
      sftp.on('MKDIR', (id, p) => { if (attrs(p, true)) return sftp.status(id, STATUS_CODE.FAILURE); dirs.add(real(p)); sftp.status(id, STATUS_CODE.OK); });
      sftp.on('RMDIR', (id, p) => { const r = real(p); if (!dirs.has(r) || kids(p).length) return sftp.status(id, STATUS_CODE.FAILURE); dirs.delete(r); sftp.status(id, STATUS_CODE.OK); });
      sftp.on('RENAME', (id, from, to) => {
        const a = real(from), b = real(to);
        if (!files.has(a) || files.has(b) || !dirs.has(posix.dirname(b))) return sftp.status(id, STATUS_CODE.FAILURE);
        files.set(b, files.get(a)); files.delete(a); sftp.status(id, STATUS_CODE.OK);
      });
      sftp.on('OPEN', (id, p, flags) => {
        if (isDenied(p) || !dirs.has(real(posix.dirname(p)))) return sftp.status(id, STATUS_CODE.PERMISSION_DENIED);
        // Opened for reading only: the file must be there, and nothing is changed.
        if ((flags & OPEN_MODE.READ) && !(flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC))) {
          if (!files.has(real(p))) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
          reads.opens++;
          return sftp.handle(id, handle({ file: real(p), read: true }));
        }
        if ((flags & OPEN_MODE.EXCL) && files.has(real(p))) return sftp.status(id, STATUS_CODE.FAILURE);
        files.set(real(p), 0); sftp.handle(id, handle({ file: p }));
      });
      // Reading: files given real bytes (opts.real) answer with them, others with zeros.
      sftp.on('READ', (id, h, offset, len) => {
        const st = handles.get(h.toString('hex'));
        if (!st || !st.read) return sftp.status(id, STATUS_CODE.FAILURE);
        const size = files.get(st.file) || 0;
        if (offset >= size) return sftp.status(id, STATUS_CODE.EOF);
        const n = Math.min(len, size - offset, 255 * 1024);
        reads.count++; reads.bytes += n;
        const local = (opts.real || {})[st.file];
        // opts.net: { mbps, ms }: answers arrive as over a network that fast, that far away.
        const later = (fn) => {
          if (!opts.net) return fn();
          const now = Date.now(), at = Math.max(now, netFree) + n / (opts.net.mbps * 125);
          netFree = at; setTimeout(fn, at - now + (opts.net.ms || 0));
        };
        if (!local) return later(() => sftp.data(id, Buffer.alloc(n)));
        const buf = Buffer.allocUnsafe(n);
        fs.read(fds[st.file] || (fds[st.file] = fs.openSync(local, 'r')), buf, 0, n, offset, (err, got) => later(() => (err ? sftp.status(id, STATUS_CODE.FAILURE) : sftp.data(id, buf.subarray(0, got)))));
      });
      sftp.on('FSTAT', (id, h) => {
        const st = handles.get(h.toString('hex'));
        const a = st && st.file && attrs(st.file, true);
        return a ? sftp.attrs(id, a) : sftp.status(id, STATUS_CODE.FAILURE);
      });
      sftp.on('CLOSE', (id, h) => { const st = handles.get(h.toString('hex')); if (st && st.read) reads.closes++; handles.delete(h.toString('hex')); sftp.status(id, STATUS_CODE.OK); });
      sftp.on('REMOVE', (id, p) => { files.delete(real(p)); sftp.status(id, STATUS_CODE.OK); });
      // Writing (a file sent to the server): only its size is kept.
      sftp.on('WRITE', (id, h, offset, data) => {
        const st = handles.get(h.toString('hex'));
        if (!st || st.read) return sftp.status(id, STATUS_CODE.FAILURE);
        const f = real(st.file);
        files.set(f, Math.max(files.get(f) || 0, offset + data.length));
        writes.bytes += data.length;
        sftp.status(id, STATUS_CODE.OK);
      });
    });
  }));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
return { port: server.address().port, fp: hostFp, pass: PASS, files, dirs, links, plexAsked, reads, writes, close: () => { server.close(); Object.values(fds).forEach((fd) => fs.closeSync(fd)); } };
}

module.exports = { start };
