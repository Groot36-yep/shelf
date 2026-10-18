/*
 * Shelf — remembered lookups.
 * Search results and episode lists are kept in this window's own storage, on this computer only
 * (never sent anywhere), so the same show isn't looked up again every time Shelf starts.
 * Each answer is kept for a while, then looked up afresh. "Forget Remembered Lookups" and
 * "Erase All Shelf Data" remove them.
 */
(function (root) {
  'use strict';

  var DAY = 864e5;
  function noop() {}

  /**
   * backend: { get(key) → Promise<record>, put(key, record), del(key), clear(), sweep(now) } (all Promises)
   * Returns { get(key) → Promise<{ v, at } | null>, set(key, value, days), clear() }. Never rejects:
   * if the storage isn't available, lookups simply aren't remembered.
   */
  function create(backend, now) {
    now = now || Date.now;
    var swept = false;
    return {
      get: function (key) {
        if (!swept && backend.sweep) { swept = true; backend.sweep(now()).catch(noop); } // old answers, once per session
        return backend.get(key).then(function (rec) {
          if (!rec || typeof rec.until !== 'number' || !('v' in rec)) return null;
          if (rec.until <= now()) { backend.del(key).catch(noop); return null; }
          return { v: rec.v, at: rec.at };
        }).catch(function () { return null; });
      },
      set: function (key, value, days) {
        var t = now();
        return backend.put(key, { v: value, at: t, until: t + days * DAY }).catch(noop);
      },
      clear: function () { return backend.clear().catch(noop); }
    };
  }

  function memoryBackend() {
    var m = new Map();
    return {
      get: function (k) { return Promise.resolve(m.get(k)); },
      put: function (k, rec) { m.set(k, JSON.parse(JSON.stringify(rec))); return Promise.resolve(); },
      del: function (k) { m.delete(k); return Promise.resolve(); },
      clear: function () { m.clear(); return Promise.resolve(); },
      sweep: function (t) { m.forEach(function (rec, k) { if (!rec || rec.until <= t) m.delete(k); }); return Promise.resolve(); },
      size: function () { return m.size; }
    };
  }

  function indexedDbBackend(idb) {
    var opening = null;
    function db() {
      if (!opening) {
        opening = new Promise(function (resolve, reject) {
          var req = idb.open('shelf-lookups', 1);
          req.onupgradeneeded = function () { req.result.createObjectStore('answers'); };
          req.onsuccess = function () {
            var d = req.result;
            // Erase All Shelf Data deletes the database while it's open: start again next time.
            d.onversionchange = function () { d.close(); opening = null; };
            d.onclose = function () { opening = null; };
            resolve(d);
          };
          req.onerror = function () { opening = null; reject(req.error); };
          req.onblocked = function () { opening = null; reject(new Error('blocked')); };
        });
      }
      return opening;
    }
    function tx(mode, fn) {
      return db().then(function (d) {
        return new Promise(function (resolve, reject) {
          var t = d.transaction('answers', mode);
          var r = fn(t.objectStore('answers'));
          t.oncomplete = function () { resolve(r && r.result); };
          t.onerror = t.onabort = function () { reject(t.error); };
        });
      }).catch(function (e) { opening = null; throw e; });
    }
    return {
      get: function (k) { return tx('readonly', function (s) { return s.get(k); }); },
      put: function (k, rec) { return tx('readwrite', function (s) { return s.put(rec, k); }); },
      del: function (k) { return tx('readwrite', function (s) { return s.delete(k); }); },
      clear: function () { return tx('readwrite', function (s) { return s.clear(); }); },
      sweep: function (t) {
        return tx('readwrite', function (s) {
          var cur = s.openCursor();
          cur.onsuccess = function () {
            var c = cur.result;
            if (!c) return;
            if (!c.value || !(c.value.until > t)) c.delete();
            c.continue();
          };
        });
      }
    };
  }

  /** The store this window uses: its own IndexedDB (in memory only, if that isn't available). */
  function open() {
    var idb = null;
    try { idb = root.indexedDB || null; } catch (e) { idb = null; }
    return create(idb ? indexedDbBackend(idb) : memoryBackend());
  }

  root.ShelfRemember = { create: create, memoryBackend: memoryBackend, open: open, DAY: DAY };
})(this);
