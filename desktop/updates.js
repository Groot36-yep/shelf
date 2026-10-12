/*
 * Updates — only when you click "Check for Updates". Shelf never checks on its own.
 *
 * It asks GitHub for Shelf's latest release, and if you choose to install it, downloads the one
 * file it needs from Shelf's own GitHub releases, checks it byte for byte against the SHA-256
 * fingerprint GitHub publishes for it, and only then starts it. Nothing about you or your files
 * is sent: it's an ordinary download of a public page and a public file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'Groot36-yep/shelf';
const API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
const DOWNLOADS = 'https://github.com/' + REPO + '/releases/download/';
const PAGE = 'https://github.com/' + REPO + '/releases/latest';

// "1.10.0" > "1.9.3"
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// The "What's new" part of the release notes, as plain lines (no links, no HTML).
function whatsNew(body) {
  const text = String(body || '').replace(/\r/g, '');
  const m = text.match(/##\s*What[’']s new\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  const part = m ? m[1] : '';
  return part.split('\n')
    .map((l) => l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trimEnd())
    .filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()))
    .slice(0, 60).join('\n').trim().slice(0, 4000);
}

// How this copy of Shelf was installed decides what to download.
function installKind(platform, env) {
  if (platform !== 'win32') return 'page';
  return env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'setup';
}

/** Ask GitHub what the latest release is. fetchFn: Electron's net.fetch (or a test stand-in). */
async function check(fetchFn, current, kind) {
  const res = await fetchFn(API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is busy right now. Try again in a few minutes.' : 'GitHub answered ' + res.status);
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Couldn’t read the latest version');
  const want = kind === 'portable' ? /^Shelf-Portable-\d+\.\d+\.\d+\.exe$/ : /^Shelf-Setup-\d+\.\d+\.\d+\.exe$/;
  const a = (rel.assets || []).filter((x) => want.test(String(x.name)))[0];
  const asset = a && /^sha256:[0-9a-f]{64}$/.test(String(a.digest)) && String(a.browser_download_url).startsWith(DOWNLOADS)
    ? { name: String(a.name), size: Number(a.size) || 0, sha256: String(a.digest).slice(7), url: String(a.browser_download_url) }
    : null;
  return {
    current, version, newer: newer(version, current), kind,
    date: String(rel.published_at || ''), notes: whatsNew(rel.body), asset, page: PAGE
  };
}

/**
 * Download the release file into dir, checking its fingerprint as it arrives. Returns the file's path.
 * A file that doesn't match exactly is deleted and never run.
 */
async function download(fetchFn, asset, dir, onProgress, signal, allowAny) {
  if (!asset || (!allowAny && !asset.url.startsWith(DOWNLOADS))) throw new Error('Not a Shelf release file');
  const res = await fetchFn(asset.url, { signal, cache: 'no-store', credentials: 'omit' });
  if (!res.ok || !res.body) throw new Error('Download failed (' + res.status + ')');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(asset.name));
  const part = dest + '.download';
  const out = fs.createWriteStream(part);
  const hash = crypto.createHash('sha256');
  const total = asset.size || Number(res.headers.get('content-length')) || 0;
  let got = 0, last = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value); got += value.length;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (onProgress && (now - last > 120)) { last = now; onProgress(got, total); }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy(); try { fs.unlinkSync(part); } catch (x) { /* gone */ }
    throw signal && signal.aborted ? new Error('Cancelled') : e;
  }
  if (onProgress) onProgress(got, total);
  if (hash.digest('hex') !== asset.sha256) {
    try { fs.unlinkSync(part); } catch (x) { /* gone */ }
    throw new Error('The download didn’t match the release exactly, so it was deleted. Try again later.');
  }
  try { fs.unlinkSync(dest); } catch (x) { /* none there */ }
  fs.renameSync(part, dest);
  return dest;
}

module.exports = { check, download, newer, whatsNew, installKind, PAGE };
