/*
 * Shelf desktop — sending your renamed files to your Plex server, over SSH (SFTP).
 *
 * Safety rules, enforced here and in main.js (never trusted from the window):
 *  - Only SSH. Everything is encrypted; plain FTP is not supported.
 *  - Shelf checks it is talking to YOUR server: the server's fingerprint is shown to you the first
 *    time and remembered. If it ever changes, Shelf stops before sending your password or any file.
 *  - Your password is never sent until the fingerprint checks out.
 *  - Only files inside your Shelf library folder can be sent, and only into the server folders you chose.
 *  - Nothing on the server is ever overwritten unless you said Replace. Files arrive under a hidden
 *    temporary name and only get their real name once they are complete (and checked), so Plex never
 *    sees half a file.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const posix = path.posix;
const http = require('http');

// Modern algorithms only (all supported by Ubuntu's OpenSSH). AES-GCM first: it is the fastest on
// most PCs (the processor does the work).
const ALGORITHMS = {
  kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512', 'diffie-hellman-group14-sha256'],
  cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'chacha20-poly1305@openssh.com', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
  serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256'],
  hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512'],
  compress: ['none']
};
// Only what this copy of Shelf can actually run (the app's crypto library has no ChaCha20, for example).
(function keepSupported() {
  try {
    const C = require('ssh2/lib/protocol/constants');
    const keep = (list, ok) => { const l = list.filter((x) => ok.includes(x)); return l.length ? l : list; };
    ALGORITHMS.kex = keep(ALGORITHMS.kex, C.SUPPORTED_KEX);
    ALGORITHMS.cipher = keep(ALGORITHMS.cipher, C.SUPPORTED_CIPHER);
    ALGORITHMS.serverHostKey = keep(ALGORITHMS.serverHostKey, C.SUPPORTED_SERVER_HOST_KEY);
    ALGORITHMS.hmac = keep(ALGORITHMS.hmac, C.SUPPORTED_MAC);
  } catch (e) { /* ssh2's own defaults are used */ }
})();

/** The fingerprint OpenSSH shows for a host key: "SHA256:…". */
function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}
function keyType(key) {
  try { const n = key.readUInt32BE(0); return key.slice(4, 4 + n).toString('latin1'); } catch (e) { return ''; }
}
const TYPE_NAME = { 'ssh-ed25519': 'ED25519', 'ssh-rsa': 'RSA', 'ecdsa-sha2-nistp256': 'ECDSA', 'ecdsa-sha2-nistp384': 'ECDSA', 'ecdsa-sha2-nistp521': 'ECDSA' };

/** Plain-words problems. err.code is one of the codes below so the window can show the right help. */
function problem(code, message, extra) { const e = new Error(message); e.code = code; e.shelf = true; return Object.assign(e, extra || {}); }
function friendly(e, host) {
  if (e && e.shelf) return e; // already in plain words
  const m = String((e && e.message) || e);
  const c = (e && e.code) || '';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return problem('UNREACHABLE', 'Couldn’t find “' + host + '” on your network. Check the address (for example 192.168.1.20).');
  if (c === 'ECONNREFUSED') return problem('UNREACHABLE', 'The server said no to SSH on that port. Is SSH turned on (sudo apt install openssh-server), and is the port right?');
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'ETIMEDOUT' || /timed out/i.test(m)) return problem('UNREACHABLE', 'Couldn’t reach the server. Is it turned on and on the same network as this PC?');
  if (/authentication methods failed/i.test(m)) return problem('AUTH', 'The server didn’t accept that username or password.');
  if (/ECONNRESET|Connection lost|Not connected|No response from server|socket hang up|closed/i.test(m) || c === 'ECONNRESET') return problem('LOST', 'The connection to the server dropped.');
  if (c === 3 || /permission denied/i.test(m)) return problem('FOLDER', 'Your account on the server isn’t allowed to do that here (permission denied).');
  return problem('OTHER', m.slice(0, 300));
}

/**
 * Open an SSH connection.
 * o: { host, port, username, password?, privateKey?, pinned? (fingerprint you trusted), probe? }
 * probe: only learn the server's fingerprint, then hang up (nothing is sent but the hello).
 */
