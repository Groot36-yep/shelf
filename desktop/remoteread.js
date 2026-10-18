/*
 * Shelf desktop — reading the title cards of videos on your Plex server, without downloading them
 * and without installing anything there.
 *
 * How: while a scan runs, a tiny web server answers on this PC only (127.0.0.1, a random port).
 * Each video gets a random address on it; ffmpeg reads that address the way it reads a file,
 * jumping around (HTTP byte ranges). Every piece ffmpeg asks for is read from the server over the
 * SSH connection Shelf already has (SFTP, at that offset), straight into memory and on to ffmpeg.
 * So only the few minutes of video around each title card cross the network, nothing is written
 * to disk, and the server only sees ordinary file reads by your account.
 *
 * Safety: the web server listens on 127.0.0.1 only, each address is 128 random bits and works only
 * for one video during one scan, only GET/HEAD are answered, and it is shut when the scan ends.
 * main.js only hands it files that Fix My Plex Library listed, after you said yes.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const p = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

/** Read len bytes at pos (fewer only at the end of the file). SFTP may answer a read in parts. */
function readFull(sftp, handle, pos, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  return new Promise((resolve, reject) => {
    const more = () => sftp.read(handle, buf, got, len - got, pos + got, (err, n) => {
      if (err) return reject(err);
      got += n || 0;
      if (!n || got >= len) return resolve(got < len ? buf.subarray(0, got) : buf);
      more();
    });
    more();
  });
}

/**
 * Start the reader for one scan. sftp: an open SFTP channel (server.js Session.sftp).
 * Returns { add(remotePath) → { url, size, fh, done() }, close(), stats: { requests, bytes } }.
 */
async function open(sftp) {
  // As big as the server allows per read (OpenSSH: ~256 KB), and a few at once so the network is never idle.
  const CHUNK = Math.max(16384, Math.min(256 * 1024, (sftp && sftp._maxReadLen) || 32768));
  const files = new Map(); // token → { path, handle, size }
  const sockets = new Set();
  const stats = { requests: 0, bytes: 0 };
  let port = 0, closed = false;

  const server = http.createServer((req, res) => {
    const f = files.get(String(req.url || '').replace(/^\/+/, ''));
    // Only this PC's own ffmpeg, only reading, only an address this scan handed out.
    if (closed || !f || (req.method !== 'GET' && req.method !== 'HEAD') || req.headers.host !== '127.0.0.1:' + port) {
      res.writeHead(404, { 'Content-Length': 0 }); return res.end();
    }
    stats.requests++;
    let start = 0, end = f.size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = +range[1]; if (range[2]) end = Math.min(end, +range[2]); }
      else start = Math.max(0, f.size - +range[2]); // the last N bytes
      if (start >= f.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + f.size, 'Content-Length': 0 }); return res.end(); }
    }
    const head = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' };
    if (range) head['Content-Range'] = 'bytes ' + start + '-' + end + '/' + f.size;
    res.writeHead(range ? 206 : 200, head);
    if (req.method === 'HEAD' || !f.size) return res.end();
    pump(f, res, start, end);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  // ffmpeg mostly asks for "from here to the end" and hangs up once it has what it wanted, so reads
  // start small and grow (a jump that needs only a header costs one or two reads).
  async function pump(f, res, start, end) {
    let gone = false;
    res.on('close', () => { gone = true; });
    const queue = [];
    let pos = start, depth = 2;
    const issue = () => {
      while (queue.length < depth && pos <= end) {
        const len = Math.min(CHUNK, end - pos + 1);
        const pr = readFull(sftp, f.handle, pos, len);
        pr.catch(() => {}); // a read still on its way when ffmpeg hangs up mustn't complain
        queue.push(pr); pos += len;
      }
    };
    try {
      issue();
      while (queue.length && !gone) {
        const buf = await queue.shift();
        if (gone) break;
        stats.bytes += buf.length;
        if (!buf.length) break; // the file got shorter
        depth = Math.min(16, depth * 2);
        issue();
        if (!res.write(buf)) {
          await new Promise((r) => { const go = () => { res.off('drain', go); res.off('close', go); r(); }; res.on('drain', go); res.on('close', go); });
        }
      }
      res.end();
    } catch (e) {
      res.destroy();
    }
  }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;

  async function add(remotePath) {
    if (closed) throw new Error('The scan has finished');
    const handle = await p((cb) => sftp.open(remotePath, 'r', cb));
    let size;
    try { size = Number((await p((cb) => sftp.fstat(handle, cb))).size) || 0; } catch (e) { await p((cb) => sftp.close(handle, cb)).catch(() => {}); throw e; }
    const token = crypto.randomBytes(16).toString('hex');
    const f = { path: remotePath, handle, size };
    files.set(token, f);
    let done = false;
    return {
      url: 'http://127.0.0.1:' + port + '/' + token, size,
      // The same file as a file handle (for probe.js, which reads the running time from the header).
      fh: {
        read: async (buf, off, len, pos) => {
          // All the pieces at once (the header can be a megabyte: one at a time would wait on the network each time).
          const parts = [];
          for (let at = 0; at < len; at += CHUNK) parts.push(readFull(sftp, handle, pos + at, Math.min(CHUNK, len - at)));
          let n = 0;
          for (const b of await Promise.all(parts)) { b.copy(buf, off + n); n += b.length; if (b.length < CHUNK) break; }
          stats.bytes += n;
          return { bytesRead: n, buffer: buf };
        },
        stat: async () => ({ size }),
        close: async () => {}
      },
      done: async () => {
        if (done) return; done = true;
        files.delete(token);
        await p((cb) => sftp.close(handle, cb)).catch(() => {});
      }
    };
  }

  async function close() {
    if (closed) return; closed = true;
    const left = [...files.values()]; files.clear();
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(() => r()));
    for (const f of left) await p((cb) => sftp.close(f.handle, cb)).catch(() => {});
  }

  return { add, close, stats, get port() { return port; }, get open() { return !closed; } };
}

module.exports = { open, readFull };
