/*
 * Shelf — Missing Episodes: which episodes of a show you don't have yet.
 * The show's full episode list (from TVmaze, TMDB or TheTVDB, in the order Plex uses) is compared with the
 * episodes your files hold: the files in Shelf's list (with what Shelf worked out, what you picked in Inspect,
 * and the pieces of a split) and the files in the show's folder on your Plex server (by their names).
 * A file holding more than one episode ("S01E01-E03", "S01E04E05") counts for each of them. Specials (season 0)
 * are kept apart, and episodes that haven't aired yet aren't counted as missing.
 * No window code here: it runs in the window and in the tests alike.
 */
(function (root) {
  'use strict';
  var P = typeof module !== 'undefined' && module.exports ? require('./parser.js') : root.ShelfParser;

  function key(season, number) { return season + 'x' + number; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function code(e) { return 'S' + pad2(e.season) + 'E' + pad2(e.number); }
  // "1..3" → [1, 2, 3] (a run that's too long to be one file is just its first episode).
  function run(season, from, to) {
    var out = [];
    var end = to > from && to - from < 10 ? to : from;
    for (var n = from; n <= end; n++) out.push({ season: season, number: n });
    return out;
  }
  function num(x) { var n = parseInt(x, 10); return isFinite(n) && n >= 0 ? n : null; }
  function fromEntries(es) {
    var out = [];
    (es || []).forEach(function (e) {
      if (!e || num(e.season) == null || num(e.number) == null) return;
      out = out.concat(run(num(e.season), num(e.number), num(e.end)));
    });
    return out;
  }

  /**
   * The episodes one file in Shelf's list holds: [{ season, number }], or null when Shelf doesn't know.
   * item: { split: { pieces: [{ entry }] }, manualEp: { season, number, end, entries }, episode: { season, number, end, entries } }.
   * A split's pieces win (each piece is an episode), then what you picked in Inspect, then what Shelf worked out.
   */
  function heldByItem(item) {
    if (!item) return null;
    var sp = item.split && item.split.pieces;
    if (sp && sp.length) { var ps = fromEntries(sp.map(function (p) { return p && p.entry; })); if (ps.length) return ps; }
    var picks = [item.manualEp, item.episode];
    for (var i = 0; i < picks.length; i++) {
      var m = picks[i];
      if (!m) continue;
      var es = m.entries && m.entries.length ? fromEntries(m.entries) : fromEntries([m]);
      if (es.length) return es;
    }
    return null;
  }

  /**
   * The episodes a file on the server holds, from its name (and its folders: "Season 05/E03.mkv"):
   * [{ season, number }], or null when its name doesn't say. folders: the folders inside the show's folder.
   */
  function heldByName(name, folders) {
    var p = P.parsePath(String(name || ''), folders || []);
    if (!p || p.kind !== 'episode' || p.season == null || p.episode == null) return null;
    return run(p.season, p.episode, p.episodeEnd || p.episode);
  }

  // ---- Which folders on the server are this show's ----
  function words(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[''`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
      .replace(/^the /, '').split(' ').filter(Boolean);
  }
  /** A show folder's name, read: { title, year, ids: { tmdb, tvdb, imdb } }. */
  function folderInfo(name) {
    var s = String(name || ''), ids = {};
    s = s.replace(/[{\[]\s*(tmdb|tvdb|imdb)(?:id)?[-=]\s*([a-z0-9]+)\s*[}\]]/gi, function (m, k, v) { ids[k.toLowerCase()] = v; return ' '; });
    var year = null;
    s = s.replace(/\(\s*((?:19|20)\d{2})\s*\)/, function (m, y) { year = +y; return ' '; });
    return { title: s.replace(/\s+/g, ' ').trim(), year: year, ids: ids };
  }
  // The whole of one is the start of the other ("Spongebob" and "SpongeBob SquarePants v2").
  function startsWith(a, b) {
    if (!a.length || a.length > b.length || a.join('').length < 4) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function sameWords(a, b) { return a.length > 0 && a.join(' ') === b.join(' '); }
  /**
   * Whether a folder on the server is this show's: 'yes' (its id, or its name), 'maybe' (a name that only starts
   * the same, which its files have to confirm, see filesAgree) or null.
   * show: { source: 'TMDB' | 'TheTVDB' | 'TVmaze', id, tvdbId, title, altTitle, year }.
   */
  function matchFolder(name, show) {
    if (!show) return null;
    var f = folderInfo(name);
    var mine = show.source === 'TMDB' ? { tmdb: show.id } : show.source === 'TheTVDB' ? { tvdb: show.id } : { tvdb: show.tvdbId };
    var told = false;
    for (var k in f.ids) {
      if (mine[k] == null) continue;
      if (String(f.ids[k]) === String(mine[k])) return 'yes';
      told = true; // the folder names another show on the same service
    }
    if (told) return null;
    if (f.year && show.year && Math.abs(f.year - show.year) > 1) return null;
    var fw = words(f.title), titles = [show.title, show.altTitle].filter(Boolean).map(words);
    if (titles.some(function (t) { return sameWords(fw, t); })) return 'yes';
    if (titles.some(function (t) { return startsWith(fw, t) || startsWith(t, fw); })) return 'maybe';
    return null;
  }
  /** For a 'maybe' folder: most of the files whose names say a show say this one. names: file names. */
  function filesAgree(names, show) {
    var titles = [show.title, show.altTitle].filter(Boolean).map(words), said = 0, same = 0;
    (names || []).forEach(function (n) {
      var p = P.parseFilename(String(n || ''));
      if (!p || !p.title) return;
      said++;
      if (titles.some(function (t) { return sameWords(words(p.title), t); })) same++;
    });
    return said > 0 && same * 2 >= said;
  }

  // ---- The comparison ----
  /**
   * list: the show's episode list [{ season, number, name, aired }]. held: [[{ season, number }], …] (one array
   * per file; null for a file Shelf doesn't know). opts.today: 'YYYY-MM-DD' (today if not given).
   * Returns {
   *   seasons: [{ season, total, have, missing: [{ season, number, name, aired, code }], upcoming }],
   *   total, have, missing (how many), complete, upcoming,
   *   specials: { total, have, missing: [...] } | null,   (season 0: never counted as missing)
   *   extra: [{ season, number, code }],   (held, but not on the list: often numbered in another order)
   *   unknown: files Shelf can't say which episode they are
   * }.
   */
  function compare(list, held, opts) {
    opts = opts || {};
    var today = opts.today || new Date().toISOString().slice(0, 10);
    var eps = (list || []).filter(function (e) { return e && num(e.season) != null && num(e.number) != null; })
      .map(function (e) { return { season: +e.season, number: +e.number, name: String(e.name || ''), aired: String(e.aired || e.airdate || '') }; })
      .sort(function (a, b) { return a.season - b.season || a.number - b.number; });
    // Out yet? An episode dated after today isn't. One with no date is if a later one has aired (an old
    // episode the service never dated); at the end of the list, it's one that's been announced.
    var later = false;
    for (var i = eps.length - 1; i >= 0; i--) {
      var e = eps[i];
      if (e.season === 0) { e.out = !e.aired || e.aired <= today; continue; }
      e.out = e.aired ? e.aired <= today : later;
      if (e.aired && e.aired <= today) later = true;
    }
    var have = {}, unknown = 0;
    (held || []).forEach(function (h) {
      if (!h || !h.length) { unknown++; return; }
      h.forEach(function (x) { have[key(x.season, x.number)] = 1; });
    });
    var listed = {}, bySeason = {}, order = [];
    eps.forEach(function (e) {
      listed[key(e.season, e.number)] = 1;
      if (!bySeason[e.season]) { bySeason[e.season] = []; order.push(e.season); }
      bySeason[e.season].push(e);
    });
    var out = { seasons: [], total: 0, have: 0, missing: 0, upcoming: 0, specials: null, extra: [], unknown: unknown };
    order.forEach(function (sn) {
      var all = bySeason[sn], aired = all.filter(function (e) { return e.out; });
      var missing = aired.filter(function (e) { return !have[key(e.season, e.number)]; }).map(function (e) {
        return { season: e.season, number: e.number, name: e.name, aired: e.aired, code: code(e) };
      });
      var s = { season: sn, total: aired.length, have: aired.length - missing.length, missing: missing, upcoming: all.length - aired.length };
      if (sn === 0) { out.specials = s; return; }
      if (!s.total && !s.upcoming) return;
      out.seasons.push(s);
      out.total += s.total; out.have += s.have; out.missing += missing.length; out.upcoming += s.upcoming;
    });
    Object.keys(have).forEach(function (k) {
      if (listed[k]) return;
      var p = k.split('x');
      out.extra.push({ season: +p[0], number: +p[1], code: code({ season: +p[0], number: +p[1] }) });
    });
    out.extra.sort(function (a, b) { return a.season - b.season || a.number - b.number; });
    out.complete = out.total > 0 && out.missing === 0;
    return out;
  }

  var api = { heldByItem: heldByItem, heldByName: heldByName, folderInfo: folderInfo, matchFolder: matchFolder, filesAgree: filesAgree, compare: compare, code: code };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShelfMissing = api;
})(this);