function connect(o) {
  const { Client } = require('ssh2');
  const host = String(o.host || '').trim(), port = Number(o.port) || 22;
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let seen = null, verdict = null, settled = false;
    const fail = (e) => { if (settled) return; settled = true; try { conn.end(); } catch (x) {} reject(e); };
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return fail(problem('NO_SFTP', 'The server doesn’t allow file transfers (SFTP) for this account.'));
        settled = true;
        resolve(new Session(conn, sftp, seen, o));
      });
    });
    conn.on('error', (e) => {
      if (verdict === 'unknown') return fail(problem('HOST_UNKNOWN', 'New server', seen));
      if (verdict === 'changed') return fail(problem('HOST_CHANGED', 'This server’s fingerprint has changed since you set it up. Shelf stopped and sent nothing.', seen));
      fail(friendly(e, host));
    });
    conn.on('close', () => fail(problem('LOST', 'The connection to the server dropped.')));
    try {
      conn.connect({
        host, port, username: String(o.username || ''),
        password: o.privateKey ? undefined : (o.password || undefined),
        privateKey: o.privateKey || undefined,
        tryKeyboard: !o.privateKey && !!o.password,
        readyTimeout: 15000, keepaliveInterval: 10000, keepaliveCountMax: 3,
        algorithms: ALGORITHMS,
        // Checked before any password or key is sent.
        hostVerifier: (key) => {
          seen = { fingerprint: fingerprint(key), keyType: TYPE_NAME[keyType(key)] || keyType(key) };
          if (o.probe) { verdict = 'unknown'; return false; }
          if (!o.pinned) { verdict = 'unknown'; return false; }
          if (seen.fingerprint !== o.pinned) { verdict = 'changed'; return false; }
          verdict = 'ok';
          return true;
        }
      });
      // Some servers ask for the password as a "keyboard-interactive" question.
      conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => finish(prompts.map(() => String(o.password || ''))));
    } catch (e) { fail(friendly(e, host)); }
  });
}

// '…' for the server's shell, safely (only used for sha256sum on paths Shelf built).
function quote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
const p = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

