/*
 * Shelf desktop — "Send to Plex": your server's details, the send queue, and what the window may ask.
 * The SSH work itself is in server.js.
 *
 * Privacy & security:
 *  - Your password, Shelf's key and your Plex token are encrypted with your Windows account before
 *    they're saved, and never handed to the window (it can only ask "is one saved?").
 *  - With a key (the default), your password is used once to add the key and then forgotten.
 *  - Only files inside your Shelf library's Movies and TV Shows folders can be sent.
 *  - Nothing goes anywhere but your own server.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const S = require('./server');
const { VIDEO_EXT, SUB_EXT } = require('../app/js/parser.js');

const WANTED = new Set(VIDEO_EXT.concat(SUB_EXT));
const TOPS = ['Movies', 'TV Shows'];
const SECRET_FILES = { password: 'server-pass.bin', key: 'server-key.bin', plex: 'plex-token.bin' };

function setup(ctx) {
  const { app, safeStorage, shell, readPrefs, writePrefs, log, send } = ctx;
  // Problems reach the window as "[CODE] message" (only the message crosses over).
  const handle = (ch, fn) => ctx.handle(ch, async (...a) => {
    try { return await fn(...a); } catch (e) { const f = S.friendly(e, (cfg() || {}).host || ''); throw new Error('[' + (f.code || 'OTHER') + '] ' + f.message); }
  });
  const dir = () => app.getPath('userData');
  const memory = {}; // secrets for this session only, when this computer can't encrypt them
  const canLock = () => { try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; } };

  function getSecret(name) {
    if (memory[name]) return memory[name];
    try { return canLock() ? safeStorage.decryptString(fs.readFileSync(path.join(dir(), SECRET_FILES[name]))) : ''; } catch (e) { return ''; }
  }
  function setSecret(name, value) {
    const f = path.join(dir(), SECRET_FILES[name]);
    delete memory[name];
    if (!value) { fs.rmSync(f, { force: true }); return; }
    if (!canLock()) { memory[name] = value; return; }
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(f, safeStorage.encryptString(value));
  }
  const cfg = () => readPrefs().server || null;
  function saveCfg(c) { const p = readPrefs(); if (c) p.server = c; else delete p.server; writePrefs(p); }
  const OPTION_DEFAULTS = { autoSend: false, verify: true, scan: true, tidy: false };
  const options = (c) => Object.assign({}, OPTION_DEFAULTS, (c && c.options) || {});

  /** What the window may know (no secrets). */
  function status() {
    const c = cfg();
    return {
      set: !!(c && c.host && c.fingerprint),
      host: c ? c.host : '', port: c ? c.port : 22, user: c ? c.user : '', fingerprint: c ? c.fingerprint : '', keyType: c ? c.keyType || '' : '',
      auth: c ? c.auth : '', hasLogin: !!(c && (c.auth === 'key' ? getSecret('key') : getSecret('password'))),
      movies: (c && c.movies) || '', tv: (c && c.tv) || '',
      plex: { token: !!getSecret('plex'), libraries: (c && c.libraries) || [] },
      options: options(c), locked: canLock(), library: readPrefs().library || '',
      sending: queue.snapshot()
    };
  }

  // ---- Connecting ----
  let session = null, idle = null, opening = null;
  async function open() {
    clearTimeout(idle);
    if (session && !session.closed) return session;
    // Two jobs asking at once (sending while the library is checked) share one connection.
    if (opening) return opening;
    const c = cfg();
    if (!c || !c.fingerprint) throw S.problem('NO_SERVER', 'Set up your Plex server first.');
    const key = c.auth === 'key' ? getSecret('key') : '', password = c.auth === 'key' ? '' : getSecret('password');
    if (!key && !password) throw S.problem('NO_LOGIN', 'Shelf needs your server password again.');
    opening = S.connect({ host: c.host, port: c.port, username: c.user, privateKey: key || undefined, password: password || undefined, pinned: c.fingerprint });
    try { session = await opening; } finally { opening = null; }
    return session;
  }
  function later() {
    clearTimeout(idle);
    idle = setTimeout(() => { if (queue.snapshot().running) return later(); if (session) session.close(); session = null; }, 45000);
  }
  async function withSession(fn) { const s = await open(); try { return await fn(s); } finally { later(); } }

  // The last server you looked up (first contact): you confirm its fingerprint before Shelf logs in.
  let pending = null;
  let fzList = [];
  const hostOk = (h) => typeof h === 'string' && /^[A-Za-z0-9.\-:\[\]%]{1,253}$/.test(h.trim());

  handle('shelf:server', async () => status());

  handle('shelf:serverFileZilla', async () => {
    const dirs = global.__shelfFileZillaDir ? [global.__shelfFileZillaDir]
      : [path.join(app.getPath('appData'), 'FileZilla'), path.join(os.homedir(), '.config', 'filezilla')];
    let list = [];
    for (const d of dirs) for (const f of ['sitemanager.xml', 'recentservers.xml']) {
      try { list = list.concat(S.parseFileZilla(await fsp.readFile(path.join(d, f), 'utf8'))); } catch (e) { /* not there */ }
    }
    const seen = new Set();
    fzList = list.filter((s) => { const k = s.host + ':' + s.port + ':' + s.user; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
    return fzList.map((s, i) => ({ id: i, name: s.name, host: s.host, port: s.port, user: s.user, hasPassword: !!s.password, hasKey: !s.password && !!s.keyfile }));
  });

  handle('shelf:serverProbe', async (host, port) => {
    host = String(host || '').trim(); port = Math.round(Number(port) || 22);
    if (!hostOk(host) || port < 1 || port > 65535) throw S.problem('UNREACHABLE', 'That doesn’t look like a server address. Try its IP, like 192.168.1.20.');
    try {
      await S.connect({ host, port, username: 'shelf', probe: true });
      throw S.problem('OTHER', 'Unexpected answer from the server.');
    } catch (e) {
      if (e.code !== 'HOST_UNKNOWN') throw S.friendly(e, host);
      pending = { host, port, fingerprint: e.fingerprint, keyType: e.keyType };
      const c = cfg();
      return { fingerprint: e.fingerprint, keyType: e.keyType, known: !!(c && c.host === host && c.port === port && c.fingerprint === e.fingerprint),
        changed: !!(c && c.host === host && c.port === port && c.fingerprint && c.fingerprint !== e.fingerprint), was: c && c.host === host ? c.fingerprint : '' };
    }
  });

  // a: { user, password, fz (FileZilla entry id), trust (the fingerprint you confirmed), useKey }
  handle('shelf:serverLogin', async (a) => {
    a = a || {};
    if (!pending || a.trust !== pending.fingerprint) throw S.problem('HOST_UNKNOWN', 'Check the server’s fingerprint first.');
    const fz = Number.isInteger(a.fz) && fzList[a.fz] && fzList[a.fz].host === pending.host ? fzList[a.fz] : null;
    const user = String(a.user || (fz && fz.user) || '').trim().slice(0, 64);
    const password = typeof a.password === 'string' && a.password ? a.password.slice(0, 1024) : (fz ? fz.password : '');
    if (!/^[A-Za-z0-9._][A-Za-z0-9._\-]*\$?$/.test(user)) throw S.problem('AUTH', 'Type the username you use on the server.');
    const old = cfg();
    const sameServer = old && old.host === pending.host && old.port === pending.port && old.user === user;
    const oldKey = sameServer && old.auth === 'key' ? getSecret('key') : '';
    // FileZilla's key file (read here, on this PC, only now).
    let fzKey = '';
    if (!password && fz && fz.keyfile) {
      try { fzKey = await fsp.readFile(fz.keyfile, 'utf8'); } catch (e) { throw S.problem('AUTH', 'Couldn’t open the key file FileZilla uses. Type your password instead.'); }
      if (fzKey.length > 64 * 1024) throw S.problem('AUTH', 'That key file doesn’t look right. Type your password instead.');
    }
    const loginKey = password ? '' : (fzKey || oldKey);
    if (!password && !loginKey) throw S.problem('AUTH', 'Type your password for the server.');
    if (session) { session.close(); session = null; }
    let s;
    try {
      s = await S.connect({ host: pending.host, port: pending.port, username: user, password: password || undefined, privateKey: loginKey || undefined, pinned: pending.fingerprint });
    } catch (e) {
      if (fzKey && !/^(HOST_|UNREACHABLE)/.test(S.friendly(e, '').code)) throw S.problem('AUTH', 'The server didn’t accept FileZilla’s key file (if it has a passphrase, type your password instead).');
      throw e;
    }
    let auth = password ? 'password' : 'key', note = '';
    const c = Object.assign({}, sameServer ? old : {}, { host: pending.host, port: pending.port, user, fingerprint: pending.fingerprint, keyType: pending.keyType });
    try {
      if ((password || fzKey) && a.useKey !== false) {
        // A key of Shelf's own, added to the server, then your password is forgotten.
        try {
          const k = S.makeKey('shelf@' + os.hostname());
          await S.installKey(s, k.public);
          const test = await S.connect({ host: pending.host, port: pending.port, username: user, privateKey: k.private, pinned: pending.fingerprint });
          test.close();
          setSecret('key', k.private); setSecret('password', '');
          c.pub = k.public; auth = 'key';
        } catch (e) {
          log('Key setup didn’t work (' + (S.friendly(e, '').code || 'OTHER') + ')');
          note = 'Your server didn’t accept a key, so Shelf will use your password instead.';
        }
      }
      if (auth === 'password') setSecret('password', password);
      else if (fzKey && !c.pub) setSecret('key', fzKey); // you chose not to have Shelf's own key: FileZilla's is used
      c.auth = auth;
      if (!c.home) c.home = await s.home();
      // Plex: find its libraries if your account can see Plex's settings.
      if (!getSecret('plex')) { const t = await S.findPlexToken(s).catch(() => null); if (t) setSecret('plex', t); }
      const token = getSecret('plex');
      if (token) {
        try { c.libraries = await S.plexLibraries(s, token); } catch (e) { c.libraries = c.libraries || []; }
      }
      // Pick the folders for you when Plex says where they are (and your account can save there).
      for (const kind of ['movies', 'tv']) {
        if (c[kind]) continue;
        const lib = (c.libraries || []).find((l) => l.kind === kind && l.folders.length);
        if (lib && await s.writable(lib.folders[0])) c[kind] = lib.folders[0];
      }
    } finally { s.close(); }
    saveCfg(c);
    pending = null;
    fzList = []; // FileZilla's passwords aren't kept around
    log('Plex server set up (' + c.auth + ')');
    return Object.assign(status(), { note });
  });

  // A folder you asked for that can't be opened says why, instead of quietly going home.
  handle('shelf:serverList', async (where) => withSession(async (s) => {
    const c = cfg();
    const asked = S.cleanRoot(where);
    let at = asked || c.home || await s.home();
    let problem = '';
    const st = await s.stat(at).catch((e) => { if (S.friendly(e, '').code === 'FOLDER') problem = 'denied'; return null; });
    if (!st) problem = problem || 'missing';
    else if (!st.isDirectory()) problem = 'file';
    let dirs = [];
    if (!problem) dirs = await s.list(at).catch(() => { problem = 'denied'; return []; });
    if (problem && !asked) { at = await s.home(); problem = ''; dirs = await s.list(at).catch(() => []); }
    const home = c.home || await s.home();
    return {
      path: at, parent: at === '/' ? '' : path.posix.dirname(at), dirs: dirs.slice(0, 1000), problem,
      writable: !problem && await s.writable(at), home, user: c.user,
      // Where drives and media usually live on Linux, when they're there.
      places: (await Promise.all(['/mnt', '/media', '/srv', '/data'].map(async (d) => ((await s.stat(d).catch(() => null)) ? d : null)))).filter(Boolean)
    };
  }));
  handle('shelf:serverMkdir', async (where, name) => withSession(async (s) => {
    const at = S.cleanRoot(where); name = String(name || '').trim();
    if (!at || !name || /[\/\0\n\r]/.test(name) || name === '.' || name === '..' || name.length > 120) throw S.problem('FOLDER', 'That folder name won’t work.');
    const full = path.posix.join(at, name);
    await s.mkdirp(full);
    return full;
  }));
  handle('shelf:serverFolder', async (kind, where) => {
    if (kind !== 'movies' && kind !== 'tv') throw new Error('Bad folder');
    const at = S.cleanRoot(where);
    if (!at) throw S.problem('FOLDER', 'Pick a folder on the server.');
    const ok = await withSession((s) => s.writable(at));
    if (!ok) throw S.problem('FOLDER', 'Your account on the server can’t save files in ' + at + '.');
    const c = cfg(); c[kind] = at; saveCfg(c);
    return status();
  });
  handle('shelf:serverPlex', async (token) => {
    token = typeof token === 'string' ? token.trim() : '';
    if (token && !/^[A-Za-z0-9_\-]{8,64}$/.test(token)) throw S.problem('NO_PLEX', 'That doesn’t look like a Plex token.');
    const c = cfg();
    const libs = await withSession(async (s) => {
      const t = token || getSecret('plex') || await S.findPlexToken(s);
      if (!t) throw S.problem('NO_PLEX', 'Shelf couldn’t find Plex’s token on the server. You can paste it instead.');
      const l = await S.plexLibraries(s, t);
      setSecret('plex', t);
      return l;
    });
    c.libraries = libs; saveCfg(c);
    return status();
  });
  handle('shelf:serverForgetPlex', async () => { setSecret('plex', ''); const c = cfg(); if (c) { c.libraries = []; saveCfg(c); } return status(); });
  handle('shelf:serverOptions', async (o) => {
    const c = cfg(); if (!c) return status();
    const cur = options(c);
    Object.keys(OPTION_DEFAULTS).forEach((k) => { if (o && typeof o[k] === 'boolean') cur[k] = o[k]; });
    c.options = cur; saveCfg(c);
    return status();
  });
  // Trust a new fingerprint (after the server was reinstalled): only the one you just looked up.
  handle('shelf:serverRetrust', async (fp) => {
    const c = cfg();
    if (!c || !pending || pending.host !== c.host || pending.port !== c.port || fp !== pending.fingerprint) throw S.problem('HOST_UNKNOWN', 'Look the server up again first.');
    c.fingerprint = pending.fingerprint; c.keyType = pending.keyType; saveCfg(c);
    if (session) { session.close(); session = null; }
    pending = null;
    return status();
  });
  handle('shelf:serverForget', async (removeKey) => {
    queue.stop();
    const c = cfg();
    let removed = false;
    if (removeKey && c && c.auth === 'key' && c.pub) {
      try { removed = await withSession((s) => S.removeKey(s, c.pub)); } catch (e) { removed = false; }
    }
    if (session) { session.close(); session = null; }
    forgetAll();
    return Object.assign(status(), { removed });
  });
  function forgetAll() {
    queue.stop();
    if (session) { session.close(); session = null; }
    pending = null; fzList = [];
    Object.keys(SECRET_FILES).forEach((n) => setSecret(n, ''));
    saveCfg(null);
  }

  // ---- What to send ----
  async function libraryRoot() {
    const lib = readPrefs().library;
    if (!lib) throw S.problem('NO_LIBRARY', 'Rename something first (Shelf needs your library folder).');
    return fsp.realpath(lib);
  }
  /** Files you asked to send, checked to be inside the library's Movies / TV Shows. null = the whole library. */
  async function pick(paths) {
    const lib = await libraryRoot();
    const out = [];
    const add = async (full) => {
      let real;
      try { real = await fsp.realpath(full); } catch (e) { return; }
      const rel = path.relative(lib, real);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
      const parts = rel.split(path.sep);
      if (!TOPS.includes(parts[0]) || parts.some((x) => x.startsWith('.'))) return;
      if (!WANTED.has(path.extname(real).slice(1).toLowerCase())) return;
      const st = await fsp.lstat(real).catch(() => null);
      if (!st || !st.isFile()) return;
      if (!out.some((o) => o.local === real)) out.push({ local: real, rel: parts.join('/'), size: st.size });
    };
    if (Array.isArray(paths)) {
      for (const pth of paths.slice(0, 20000)) if (typeof pth === 'string' && path.isAbsolute(pth)) await add(path.resolve(pth));
    } else {
      const walk = async (d) => {
        if (out.length >= 20000) return;
        let names = [];
        try { names = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
        names.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        for (const n of names) {
          if (n.name.startsWith('.') || n.isSymbolicLink()) continue;
          const f = path.join(d, n.name);
          if (n.isDirectory()) await walk(f); else if (n.isFile()) await add(f);
        }
      };
      for (const t of TOPS) await walk(path.join(lib, t));
    }
    return out;
  }
  function withRemote(list) {
    const c = cfg() || {};
    return list.map((f) => Object.assign({}, f, { remote: S.remoteFor(f.rel, { movies: c.movies, tv: c.tv }), kind: f.rel.startsWith('Movies/') ? 'movies' : 'tv' }));
  }

  /** A look before sending: what's new, what's already there, what's different, and is there room. */
  handle('shelf:sendPlan', async (paths) => {
    const files = withRemote(await pick(Array.isArray(paths) ? paths : null));
    const missing = [...new Set(files.filter((f) => !f.remote).map((f) => f.kind))];
    const go = files.filter((f) => f.remote);
    const plan = { files: files.length, missing, fresh: 0, same: 0, different: [], partial: 0, bytes: 0, free: null, room: true };
    if (!go.length) return plan;
    await withSession(async (s) => {
      for (const f of go) {
        const st = await s.stat(f.remote).catch(() => null);
        if (st && st.size === f.size) { plan.same++; continue; }
        if (st) plan.different.push(path.posix.basename(f.remote));
        else plan.fresh++;
        const part = await s.stat(path.posix.join(path.posix.dirname(f.remote), '.' + path.posix.basename(f.remote) + '.shelf-part')).catch(() => null);
        if (part && part.size <= f.size) { plan.partial++; plan.bytes += f.size - part.size; } else plan.bytes += f.size;
      }
      const c = cfg();
      const frees = await Promise.all([c.movies, c.tv].filter(Boolean).map((r) => s.free(r)));
      const known = frees.filter((x) => x != null);
      if (known.length) { plan.free = Math.min(...known); plan.room = plan.free > plan.bytes + 256 * 1024 * 1024; }
    });
    plan.different = plan.different.slice(0, 50);
    return plan;
  });

  // ---- The send queue (one file at a time, as fast as your network goes) ----
  const queue = (() => {
    let items = [], running = false, stopping = false, cur = null;
    let total = 0, done = 0, bytesTotal = 0, bytesDone = 0, results = [], rate = 0, lastAt = 0, lastBytes = 0, phase = '', message = '', code = '';
    const emit = (extra) => send(Object.assign(snapshot(), extra || {}));
    function snapshot() {
      return { running, phase, message, code, total, done, bytesTotal, bytesDone, rate: Math.round(rate), file: cur ? path.basename(cur.local) : '', local: cur ? cur.local : '', sent: results.filter((r) => r.ok && !r.skipped).length, failed: results.filter((r) => r.error).length, skipped: results.filter((r) => r.skipped).length };
    }
    function add(list, how) {
      if (!running) { total = 0; done = 0; bytesTotal = 0; bytesDone = 0; results = []; rate = 0; message = ''; code = ''; }
      list.forEach((f) => {
        if (items.some((i) => i.local === f.local) || (cur && cur.local === f.local)) return;
        items.push(Object.assign({ replace: !!(how && how.replace) }, f)); total++; bytesTotal += f.size;
      });
      if (!running) run();
      return list.length;
    }
    function stop() { stopping = true; items.length = 0; }
    let tick = 0;
    const progress = () => {
      const now = Date.now();
      if (now - lastAt > 500) { const r = (bytesDone - lastBytes) / ((now - lastAt) / 1000); rate = rate ? rate * 0.6 + r * 0.4 : r; lastAt = now; lastBytes = bytesDone; }
      if (now - tick > 200) { tick = now; emit({ kind: 'progress' }); }
    };
    async function run() {
      running = true; stopping = false; lastAt = Date.now(); lastBytes = 0;
      const touched = new Set();
      const opts = options(cfg());
      const host = () => (cfg() || {}).host || '';
      function record(r) {
        results.push(r); done++;
        if (r.error) log('Send to Plex: a file wasn’t sent (' + (r.code || 'OTHER') + ')'); // never names or paths
        emit({ kind: 'file', result: { local: r.local, ok: !!r.ok, skipped: r.skipped || '', error: r.error || '', checked: r.checked || '', tidied: !!r.tidied } });
      }
      // The last step for a file (check it on the server, give it its real name) runs while the next
      // file is already being sent, one check at a time.
      let checking = Promise.resolve(), checks = 0;
      function finishLater(f, r, t) {
        const prev = checking; checks++;
        checking = (async () => {
          await prev;
          try {
            const res = await t.finish();
            r.ok = true; r.checked = res.checked; touched.add(path.posix.dirname(f.remote));
            if (opts.tidy && res.checked === 'sha256') {
              try { await shell.trashItem(f.local); r.tidied = true; if (ctx.tidyDirs) await ctx.tidyDirs(path.dirname(f.local)); } catch (e) { /* kept */ }
            }
            record(r);
          } catch (e) {
            const err = S.friendly(e, host());
            f.attempt = (f.attempt || 0) + 1;
            if ((err.code === 'LOST' || err.code === 'BAD_COPY') && f.attempt <= 3 && !stopping) {
              bytesDone -= f.size; items.unshift(f); // sent again (or picked up where it stopped)
            } else { r.error = err.message; r.code = err.code; record(r); }
          } finally { checks--; }
        })();
      }
      try {
        do {
          while (items.length && !stopping) {
            cur = items.shift();
            const f = cur; const r = { local: f.local, remote: f.remote };
            let fileBytes = 0, attempt = 0, handed = false;
            for (;;) {
              try {
                phase = 'connect'; emit({ kind: 'progress' });
                const s = await open();
                const there = await s.stat(f.remote);
                if (there && there.size === f.size) { r.ok = true; r.skipped = 'Already on your server'; bytesDone += f.size - fileBytes; break; }
                if (there && !f.replace) { r.skipped = 'A different file with this name is already on your server'; bytesDone += f.size - fileBytes; break; }
                phase = 'send'; message = '';
                const t = await s.upload(f.local, f.remote, {
                  verify: opts.verify, replace: f.replace, stopped: () => stopping, later: true,
                  onBytes: (n) => { fileBytes += n; bytesDone += n; progress(); }
                });
                finishLater(f, r, t); handed = true;
                break;
              } catch (e) {
                const err = S.friendly(e, host());
                if (err.code === 'STOPPED') { r.error = 'Stopped'; break; }
                const retry = (err.code === 'LOST' || err.code === 'UNREACHABLE') && attempt < 4 && !stopping;
                if (session) { session.close(); session = null; }
                if (!retry) { r.error = err.message; r.code = err.code; if (/^(HOST_|AUTH|NO_LOGIN|NO_SERVER)/.test(err.code)) { stopping = true; message = err.message; code = err.code; } break; }
                attempt++;
                bytesDone -= fileBytes; fileBytes = 0;
                phase = 'retry'; message = 'Connection dropped. Trying again in ' + [2, 5, 10, 20][attempt - 1] + ' seconds…';
                emit({ kind: 'progress' });
                await new Promise((ok) => setTimeout(ok, [2, 5, 10, 20][attempt - 1] * 1000));
                message = '';
              }
            }
            if (!handed) record(r);
            cur = null;
          }
          if (checks) { phase = 'check'; emit({ kind: 'progress' }); }
          await checking;
        } while (items.length && !stopping);
        // Tell Plex to look at the folders that got new files.
        const token = getSecret('plex');
        if (opts.scan && token && touched.size && !stopping) {
          phase = 'scan'; emit({ kind: 'progress' });
          try {
            const c = cfg();
            await withSession(async (s) => {
              if (!c.libraries || !c.libraries.length) { c.libraries = await S.plexLibraries(s, token); saveCfg(c); }
              await S.plexRefresh(s, token, c.libraries, [...touched]);
            });
          } catch (e) { log('Plex scan didn’t work (' + (S.friendly(e, '').code || 'OTHER') + ')'); }
        }
      } finally {
        const wasStopped = stopping;
        running = false; cur = null; phase = ''; stopping = false; items = [];
        later();
        emit({ kind: 'end', stopped: wasStopped, scanned: !!(opts.scan && getSecret('plex') && touched.size) });
      }
    }
    return { add, stop, snapshot };
  })();

  handle('shelf:send', async (paths, how) => {
    const files = withRemote(await pick(Array.isArray(paths) ? paths : null)).filter((f) => f.remote);
    if (!files.length) return { queued: 0 };
    if (!cfg() || !cfg().fingerprint) throw S.problem('NO_SERVER', 'Set up your Plex server first.');
    return { queued: queue.add(files, { replace: !!(how && how.replace) }) };
  });
  handle('shelf:sendStop', async () => { queue.stop(); return true; });

  return { forgetAll, close: () => { queue.stop(); if (session) session.close(); }, withSession, cfg, getSecret, handle };
}

module.exports = { setup, SECRET_FILES };
