/*
 * Shelf desktop — recognising songs by their sound, for files whose tags and names say nothing useful.
 *
 * Chromaprint's fpcalc (from the AcoustID project, bundled with Shelf) listens to the first two minutes of a
 * song on this computer and boils it down to a fingerprint: a short code describing the sound. Only that code
 * and the song's length are sent to AcoustID, with your own free key; never the file, its name or its tags.
 * AcoustID answers with the MusicBrainz recordings that sound like it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * o: { fpcalc (path), fetch, key () → your AcoustID key, base?, parallel? (4) }
 * Returns { fingerprint(file), lookup(prints), recognise(files) }.
 */
function create(o) {
  const base = (o.base || 'https://api.acoustid.org/v2').replace(/\/$/, '');
  const PARALLEL = o.parallel || 4;
  let running = 0; const waiting = [];
  async function slot(fn) {
    if (running >= PARALLEL) await new Promise((r) => waiting.push(r));
    running++;
    try { return await fn(); } finally { running--; const n = waiting.shift(); if (n) n(); }
  }

  /** { duration, fingerprint } for one file (null if it can't be listened to). */
  function fingerprint(file) {
    return slot(() => new Promise((resolve) => {
      if (!o.fpcalc || !fs.existsSync(o.fpcalc)) return resolve(null);
      let out = '', done = false;
      const p = spawn(o.fpcalc, ['-json', '-length', '120', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const t = setTimeout(() => { try { p.kill(); } catch (e) {} }, 60000);
      p.stdout.on('data', (d) => { out += d; if (out.length > 200000) p.kill(); });
      const end = () => { if (done) return; done = true; clearTimeout(t); try { const j = JSON.parse(out); resolve(j && j.fingerprint ? { duration: Math.round(j.duration), fingerprint: j.fingerprint } : null); } catch (e) { resolve(null); } };
      p.on('close', end); p.on('error', () => { done = true; clearTimeout(t); resolve(null); });
    }));
  }

  // AcoustID allows three requests a second; Shelf asks for up to 10 songs per request, one request at a time.
  let last = 0;
  async function ask(prints) {
    const wait = last + 400 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const body = new URLSearchParams({ client: o.key(), format: 'json', meta: 'recordings releasegroups releases' });
    prints.forEach((p, i) => { body.set('duration.' + i, String(p.duration)); body.set('fingerprint.' + i, p.fingerprint); });
    let r;
    try { r = await o.fetch(base + '/lookup', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }); } catch (e) {
      throw Object.assign(new Error('Couldn’t reach AcoustID. Check your internet connection.'), { code: 'NETWORK' });
    }
    const j = await r.json().catch(() => null);
    if (!j || j.status !== 'ok') {
      const msg = (j && j.error && j.error.message) || ('error ' + r.status);
      if (/invalid api key|client/i.test(msg)) throw Object.assign(new Error('AcoustID didn’t accept your key. Check it in Settings.'), { code: 'KEY' });
      throw Object.assign(new Error('AcoustID answered with an error (' + msg + ').'), { code: 'HTTP' });
    }
    // With several fingerprints, each answer says which one it's for ("fingerprint.3" → index 3).
    const out = prints.map(() => []);
    (j.fingerprints || [j]).forEach((f, i) => { const idx = f.index != null ? Number(f.index) : i; if (out[idx]) out[idx] = recordingsOf(f.results || []); });
    if (!j.fingerprints && prints.length === 1) out[0] = recordingsOf(j.results || []);
    return out;
  }
  /** For each fingerprint: the recordings it sounds like, best first. */
  async function lookup(prints) {
    if (!o.key()) throw Object.assign(new Error('Add your free AcoustID key in Settings to recognise songs by their sound.'), { code: 'NOKEY' });
    const out = [];
    for (let i = 0; i < prints.length; i += 10) out.push(...await ask(prints.slice(i, i + 10)));
    return out;
  }
  /** files: [paths] → [{ recordings: [...] } | null] in the same order. */
  async function recognise(files) {
    const prints = await Promise.all(files.map(fingerprint));
    const have = prints.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    const res = have.length ? await lookup(have.map((i) => prints[i])) : [];
    const out = files.map(() => null);
    have.forEach((i, k) => { out[i] = { recordings: res[k] || [] }; });
    return out;
  }
  return { fingerprint, lookup, recognise };
}

// AcoustID's answer, boiled down: the recordings (with the releases each is on), best match first.
function recordingsOf(results) {
  const out = [];
  results.sort((a, b) => (b.score || 0) - (a.score || 0)).forEach((res) => {
    (res.recordings || []).forEach((rec) => {
      if (!rec.id || out.some((x) => x.id === rec.id)) return;
      const releases = [];
      (rec.releasegroups || []).forEach((g) => (g.releases || []).forEach((r) => releases.push({
        id: r.id, title: r.title || g.title || '', date: r.date ? [r.date.year, r.date.month, r.date.day].filter(Boolean).map((n, k) => (k ? String(n).padStart(2, '0') : n)).join('-') : '',
        country: r.country || '', status: 'Official', trackCount: r.track_count || 0,
        group: { id: g.id, primaryType: g.type || '', secondaryTypes: g.secondarytypes || [] }
      })));
      out.push({ id: rec.id, score: res.score || 0, title: rec.title || '', length: rec.duration || 0, artist: (rec.artists || []).map((a) => a.name + (a.joinphrase || '')).join('').trim(), releases });
    });
  });
  return out;
}

module.exports = { create, recordingsOf };