class Session {
  constructor(conn, sftp, host, opts) {
    this.conn = conn; this.sftp = sftp; this.host = host; this.opts = opts; this.closed = false;
    const gone = () => { this.closed = true; };
    conn.on('close', gone); conn.on('end', gone); sftp.on('end', gone); sftp.on('close', gone);
  }
  // ssh2 quietly drops a request made after the connection closed and never answers it (a send would wait
  // forever instead of being tried again), so once it's gone every request fails at once.
  p(fn) { return this.closed ? Promise.reject(problem('LOST', 'The connection to the server dropped.')) : p(fn); }
  close() { this.closed = true; try { this.conn.end(); } catch (e) {} }
  stat(f) { return this.p((cb) => this.sftp.stat(f, cb)).catch((e) => { if (e.code === 2) return null; throw e; }); }
  realpath(f) { return this.p((cb) => this.sftp.realpath(f, cb)); }
  home() { return this.realpath('.'); }
  /**
   * What's in a folder: [{ name, dir, file, size, link }]. Shortcuts (symlinks) are followed, so a
   * drive linked into /mnt or /media shows up as the folder it points to.
   */
  async entries(dir) {
    const list = await this.p((cb) => this.sftp.readdir(dir, cb));
    const out = [];
    let links = 0;
    for (const e of list) {
      let a = e.attrs, link = false;
      if (a.isSymbolicLink()) {
        if (++links > 2000) continue;
        link = true;
        a = await this.stat(posix.join(dir, e.filename)).catch(() => null); // where it points
        if (!a) continue; // broken shortcut
      }
      out.push({ name: e.filename, dir: a.isDirectory(), file: a.isFile(), size: Number(a.size) || 0, link });
    }
    return out;
  }
  async list(dir) {
    return (await this.entries(dir)).filter((e) => e.dir && !e.name.startsWith('.'))
      .map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }
  async mkdirp(dir) {
    // Folders this connection already saw are known; otherwise one look usually settles it.
    this.dirs = this.dirs || new Set();
    if (this.dirs.has(dir)) return;
    const here = await this.stat(dir);
    if (here && here.isDirectory()) { this.dirs.add(dir); return; }
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      const st = await this.stat(cur);
      if (st && st.isDirectory()) continue;
      if (st) throw problem('FOLDER', '“' + cur + '” on the server is a file, not a folder.');
      await this.p((cb) => this.sftp.mkdir(cur, cb)).catch(async (e) => { const again = await this.stat(cur); if (!again || !again.isDirectory()) throw e; });
    }
    this.dirs.add(dir);
  }
  /** Free space in bytes (null if the server doesn't say). */
  async free(dir) {
    try { const v = await this.p((cb) => this.sftp.ext_openssh_statvfs(dir, cb)); const n = Number(v.f_bavail) * Number(v.f_frsize || v.f_bsize); return Number.isFinite(n) ? n : null; } catch (e) { return null; }
  }
  /** Can your account save files in this folder? (A tiny hidden file is made and removed.) */
  async writable(dir) {
    const probe = posix.join(dir, '.shelf-check-' + crypto.randomBytes(4).toString('hex'));
    try {
      const h = await this.p((cb) => this.sftp.open(probe, 'wx', cb));
      await this.p((cb) => this.sftp.close(h, cb));
      await this.p((cb) => this.sftp.unlink(probe, cb)).catch(() => {});
      return true;
    } catch (e) { return false; }
  }
  /** Run one command on the server and collect what it prints. */
  exec(cmd, limit) {
    return new Promise((resolve, reject) => {
      this.conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = '', code = null;
        stream.on('data', (d) => { if (out.length < (limit || 65536)) out += d; });
        stream.stderr.on('data', () => {});
        stream.on('exit', (c) => { code = c; });
        stream.on('close', () => resolve({ code, out }));
      });
    });
  }
  /** The server works out the file's SHA-256 itself (null if it can't run commands). */
  async sha256(file) {
    if (/[\n\r\0]/.test(file)) return null;
    try {
      const r = await this.exec('LC_ALL=C sha256sum -b -- ' + quote(file));
      const m = /^\\?([0-9a-f]{64})\b/.exec(r.out);
      return r.code === 0 && m ? m[1] : null;
    } catch (e) { return null; }
  }
  async rename(from, to, replace) {
    if (replace) return this.p((cb) => this.sftp.ext_openssh_rename(from, to, cb)).catch(() => this.p((cb) => this.sftp.rename(from, to, cb)));
    // Never over an existing file (SFTP's plain rename refuses if the name is taken).
    if (await this.stat(to)) throw problem('CONFLICT', 'A file with this name is already on the server.');
    return this.p((cb) => this.sftp.rename(from, to, cb));
  }
  unlink(f) { return this.p((cb) => this.sftp.unlink(f, cb)); }
  async readSmall(f, max) {
    const st = await this.stat(f);
    if (!st || !st.isFile() || st.size > (max || 1 << 20)) return null;
    return this.p((cb) => this.sftp.readFile(f, cb));
  }

  /**
   * Send one file. It is written to ".<name>.shelf-part" next to where it goes, picks up where it
   * left off if that part is already there, is checked, and only then gets its real name.
   * o: { onBytes(n), stopped(), verify: bool, replace: bool, later: bool }
   * Returns { checked: 'sha256' | 'size', resumed: bytes }. With later: returns once every byte is
   * there, with finish() to check and name it (so the next file can start sending meanwhile).
   */
  async upload(local, remote, o) {
    o = o || {};
    const size = (await fsp.stat(local)).size;
    const dir = posix.dirname(remote), part = posix.join(dir, '.' + posix.basename(remote) + '.shelf-part');
    await this.mkdirp(dir);
    const old = await this.stat(part);
    // Picking up where a send stopped: up to a window of pieces were still on their way then, and a later one may
    // have arrived while an earlier one didn't (a gap the size wouldn't show). So it backs up past all of them.
    const t = this.tune || {}, chunk = t.chunk || 128 * 1024, back = (t.inFlight || 24) * chunk + chunk;
    let offset = old && old.isFile() && old.size <= size ? Math.max(0, Math.floor((old.size - back) / chunk) * chunk) : 0;
    const hash = crypto.createHash('sha256');
    const fh = await fsp.open(local, 'r');
    let handle = null;
    try {
      // What was already sent still counts towards the checksum.
      if (offset) {
        const buf = Buffer.allocUnsafe(1 << 20);
        for (let pos = 0; pos < offset;) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, offset - pos), pos);
          if (!bytesRead) break;
          hash.update(buf.subarray(0, bytesRead)); pos += bytesRead;
        }
        if (o.onBytes) o.onBytes(offset, true);
      }
      handle = await this.p((cb) => this.sftp.open(part, offset ? 'r+' : 'w', cb));
      await this._pump(fh, handle, offset, size, hash, o);
    } finally {
      await fh.close().catch(() => {});
      if (handle) await this.p((cb) => this.sftp.close(handle, cb)).catch(() => {});
    }
    const mine = hash.digest('hex');
    const finish = () => this._finish(part, remote, size, mine, o).then((checked) => ({ checked, resumed: offset }));
    if (o.later) return { finish, resumed: offset };
    if (o.stopped && o.stopped()) throw problem('STOPPED', 'Stopped');
    return finish();
  }
  /** Is the whole file there (and the same, by SHA-256)? Then it gets its real name. */
  async _finish(part, remote, size, mine, o) {
    const st = await this.stat(part);
    if (!st || st.size !== size) throw problem('LOST', 'The file didn’t arrive complete.');
    let checked = 'size';
    if (o.verify !== false) {
      if (o.onCheck) o.onCheck();
      const theirs = await this.sha256(part);
      if (theirs) {
        if (theirs !== mine) { await this.unlink(part).catch(() => {}); throw problem('BAD_COPY', 'The copy on the server didn’t match. It was removed so it can be sent again.'); }
        checked = 'sha256';
      }
    }
    await this.rename(part, remote, !!o.replace);
    return checked;
  }
  // Many writes in flight at once (the network is never waiting on the disk or the other way round).
  _pump(fh, handle, offset, size, hash, o) {
    const t = this.tune || {}; // (for measuring other settings)
    const CHUNK = t.chunk || 128 * 1024, READ = 4 * 1024 * 1024, MAX_IN_FLIGHT = t.inFlight || 24;
    const sftp = this.sftp;
    return new Promise((resolve, reject) => {
      let pos = offset, inFlight = 0, failed = false, reading = false, buf = null, bufPos = 0, bufEnd = 0;
      // A connection that stops moving (nothing written for a minute, though it never closed) is given up on, so
      // the send reconnects and picks up again instead of waiting forever.
      let moved = Date.now();
      const stall = this.stallMs || 60000;
      const watch = setInterval(() => { if (inFlight && Date.now() - moved > stall) fail(problem('LOST', 'The connection stopped moving.')); }, Math.min(5000, stall / 3));
      const done = () => { if (!failed && pos >= size && inFlight === 0) { clearInterval(watch); resolve(); } };
      const fail = (e) => { if (!failed) { failed = true; clearInterval(watch); reject(e); } };
      const fill = () => {
        if (reading || failed) return;
        reading = true;
        const want = Math.min(READ, size - pos);
        const b = Buffer.allocUnsafe(want);
        fh.read(b, 0, want, pos).then(({ bytesRead }) => {
          reading = false;
          if (!bytesRead) return fail(problem('LOST', 'This file got shorter while it was being sent.'));
          buf = b; bufPos = 0; bufEnd = bytesRead;
          hash.update(b.subarray(0, bytesRead));
          pump();
        }, (e) => { reading = false; fail(e); });
      };
      const pump = () => {
        if (failed) return;
        if (o.stopped && o.stopped()) return fail(problem('STOPPED', 'Stopped'));
        while (inFlight < MAX_IN_FLIGHT && pos < size) {
          if (!buf || bufPos >= bufEnd) { buf = null; return fill(); }
          const len = Math.min(CHUNK, bufEnd - bufPos);
          const at = pos, slice = buf, from = bufPos;
          pos += len; bufPos += len; inFlight++;
          sftp.write(handle, slice, from, len, at, (err) => {
            inFlight--; moved = Date.now();
            if (err) return fail(err);
            if (o.onBytes) o.onBytes(len);
            if (pos < size) pump(); else done();
          });
        }
        done();
      };
      if (size === offset) { clearInterval(watch); return resolve(); }
      pump();
    });
  }

  // ---- Talking to Plex on the server, through this same encrypted connection ----
  plex(token, pathAndQuery) {
    return new Promise((resolve, reject) => {
      this.conn.forwardOut('127.0.0.1', 0, '127.0.0.1', 32400, (err, stream) => {
        if (err) return reject(problem('NO_PLEX', 'Couldn’t reach Plex on the server.'));
        ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref'].forEach((f) => { if (typeof stream[f] !== 'function') stream[f] = () => stream; });
        const req = http.request({
          // No agent: with one (even agent: false), Node ignores createConnection and dials this PC's own port 32400.
          host: '127.0.0.1', port: 32400, path: pathAndQuery, method: 'GET', createConnection: () => stream,
          headers: { 'X-Plex-Token': token, Accept: 'application/json', 'X-Plex-Product': 'Shelf', 'X-Plex-Client-Identifier': 'shelf-desktop', Connection: 'close' }
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d) => { if (body.length < 4e6) body += d; });
          res.on('end', () => {
            if (res.statusCode === 401) return reject(problem('NO_PLEX', 'Plex didn’t accept the token.'));
            if (res.statusCode >= 400) return reject(problem('NO_PLEX', 'Plex answered ' + res.statusCode + '.'));
            resolve(body);
          });
        });
        const timer = setTimeout(() => { req.destroy(problem('NO_PLEX', 'Plex didn’t answer.')); }, 15000);
        req.on('error', (e) => { clearTimeout(timer); reject(e.code ? e : problem('NO_PLEX', 'Couldn’t talk to Plex.')); });
        req.on('close', () => clearTimeout(timer));
        req.end();
      });
    });
  }
}

