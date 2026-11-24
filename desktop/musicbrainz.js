/*
 * Shelf desktop — looking music up on MusicBrainz (albums, their editions and tracks) and the Cover Art
 * Archive (album covers).
 *
 * MusicBrainz asks every program to say who it is and to send at most one request a second; Shelf does both,
 * waits and tries again when the service is busy, and remembers every answer on this computer for 30 days
 * (so the same album is never asked about twice). Only album titles, artist names, song titles and
 * MusicBrainz ids are sent; never file names, folders or anything about this computer.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const VARIOUS = '89ad4ac3-39f7-470e-963a-56509c546377'; // MusicBrainz's "Various Artists"
const DAY = 864e5;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * o: { fetch, userAgent, cacheDir, base?, coverBase?, gapMs? (1000), now?, sleep? }
 * Everything comes in from outside so tests can run against a pretend MusicBrainz.
 */
// A request that gives up after `ms` (a connection that stops answering would otherwise wait forever).
function timedFetch(fetchFn, url, init, ms) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => { if (ac) ac.abort(); reject(Object.assign(new Error('Timed out'), { code: 'TIMEOUT' })); }, ms); });
  return Promise.race([Promise.resolve().then(() => fetchFn(url, Object.assign({}, init, ac ? { signal: ac.signal } : {}))), late]).finally(() => clearTimeout(timer));
}