// ---- Your Plex libraries ----
const PLEX_PREFS = [
  '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml',
  '/var/snap/plexmediaserver/common/Library/Application Support/Plex Media Server/Preferences.xml'
];
/** Plex's own token, if your account on the server is allowed to read Plex's settings file. */
async function findPlexToken(s) {
  for (const f of PLEX_PREFS) {
    try {
      const b = await s.readSmall(f, 512 * 1024);
      const m = b && /\bPlexOnlineToken="([A-Za-z0-9_\-]{8,64})"/.exec(b.toString('utf8'));
      if (m) return m[1];
    } catch (e) { /* not readable: fine */ }
  }
  return null;
}
async function plexLibraries(s, token) {
  const j = JSON.parse(await s.plex(token, '/library/sections'));
  const dirs = (j && j.MediaContainer && j.MediaContainer.Directory) || [];
  return dirs.filter((d) => d.type === 'movie' || d.type === 'show').map((d) => ({
    key: String(d.key), kind: d.type === 'movie' ? 'movies' : 'tv', title: String(d.title || ''),
    folders: (d.Location || []).map((l) => String(l.path || '')).filter((x) => x.startsWith('/'))
  }));
}
/** Ask Plex to look at just the folders that got new files. */
async function plexRefresh(s, token, libraries, dirs) {
  let asked = 0;
  for (const dir of dirs) {
    const lib = libraries.find((l) => l.folders.some((f) => dir === f || dir.startsWith(f.replace(/\/+$/, '') + '/')));
    if (!lib) continue;
    await s.plex(token, '/library/sections/' + encodeURIComponent(lib.key) + '/refresh?path=' + encodeURIComponent(dir));
    asked++;
  }
  return asked;
}

// ---- Where each file goes ----
/** A clean absolute folder path on the server, or ''. */
function cleanRoot(r) {
  r = String(r || '').trim();
  if (!r.startsWith('/') || /[\0\n\r]/.test(r)) return '';
  const n = posix.normalize(r).replace(/\/+$/, '');
  return n || '/';
}
/**
 * Library-relative path ("TV Shows/Show/Season 01/x.mkv") → path on the server, or null.
 * Movies go to roots.movies, TV Shows to roots.tv. Nothing can climb out of those folders.
 */
function remoteFor(rel, roots) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const root = parts[0] === 'Movies' ? cleanRoot(roots.movies) : parts[0] === 'TV Shows' ? cleanRoot(roots.tv) : '';
  if (!root) return null;
  const rest = parts.slice(1);
  if (rest.some((x) => x === '.' || x === '..' || /[\0\n\r/]/.test(x) || x.length > 255)) return null;
  const full = posix.join(root, ...rest);
  return full.startsWith(root === '/' ? '/' : root + '/') ? full : null;
}

// ---- Shelf's own key (instead of your password) ----
function makeKey(comment) {
  const { utils } = require('ssh2');
  const k = utils.generateKeyPairSync('ed25519', { comment: String(comment || 'shelf').replace(/[^\w@.\-]/g, '').slice(0, 60) });
  return { private: k.private, public: k.public.trim() };
}
const blobOf = (line) => (String(line).trim().split(/\s+/)[1] || '');
/** Adds Shelf's public key to ~/.ssh/authorized_keys on the server (once). */
async function installKey(s, pub) {
  const home = await s.home();
  const dir = posix.join(home, '.ssh'), file = posix.join(dir, 'authorized_keys');
  if (!(await s.stat(dir))) {
    await s.p((cb) => s.sftp.mkdir(dir, { mode: 0o700 }, cb));
    await s.p((cb) => s.sftp.chmod(dir, 0o700, cb)).catch(() => {});
  }
  const old = await s.stat(file);
  const text = old ? ((await s.readSmall(file, 1 << 20)) || Buffer.alloc(0)).toString('utf8') : '';
  if (text.split('\n').some((l) => blobOf(l) === blobOf(pub))) return false;
  const add = (text && !text.endsWith('\n') ? '\n' : '') + pub + '\n';
  const h = await s.p((cb) => s.sftp.open(file, 'a', { mode: 0o600 }, cb));
  try { await s.p((cb) => s.sftp.write(h, Buffer.from(add), 0, Buffer.byteLength(add), old ? old.size : 0, cb)); } finally { await s.p((cb) => s.sftp.close(h, cb)).catch(() => {}); }
  if (!old) await s.p((cb) => s.sftp.chmod(file, 0o600, cb)).catch(() => {});
  return true;
}
/** Takes Shelf's key back off the server. */
async function removeKey(s, pub) {
  const file = posix.join(await s.home(), '.ssh', 'authorized_keys');
  const st = await s.stat(file);
  if (!st) return false;
  const text = ((await s.readSmall(file, 1 << 20)) || Buffer.alloc(0)).toString('utf8');
  const lines = text.split('\n');
  const kept = lines.filter((l) => !blobOf(pub) || blobOf(l) !== blobOf(pub));
  if (kept.length === lines.length) return false;
  const tmp = file + '.shelf-tmp';
  await s.p((cb) => s.sftp.writeFile(tmp, kept.join('\n'), { mode: st.mode & 0o777 }, cb));
  await s.p((cb) => s.sftp.chmod(tmp, st.mode & 0o777, cb)).catch(() => {});
  await s.p((cb) => s.sftp.ext_openssh_rename(tmp, file, cb));
  return true;
}