function create(o) {
  const base = (o.base || 'https://musicbrainz.org/ws/2').replace(/\/$/, '');
  const coverBase = (o.coverBase || 'https://coverartarchive.org').replace(/\/$/, '');
  // A little over a second apart (clocks differ); after a "busy" answer, slower for a while.
  const baseGap = o.gapMs == null ? 1100 : o.gapMs;
  let gap = baseGap, calm = 0;
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const headers = { 'User-Agent': o.userAgent, Accept: 'application/json' };
  const TIMEOUT = o.timeoutMs || 30000; // (one stuck request would otherwise hold up every lookup after it)

  // ---- One request a second, in order; busy answers (503) are tried again after a pause ----
  let chain = Promise.resolve(), last = 0;
  function queued(fn) {
    const p = chain.then(async () => {
      const wait = last + gap - now();
      if (wait > 0) await sleep(wait);
      last = now();
      return fn();
    });
    chain = p.catch(() => {});
    return p;
  }
  async function getJson(url) {
    for (let attempt = 0; ; attempt++) {
      let r;
      try { r = await queued(() => timedFetch(o.fetch, url, { headers }, TIMEOUT)); } catch (e) {
        if (attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
        throw Object.assign(new Error('Couldn’t reach MusicBrainz. Check your internet connection.'), { code: 'NETWORK' });
      }
      if (r.status === 503 || r.status === 429) {
        gap = Math.min(3000, Math.max(gap, baseGap) * 1.5); calm = 0;
        if (attempt < 6) { const ra = Number(r.headers && r.headers.get && r.headers.get('retry-after')); await sleep((ra > 0 && ra < 60 ? ra : [2, 4, 8, 15, 30, 30][attempt]) * 1000); continue; }
        throw Object.assign(new Error('MusicBrainz is busy right now. Try again in a minute.'), { code: 'BUSY' });
      }
      if (gap > baseGap && ++calm >= 30) { gap = Math.max(baseGap, gap / 1.5); calm = 0; }
      if (r.status === 404) return null;
      if (!r.ok) throw Object.assign(new Error('MusicBrainz answered with an error (' + r.status + ').'), { code: 'HTTP' });
      return r.json();
    }
  }

  // ---- Remembered answers (on this computer only) ----
  const fileFor = (key) => path.join(o.cacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.json');
  async function remembered(key, days, fn) {
    if (o.cacheDir) {
      try {
        const rec = JSON.parse(await fsp.readFile(fileFor(key), 'utf8'));
        if (rec && now() - rec.at < days * DAY) return rec.v;
      } catch (e) {}
    }
    const v = await fn();
    if (o.cacheDir && v != null) {
      await fsp.mkdir(o.cacheDir, { recursive: true }).catch(() => {});
      await fsp.writeFile(fileFor(key), JSON.stringify({ at: now(), v })).catch(() => {});
    }
    return v;
  }
  async function forget() { if (o.cacheDir) await fsp.rm(o.cacheDir, { recursive: true, force: true }).catch(() => {}); }

  const q = (s) => '"' + String(s || '').replace(/[\\"]/g, ' ').replace(/\s+/g, ' ').trim() + '"';
  const qs = (params) => Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

  /** One release (edition) with everything Shelf needs: its tracks, artists, label, group. */
  function release(id) {
    if (!MBID.test(String(id))) return Promise.resolve(null);
    return remembered('mb:release:' + id, 30, async () => {
      const j = await getJson(base + '/release/' + id + '?' + qs({ inc: 'recordings artist-credits release-groups media labels genres', fmt: 'json' }));
      return j ? normRelease(j) : null;
    });
  }
  /** Editions that fit an album title + artist (and track count), best first, as MusicBrainz ranks them. */
  function searchReleases(s) {
    const parts = [];
    if (s.album) parts.push('release:' + q(s.album));
    if (s.artist) parts.push('artist:' + q(s.artist));
    if (!parts.length) return Promise.resolve([]);
    const query = parts.join(' AND ');
    return remembered('mb:search:' + query, 30, async () => {
      const j = await getJson(base + '/release?' + qs({ query, limit: 25, fmt: 'json' }));
      return ((j && j.releases) || []).map(normRelease);
    });
  }
  /**
   * Albums (release groups) by title + artist from a given year: tells same-named albums apart ("Weezer" 1994,
   * 2001, 2008…), which the edition search can't filter by.
   */
  function searchGroups(s) {
    const parts = [];
    if (s.album) parts.push('releasegroup:' + q(s.album));
    if (s.artist) parts.push('artist:' + q(s.artist));
    if (/^\d{4}$/.test(String(s.year || ''))) parts.push('firstreleasedate:' + s.year);
    if (!s.album) return Promise.resolve([]);
    const query = parts.join(' AND ');
    return remembered('mb:groups:' + query, 30, async () => {
      const j = await getJson(base + '/release-group?' + qs({ query, limit: 10, fmt: 'json' }));
      return ((j && j['release-groups']) || []).map((g) => ({ id: g.id, title: g.title || '', firstDate: g['first-release-date'] || '', primaryType: g['primary-type'] || '', secondaryTypes: g['secondary-types'] || [], artist: credit(g['artist-credit']), score: g.score || 0 }));
    });
  }
  /** Every edition in a release group (for "Other Releases…"). Without their tracks: those come one by one. */
  function groupReleases(groupId) {
    if (!MBID.test(String(groupId))) return Promise.resolve([]);
    return remembered('mb:group:' + groupId, 30, async () => {
      const j = await getJson(base + '/release?' + qs({ 'release-group': groupId, inc: 'media labels artist-credits', limit: 100, fmt: 'json' }));
      return ((j && j.releases) || []).map(normRelease);
    });
  }
  /** Songs that fit a title + artist (for loose singles), with the releases each one is on. */
  function searchRecordings(s) {
    const parts = [];
    if (s.title) parts.push('recording:' + q(s.title));
    if (s.artist) parts.push('artist:' + q(s.artist));
    if (!parts.length) return Promise.resolve([]);
    const query = parts.join(' AND ');
    return remembered('mb:rec:' + query, 30, async () => {
      const j = await getJson(base + '/recording?' + qs({ query, limit: 15, fmt: 'json' }));
      return ((j && j.recordings) || []).map((r) => ({
        id: r.id, title: r.title || '', length: r.length ? r.length / 1000 : 0, artist: credit(r['artist-credit']), score: r.score || 0,
        releases: (r.releases || []).map((x) => ({ id: x.id, title: x.title, date: x.date || '', country: x.country || '', status: x.status || '', group: x['release-group'] ? { id: x['release-group'].id, primaryType: x['release-group']['primary-type'] || '', secondaryTypes: x['release-group']['secondary-types'] || [] } : null, trackCount: x['track-count'] || 0 }))
      }));
    });
  }

  // ---- Covers (Cover Art Archive: its own service, no one-a-second rule; eight at a time) ----
  let coversRunning = 0; const coverWaiting = [];
  async function coverSlot(fn) {
    if (coversRunning >= 8) await new Promise((r) => coverWaiting.push(r));
    coversRunning++;
    try { return await fn(); } finally { coversRunning--; const n = coverWaiting.shift(); if (n) n(); }
  }
  /** The front cover of a release (or, failing that, of its group): { mime, data: Buffer } | null. */
  function cover(releaseId, groupId, size) {
    const sz = [250, 500, 1200].includes(size) ? '-' + size : '';
    const tries = [MBID.test(String(releaseId)) && coverBase + '/release/' + releaseId + '/front' + sz, MBID.test(String(groupId)) && coverBase + '/release-group/' + groupId + '/front' + sz].filter(Boolean);
    return coverSlot(async () => {
      for (const url of tries) {
        const hit = await remembered('caa:' + url, 30, async () => {
          let r;
          try { r = await timedFetch(o.fetch, url, { headers: { 'User-Agent': o.userAgent } }, TIMEOUT); } catch (e) { return null; }
          if (!r.ok) return r.status === 404 ? { none: true } : null;
          const data = Buffer.from(await r.arrayBuffer());
          if (data.length > 12 * 1048576) return { none: true };
          return { mime: r.headers.get('content-type') || 'image/jpeg', data: data.toString('base64') };
        });
        if (hit && !hit.none) return { mime: hit.mime, data: Buffer.from(hit.data, 'base64') };
      }
      return null;
    });
  }

  return { release, searchReleases, searchGroups, groupReleases, searchRecordings, cover, forget };
}

// ---- MusicBrainz's answers, boiled down to what Shelf uses ----
function credit(ac) {
  return (ac || []).map((c) => (c.name || (c.artist && c.artist.name) || '') + (c.joinphrase || '')).join('').trim();
}
function creditIds(ac) { return (ac || []).map((c) => c.artist && c.artist.id).filter(Boolean); }
function creditSort(ac) { return (ac || []).map((c) => ((c.artist && c.artist['sort-name']) || c.name || '') + (c.joinphrase || '')).join('').trim(); }
function normRelease(j) {
  const rg = j['release-group'] || {};
  const label = (j['label-info'] || [])[0] || {};
  const media = (j.media || []).map((m) => ({
    position: m.position || 1,
    format: m.format || '',
    title: m.title || '',
    trackCount: m['track-count'] || (m.tracks || []).length,
    tracks: (m.tracks || []).map((t) => ({
      id: t.id, recording: t.recording ? t.recording.id : '', position: t.position, number: t.number || String(t.position),
      title: t.title || (t.recording && t.recording.title) || '', length: (t.length || (t.recording && t.recording.length) || 0) / 1000,
      artist: credit(t['artist-credit'] || (t.recording && t.recording['artist-credit'])),
      artistIds: creditIds(t['artist-credit'] || (t.recording && t.recording['artist-credit'])),
      artistSort: creditSort(t['artist-credit'] || (t.recording && t.recording['artist-credit']))
    }))
  }));
  const artistIds = creditIds(j['artist-credit']);
  return {
    id: j.id, title: j.title || '', disambiguation: j.disambiguation || '',
    artist: credit(j['artist-credit']), artistIds, artistSort: creditSort(j['artist-credit']),
    compilation: artistIds.includes(VARIOUS),
    date: j.date || '', year: /^\d{4}/.test(j.date || '') ? +j.date.slice(0, 4) : 0,
    country: j.country || '', status: j.status || '', barcode: j.barcode || '', packaging: j.packaging || '',
    label: label.label ? label.label.name : '', catno: label['catalog-number'] || '',
    score: j.score || 0,
    trackCount: media.reduce((n, m) => n + m.trackCount, 0) || j['track-count'] || 0,
    formats: media.map((m) => m.format).filter(Boolean),
    media,
    genres: (j.genres || []).sort((a, b) => (b.count || 0) - (a.count || 0)).map((g) => g.name),
    group: { id: rg.id || '', title: rg.title || '', primaryType: rg['primary-type'] || '', secondaryTypes: rg['secondary-types'] || [], firstDate: rg['first-release-date'] || '' }
  };
}

module.exports = { create, normRelease, VARIOUS };