// ---- FileZilla's saved servers (read only when you click "Use My FileZilla Server") ----
function xmlText(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
}
function parseFileZilla(xml) {
  const out = [];
  const re = /<Server\b[^>]*>([\s\S]*?)<\/Server>/g;
  let m;
  while ((m = re.exec(String(xml || ''))) && out.length < 100) {
    const b = m[1];
    const tag = (t) => { const x = new RegExp('<' + t + '\\b([^>]*)>([\\s\\S]*?)</' + t + '>').exec(b); return x ? { attrs: x[1], text: xmlText(x[2]).trim() } : null; };
    if ((tag('Protocol') || {}).text !== '1') continue; // 1 = SFTP. Plain FTP is never used.
    const host = (tag('Host') || {}).text || '';
    if (!host || /[\s/\\]/.test(host)) continue;
    const pass = tag('Pass');
    let password = '';
    if (pass && /encoding="base64"/.test(pass.attrs)) { try { password = Buffer.from(pass.text, 'base64').toString('utf8'); } catch (e) { password = ''; } }
    else if (pass && !/encoding=/.test(pass.attrs)) password = pass.text;
    const keyfile = ((tag('Keyfile') || {}).text || '').trim(); // FileZilla's "Key file" login
    out.push({ name: (tag('Name') || {}).text || host, host, port: Number((tag('Port') || {}).text) || 22, user: (tag('User') || {}).text || '', password, keyfile });
  }
  const seen = new Set();
  return out.filter((s) => { const k = s.host + ':' + s.port + ':' + s.user; if (seen.has(k)) return false; seen.add(k); return true; });
}

module.exports = { connect, fingerprint, remoteFor, cleanRoot, makeKey, installKey, removeKey, findPlexToken, plexLibraries, plexRefresh, parseFileZilla, quote, ALGORITHMS, problem, friendly };
