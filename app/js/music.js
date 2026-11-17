/*
 * Shelf — music: which album and track each file is, and the Plex name it gets.
 * Pure functions with no network or DOM access, so they can be tested in Node.
 *
 * How a file is placed, best evidence first:
 *  1. MusicBrainz ids already in its tags (from Picard, or from Shelf before): exact.
 *  2. Its tags (album, artist, title, track number) and length, compared with each edition's track list.
 *  3. Its name and folders ("01 - Song.mp3" in "Artist/Album"), when it has no tags.
 *  4. Its sound (AcoustID), for files with neither.
 */
(function (root) {
  'use strict';

  var P = typeof module !== 'undefined' && module.exports ? require('./parser.js') : root.ShelfParser;
  var AUDIO_EXT = P.AUDIO_EXT, LYRICS_EXT = P.LYRICS_EXT;
  var VARIOUS = '89ad4ac3-39f7-470e-963a-56509c546377';

  // ---------- Comparing words (in any script: "Welcome トゥ 混沌" stays itself) ----------
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[’'`´]/g, '').replace(/&/g, ' and ')
      .replace(/\((feat|ft|with)\.?[^)]*\)|\b(feat|ft)\.\s.*$/g, ' ')    // "(feat. X)" doesn't make it another song
      .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/^(the|a|an) /, '').replace(/\s+/g, ' ').trim();
  }
  function lev(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    var prev = new Array(n + 1), cur = new Array(n + 1), i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      var t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }
  /** 0 (nothing alike) … 1 (the same), ignoring case, accents, punctuation and "(feat. …)". */
  function sim(a, b) {
    var x = norm(a), y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    var chars = 1 - lev(x, y) / Math.max(x.length, y.length);
    // Same words in another order, or one title inside the other ("Song" / "Song (Remastered 2009)").
    var wx = x.split(' '), wy = y.split(' '), common = wx.filter(function (w) { return wy.indexOf(w) >= 0; }).length;
    var words = common / Math.max(wx.length, wy.length);
    var inside = (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) ? 0.85 : 0;
    return Math.max(chars, words, inside);
  }

  // ---------- What a file's name says ----------
  var DISC_DIR = /^(?:cd|disc|disk|dis[ck]o)[\s._-]*(\d{1,2})\b/i;
  /**
   * "01 Dancing Queen.ogg", "1-11 Wake up!.mp3", "03. ABBA - Take a Chance on Me.flac", "ABBA - Chiquitita.mp3"
   * → { track, disc, title, artist } (whatever the name shows).
   */
  function parseTrackName(fileName, folders) {
    var base = String(fileName || '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    var out = { track: 0, disc: 0, title: '', artist: '' };
    var m = /^(?:audio\s*)?(?:track|piste|titel|pista|トラック)\s*(\d{1,3})$/i.exec(base);    // "Track 04": a number, no title
    if (m) { out.track = +m[1]; return out; }
    m = /^(\d{1,2})[-.](\d{1,3})(?:\s*[-.]\s*|\s+)(.+)$/.exec(base);                    // 1-11 Title
    if (m) { out.disc = +m[1]; out.track = +m[2]; base = m[3]; }
    else if ((m = /^(\d{1,3})(?:\s*[-.)]\s*|\s+)(.+)$/.exec(base))) { out.track = +m[1]; base = m[2]; } // 01 Title, 01. Title, 01 - Title
    var parts = base.split(/\s+-\s+/);
    if (parts.length >= 2) { out.artist = parts[0].trim(); out.title = parts.slice(1).join(' - ').trim(); } else out.title = base.trim();
    var dir = (folders || [])[(folders || []).length - 1] || '';
    if (!out.disc && (m = DISC_DIR.exec(dir))) out.disc = +m[1];
    return out;
  }

  /** How well an artist credit fits, when either may name several ("Royal & the Serpent, Arcane & League of Legends"). */
  function artistSim(a, b) {
    var parts = function (s) { return [s].concat(String(s || '').split(/\s*(?:,|&|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bwith\b|;|\/)\s*/i)).filter(function (x) { return norm(x); }); };
    var best = 0;
    parts(a).forEach(function (x) { parts(b).forEach(function (y) { best = Math.max(best, sim(x, y)); }); });
    return best;
  }

  // ---------- Which files make an album ----------
  /**
   * files: [{ id, name, folders: ['Artist', 'Album'] (closest last), tags: from tags.read (may be { ok: false }) }]
   * Returns albums: [{ key, ids, album, artist, year, votes: { releaseId: n }, single }] — files sharing an album
   * title + album artist (from tags) go together; without tags, files in one folder go together ("CD1", "Disc 2"
   * folders join their album's folder). A loose song on its own (in a folder of unrelated songs) is a single.
   */
  function groupAlbums(files) {
    var map = {}, order = [];
    files.forEach(function (f) {
      var t = f.tags && f.tags.ok ? f.tags : null, folders = (f.folders || []).slice();
      if (folders.length && DISC_DIR.test(folders[folders.length - 1])) folders.pop();
      var name = parseTrackName(f.name, f.folders);
      var artist = t && (t.albumArtists[0] || t.artists[0]) || name.artist || folders[folders.length - 2] || '';
      var album = t && t.album || '';
      var key = album ? 'tag:' + norm(artist) + '|' + norm(album) : 'dir:' + folders.join('/').toLowerCase();
      if (!map[key]) { map[key] = { key: key, ids: [], album: album || folders[folders.length - 1] || '', artist: artist, year: 0, votes: {}, fromTags: !!album, artists: {} }; order.push(key); }
      var a = map[key];
      a.ids.push(f.id);
      if (t && t.year && !a.year) a.year = t.year;
      if (t && t.mb.release) a.votes[t.mb.release] = (a.votes[t.mb.release] || 0) + 1;
      a.artists[norm((t && t.artists[0]) || name.artist)] = 1;
    });
    // A folder of unrelated songs without album tags ("Various Artists/Artist - Song.ogg"): each is a single.
    var out = [];
    order.forEach(function (k) {
      var a = map[k];
      var mixed = !a.fromTags && a.ids.length > 1 && Object.keys(a.artists).filter(Boolean).length > 1;
      if (mixed) a.ids.forEach(function (id) { out.push({ key: k + '#' + id, ids: [id], album: '', artist: '', year: 0, votes: {}, single: true }); });
      else { delete a.artists; out.push(a); }
    });
    return out;
  }

  // ---------- Lining files up with an edition's tracks ----------
  /** An edition's tracks in one list: { disc, discTotal, number, position, trackTotal, title, length, recording, id, artist, … }. */
  function tracksOf(release) {
    var out = [];
    (release.media || []).forEach(function (m) {
      (m.tracks || []).forEach(function (t) {
        out.push(Object.assign({}, t, { disc: m.position || 1, discTotal: (release.media || []).length, trackTotal: m.trackCount || m.tracks.length, format: m.format || '' }));
      });
    });
    return out;
  }
  // How badly a file fits a track: 0 (certain) … 1 (not at all).
  function fitCost(f, t, discs) {
    var tg = f.tags && f.tags.ok ? f.tags : null, nm = parseTrackName(f.name, f.folders);
    if (tg && tg.mb.recording && tg.mb.recording === t.recording) {
      // The same recording can be on an edition twice (bonus versions); the number settles which.
      var n0 = tg.track || nm.track;
      return !n0 || n0 === t.position ? 0 : 0.05;
    }
    // Recognised by its sound (AcoustID): as good as an id in its tags.
    if (f.soundRecs && f.soundRecs.indexOf(t.recording) >= 0) return 0.02;
    var title = (tg && tg.title) || nm.title, num = (tg && tg.track) || nm.track, disc = (tg && tg.disc) || nm.disc || 1;
    var dur = f.duration || (tg && tg.duration) || 0;
    var cTitle = title ? 1 - sim(title, t.title) : 0.6;
    var cNum = !num ? 0.5 : num === t.position && (discs < 2 || disc === t.disc) ? 0 : 1;
    var cDur = dur && t.length ? Math.min(1, Math.max(0, Math.abs(dur - t.length) - 3) / 25) : 0.4;
    var cost = 0.5 * cTitle + 0.2 * cNum + 0.3 * cDur;
    // A clearly different length is never the same track, whatever its title says.
    if (dur && t.length && Math.abs(dur - t.length) > 45) cost = Math.max(cost, 0.8);
    return cost;
  }
  var ACCEPT = 0.42;
  /** Two files of one song (another format, or a copy): the same recording, or the same title and length. */
  function sameSong(a, b) {
    var x = a.tags && a.tags.ok ? a.tags : null, y = b.tags && b.tags.ok ? b.tags : null;
    if (x && y && x.mb.recording && x.mb.recording === y.mb.recording) return true;
    var ta = (x && x.title) || parseTrackName(a.name, a.folders).title, tb = (y && y.title) || parseTrackName(b.name, b.folders).title;
    var da = a.duration || (x && x.duration) || 0, db = b.duration || (y && y.duration) || 0;
    return !!ta && sim(ta, tb) >= 0.95 && !!da && Math.abs(da - db) < 2;
  }
  /**
   * Put each file with the track it most likely is. Returns { pairs: [{ id, track, cost }], extra: [ids that
   * fit no track], missing: [tracks with no file], fit: 0…1 }.
   */
  function assign(files, release) {
    var tracks = tracksOf(release), discs = (release.media || []).length, cand = [];
    files.forEach(function (f) { tracks.forEach(function (t, j) { var c = fitCost(f, t, discs); if (c < ACCEPT) cand.push({ f: f, j: j, c: c }); }); });
    cand.sort(function (a, b) { return a.c - b.c || a.j - b.j; });
    var usedF = {}, usedT = {}, pairs = [];
    cand.forEach(function (x) {
      if (usedF[x.f.id] || usedT[x.j]) return;
      usedF[x.f.id] = 1; usedT[x.j] = 1;
      pairs.push({ id: x.f.id, track: tracks[x.j], cost: x.c });
    });
    // The same song twice (an Ogg made from a FLAC that's still there, say): it goes on its twin's track, marked,
    // rather than counting as a song this edition doesn't have.
    var byId = {};
    files.forEach(function (f) { byId[f.id] = f; });
    files.forEach(function (f) {
      if (usedF[f.id]) return;
      var twin = pairs.filter(function (p) { return !p.dup && sameSong(f, byId[p.id]); })[0];
      if (twin) { usedF[f.id] = 1; pairs.push({ id: f.id, track: twin.track, cost: twin.cost, dup: twin.id }); }
    });
    var extra = files.filter(function (f) { return !usedF[f.id]; }).map(function (f) { return f.id; });
    var missing = tracks.filter(function (t, j) { return !usedT[j]; });
    var mean = pairs.length ? pairs.reduce(function (s, p) { return s + p.cost; }, 0) / pairs.length : 1;
    var fit = files.length ? (pairs.length / files.length) * (1 - mean * 0.8) : 0;
    return { pairs: pairs, extra: extra, missing: missing, fit: fit, meanCost: mean };
  }

  // ---------- Choosing the edition ----------
  var FORMAT_RANK = { 'Digital Media': 0, CD: 0.3, 'Enhanced CD': 0.3, 'SHM-CD': 0.35, 'Blu-spec CD': 0.35, '12" Vinyl': 0.6, Vinyl: 0.6, Cassette: 0.8 };
  /**
   * How well an edition from a search fits an album guess, before its tracks are known (to choose which few to
   * look at closely). guess: { album, artist, year, count (files), maxTrack, trackTotal }.
   */
  function searchScore(guess, r, prefs) {
    prefs = prefs || {};
    var s = 0.4 * sim(guess.album, r.title) + 0.25 * (guess.artist ? artistSim(guess.artist, r.artist) : 0.5);
    var tc = r.trackCount || 0, want = guess.trackTotal || 0;
    if (want) s += tc === want ? 0.15 : 0;
    else if (tc && guess.count) s += tc >= Math.max(guess.count, guess.maxTrack || 0) ? 0.1 - Math.min(0.1, (tc - guess.count) / 100) : -0.2;
    // The year in the tags tells same-named albums apart (Weezer 1994 / Weezer 2016): it may be the edition's
    // year or the album's first.
    var first = r.group && /^\d{4}/.test(r.group.firstDate || '') ? +r.group.firstDate.slice(0, 4) : 0;
    if (guess.year && (r.year || first)) s += r.year === guess.year || first === guess.year ? 0.1 : Math.abs((first || r.year) - guess.year) > 2 ? -0.15 : 0;
    s += r.status === 'Official' ? 0.05 : r.status ? -0.1 : 0;
    s += prefs.country && r.country === prefs.country ? 0.04 : 0;
    var fr = r.formats && r.formats.length ? FORMAT_RANK[r.formats[0]] : null;
    s += fr == null ? 0 : (prefs.format === 'cd' ? (fr === 0 ? -0.01 : 0.02) : 0.02 * (1 - fr));
    return s;
  }
  /**
   * The best of several fully looked-up editions for an album's files. Returns { release, result (assign), score, sure }
   * sorted best first in `ranked`.
   */
  function rankReleases(guess, files, releases, prefs) {
    var total = Object.keys(guess.votes || {}).reduce(function (s, k) { return s + guess.votes[k]; }, 0);
    var ranked = releases.filter(Boolean).map(function (r) {
      var res = assign(files, r);
      var votes = total ? (guess.votes[r.id] || 0) / total : 0;
      var score = 0.6 * res.fit + 0.15 * searchScore(guess, r, prefs) + 0.25 * votes;
      // Most of an album: the edition with just your tracks wins over the deluxe one with bonus tracks (each
      // track beyond your songs costs it a little). A song or two of a big album doesn't count against it.
      if (r.trackCount && files.length >= r.trackCount * 0.5) score -= Math.min(0.1, Math.max(0, r.trackCount - files.length) * 0.012);
      return { release: r, result: res, score: score, votes: votes };
    }).sort(function (a, b) { return b.score - a.score; });
    var best = ranked[0];
    // Sure: every file found its track, closely, and (when files were tagged) it's the edition they named.
    var sure = !!best && !best.result.extra.length && best.result.meanCost < 0.2 && (!total || best.votes >= 0.5);
    return { ranked: ranked, best: best || null, sure: sure };
  }
  /**
   * For a loose song: of all the editions its recording is on, the one Plex would most expect it under —
   * an official album, then a single or EP; not a compilation or live recording; the earliest.
   */
  function pickHome(rec) {
    var rank = function (x) {
      var g = x.group || {}, sec = g.secondaryTypes || [];
      var t = g.primaryType === 'Album' && !sec.length ? 0 : g.primaryType === 'Single' ? 1 : g.primaryType === 'EP' ? 2 : g.primaryType === 'Album' ? 3 : 4;
      return [x.status === 'Official' ? 0 : 1, t + (sec.indexOf('Live') >= 0 ? 3 : 0) + (sec.indexOf('Compilation') >= 0 ? 2 : 0), x.date || '9999'];
    };
    return (rec.releases || []).slice().sort(function (a, b) {
      var ra = rank(a), rb = rank(b);
      for (var i = 0; i < ra.length; i++) { if (ra[i] < rb[i]) return -1; if (ra[i] > rb[i]) return 1; }
      return 0;
    })[0] || null;
  }

  /**
   * An edition built from the files' own tags, when they all name one MusicBrainz edition and each has a title and
   * a track number (what Picard writes). It holds only the tracks you have; its track counts come from the tags.
   * null when the tags aren't complete enough to trust.
   */
  function releaseFromTags(files) {
    var tg = files.map(function (f) { return f.tags && f.tags.ok ? f.tags : null; });
    if (!tg.length || tg.some(function (t) { return !t || !t.mb.release || !t.title || !t.track || !t.album; })) return null;
    var id = tg[0].mb.release;
    if (tg.some(function (t) { return t.mb.release !== id; })) return null;
    var t0 = tg[0], ids = String(t0.mb.albumArtist || '').split('/').filter(Boolean);
    var artist = t0.albumArtists[0] || t0.artists[0] || '';
    var cap = function (s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; };
    var discs = {}, discTotal = 1;
    tg.forEach(function (t, i) {
      var d = t.disc || 1;
      discTotal = Math.max(discTotal, d, t.discTotal || 0);
      var m = discs[d] || (discs[d] = { position: d, format: '', title: '', trackCount: 0, tracks: [] });
      m.trackCount = Math.max(m.trackCount, t.trackTotal || 0, t.track);
      if (m.tracks.some(function (x) { return x.position === t.track; })) return; // (the same song in another file: a twin)
      m.tracks.push({ id: '', recording: t.mb.recording || '', position: t.track, number: String(t.track), title: t.title,
        length: files[i].duration || t.duration || 0, artist: t.artists.join(' & ') || artist,
        artistIds: String(t.mb.artist || '').split('/').filter(Boolean), artistSort: (t.artistsSort || [])[0] || '' });
    });
    var media = [];
    for (var d = 1; d <= discTotal; d++) media.push(discs[d] || { position: d, format: '', title: '', trackCount: 0, tracks: [] });
    media.forEach(function (m) { m.tracks.sort(function (a, b) { return a.position - b.position; }); });
    var year = t0.year || 0, first = t0.originalYear || year;
    return {
      id: id, title: t0.album, disambiguation: '', artist: artist, artistIds: ids, artistSort: (t0.albumArtistsSort || [])[0] || '',
      compilation: !!t0.compilation || ids.indexOf(VARIOUS) >= 0 || /^various artists$/i.test(artist),
      date: year ? String(year) : '', year: year, country: t0.mb.country || '', status: cap(t0.mb.status), barcode: '', packaging: '',
      label: '', catno: '', score: 0, trackCount: media.reduce(function (n, m) { return n + m.trackCount; }, 0), formats: [], media: media, genres: [],
      group: { id: t0.mb.releaseGroup || '', title: t0.album, primaryType: cap(t0.mb.type), secondaryTypes: [], firstDate: first ? String(first) : '' },
      fromTags: true
    };
  }

  /** The album from its own tags alone, at once (no lookups), or null when they don't settle it. */
  function lookLocal(album, files, prefs) {
    var g0 = album.guess || album, votes = Object.keys(g0.votes || {});
    if (votes.length !== 1) return null;
    var local = releaseFromTags(files);
    if (!local) return null;
    var lr = rankReleases({ album: g0.album || '', artist: g0.artist || '', year: g0.year || 0, votes: g0.votes }, files, [local], prefs);
    return lr.best && !lr.best.result.extra.length ? Object.assign(lr, { how: 'tags' }) : null;
  }

  // ---------- Looking an album up (the whole plan, with the lookups passed in) ----------
  // "Uta's Songs (One Piece Film Red)" / "Double Life (From "Despicable Me 4")": MusicBrainz may write the part
  // in brackets differently, so it's tried without it too.
  function plainTitle(s) { return String(s || '').replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ').replace(/\s*[-–:]\s*(original )?(motion picture )?soundtrack.*$/i, '').replace(/\s+/g, ' ').trim(); }
  /**
   * api: { release(id), search({ album, artist }), recordings({ title, artist }) } → Promises
   * album: { guess: { album, artist, year, votes }, single }, files: [{ id, name, folders, tags, duration }]
   * Resolves { ranked, best, sure, how: 'ids' | 'search' | 'song' } or { none: 'why, in plain words' }.
   */
  function lookAlbum(api, album, files, prefs) {
    var tg = files.map(function (f) { return f.tags && f.tags.ok ? f.tags : {}; });
    var g0 = album.guess || album; // (as groupAlbums gives it, or with what you typed in Search)
    var guess = {
      album: g0.album || '', artist: g0.artist || '', year: g0.year || 0, votes: g0.votes || {},
      count: files.length, maxTrack: Math.max.apply(null, [0].concat(tg.map(function (t) { return t.track || 0; }))),
      trackTotal: (tg.filter(function (t) { return t.trackTotal; })[0] || {}).trackTotal || 0
    };
    // One edition at a time, stopping as soon as one fits every song closely: MusicBrainz answers one question a
    // second, so each question saved is a second sooner (have: editions already fetched, compared too).
    var fetchAll = function (ids, have) {
      return ids.reduce(function (p, id) {
        return p.then(function (out) {
          if (out.done) return out;
          return api.release(id).then(function (r) {
            if (r) out.push(r);
            var rk = rankReleases(guess, files, (have || []).concat(out), prefs);
            if (rk.sure) out.done = true;
            return out;
          }, function () { return out; });
        });
      }, Promise.resolve([]));
    };
    var good = function (r) { return r.best && r.best.result.pairs.length && r.best.result.fit > 0.35; };
    var voted = Object.keys(guess.votes).sort(function (x, y) { return guess.votes[y] - guess.votes[x]; });
    // 0. Tagged by Picard (or Shelf) with one edition, with titles and numbers: the tags hold what MusicBrainz
    //    would say, so nothing needs asking (a big tagged library is ready at once).
    var lr = lookLocal(album, files, prefs);
    if (lr) return Promise.resolve(lr);
    // 1. The editions the files are tagged with.
    var start = voted.length ? fetchAll(voted.slice(0, 3)).then(function (rels) {
      var r = rankReleases(guess, files, rels, prefs);
      return r.best && !r.best.result.extra.length ? Object.assign(r, { how: 'ids' }) : { have: rels };
    }) : Promise.resolve({ have: [] });
    return start.then(function (x) {
      if (x.ranked) return x;
      if (album.single || !guess.album) return Promise.resolve(bySong()).then(orSound);
      // 2. By name; then without the part in brackets; then without the artist (credited differently).
      var tries = [{ album: guess.album, artist: guess.artist }], plain = plainTitle(guess.album);
      if (plain && plain !== guess.album) tries.push({ album: plain, artist: guess.artist });
      if (guess.artist) tries.push({ album: plain || guess.album, artist: '' });
      var seen = {};
      return tries.reduce(function (p, q) {
        return p.then(function (done) {
          if (done) return done;
          return api.search(q).then(function (found) {
            var g2 = Object.assign({}, guess, { album: q.album });
            // (Searched without the artist: still only albums by a name the files mention, or compilations.)
            var top = found.filter(function (r) { return !seen[r.id] && (q.artist || !guess.artist || r.compilation || artistSim(guess.artist, r.artist) >= 0.75); })
              .map(function (r) { return [searchScore(g2, r, prefs), r]; })
              .filter(function (s) { return s[0] > 0.3; }).sort(function (a, b) { return b[0] - a[0]; }).slice(0, 3).map(function (s) { seen[s[1].id] = 1; return s[1].id; });
            return fetchAll(top, x.have).then(function (rels) {
              var r = rankReleases(guess, files, x.have.concat(rels), prefs);
              return good(r) ? Object.assign(r, { how: 'search' }) : null;
            });
          });
        });
      }, Promise.resolve(null)).then(function (r) { return r || byYear().then(function (y) { return y || Promise.resolve(bySong()).then(orSound); }); });
    });
    // 4. Nothing by name: by their sound (AcoustID). Each song votes for the editions its recording is on.
    function orSound(r) {
      if (!r.none || !api.sound) return r;
      return api.sound(files).then(function (heard) {
        if (!heard) return r; // (no key, or no fingerprint tool: the reason by name stands)
        var votes = {}, homes = {}, recs = {}, known = 0;
        heard.forEach(function (h, i) {
          var top = h && h.recordings && h.recordings.filter(function (x) { return x.score >= 0.5; });
          if (!top || !top.length) return;
          known++;
          recs[files[i].id] = top.slice(0, 3).map(function (x) { return x.id; });
          var seenHere = {};
          top.slice(0, 3).forEach(function (rec) { (rec.releases || []).forEach(function (rel) { if (seenHere[rel.id]) return; seenHere[rel.id] = 1; votes[rel.id] = (votes[rel.id] || 0) + 1; homes[rel.id] = rel; }); });
        });
        if (!known) return { none: (r.none ? r.none + ' ' : '') + 'Its sound wasn’t recognised either.' };
        var max = Math.max.apply(null, Object.keys(votes).map(function (k) { return votes[k]; }));
        // Of the editions most songs are on: the one Plex would most expect (official album, earliest).
        var best = pickHome({ releases: Object.keys(votes).filter(function (k) { return votes[k] === max; }).map(function (k) { return homes[k]; }) });
        if (!best) return r;
        return api.release(best.id).then(function (rel) {
          if (!rel) return r;
          var heardFiles = files.map(function (f) { return Object.assign({}, f, { soundRecs: recs[f.id] || [] }); });
          var rk = rankReleases(Object.assign({}, guess, { album: rel.title, artist: rel.artist, votes: {} }), heardFiles, [rel], prefs);
          return rk.best && rk.best.result.pairs.length ? Object.assign(rk, { how: 'sound', sure: rk.sure && known === files.length }) : r;
        });
      }, function (e) { return e && e.code === 'NOKEY' ? r : { none: (e && e.message) || 'Recognising its sound failed.' }; });
    }
    // 2b. Same-named albums ("Weezer" 1994 and 2016): the album from the year in the tags, then its editions.
    function byYear() {
      if (!guess.year || !api.groups || !api.groupReleases) return Promise.resolve(null);
      return api.groups({ album: plainTitle(guess.album) || guess.album, artist: guess.artist, year: guess.year }).then(function (gs) {
        var g = gs.filter(function (x) { return sim(x.title, guess.album) >= 0.85 || sim(x.title, plainTitle(guess.album)) >= 0.85; })[0];
        if (!g) return null;
        return api.groupReleases(g.id).then(function (rels) {
          var top = rels.map(function (r) { return [searchScore(guess, r, prefs), r]; }).sort(function (a, b) { return b[0] - a[0]; }).slice(0, 3).map(function (s) { return s[1].id; });
          return fetchAll(top).then(function (full) {
            var r = rankReleases(guess, files, full, prefs);
            return good(r) ? Object.assign(r, { how: 'search' }) : null;
          });
        });
      }, function () { return null; });
    }
    // 3. By the first song's title and artist; it goes with its first official album.
    function bySong() {
      var f = files[0], t = tg[0], nm = parseTrackName(f.name, f.folders);
      var title = t.title || nm.title, artist = (t.artists && t.artists[0]) || nm.artist || guess.artist || '';
      if (!title) return { none: 'It has no title in its tags or name, so it can’t be looked up by name.' };
      return api.recordings({ title: title, artist: artist }).then(function (recs) {
        var best = recs.map(function (r) {
          // The studio recording, not a live one with the same title (its home album says which).
          var h = pickHome(r), g = (h && h.group) || {}, sec = g.secondaryTypes || [];
          var kind = sec.indexOf('Live') >= 0 ? -0.15 : g.primaryType === 'Album' && !sec.length ? 0.05 : 0;
          return [sim(title, r.title) * 0.6 + (artist ? sim(artist, r.artist) * 0.3 : 0.15) + (f.duration && r.length ? Math.max(0, 0.1 - Math.abs(f.duration - r.length) / 100) : 0.03) + kind, r];
        }).sort(function (a, b) { return b[0] - a[0]; })[0];
        if (!best || best[0] < 0.7) return { none: 'Couldn’t find “' + (guess.album || title) + '”' + (artist ? ' by ' + artist : '') + ' on MusicBrainz.' };
        var home = pickHome(best[1]);
        if (!home) return { none: 'Found the song, but not an album it’s on.' };
        return api.release(home.id).then(function (rel) {
          if (!rel) return { none: 'Couldn’t load the album this song is on.' };
          var r = rankReleases(Object.assign({}, guess, { album: rel.title, artist: rel.artist, votes: {} }), files, [rel], prefs);
          return good(r) ? Object.assign(r, { how: 'song', sure: false }) : { none: 'Found “' + title + '”, but it doesn’t fit your files.' };
        });
      });
    }
  }

  // ---------- The Plex name, and the tags written ----------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /**
   * release + track → { folder: ['Music', 'ABBA', 'Gold - Greatest Hits (1992)'], file: '01 - Dancing Queen.ogg' }.
   * opts: { year: bool (album folder has the year), safeName: fn (from parser.js) }
   * Several discs: "1-01 - Title"; compilations go under "Various Artists" with each song's artist in its name.
   */
  function plexName(release, track, ext, opts) {
    opts = opts || {};
    var safe = opts.safeName || function (s) { return String(s); };
    var comp = release.compilation || (release.artistIds || []).indexOf(VARIOUS) >= 0;
    var who = comp ? 'Various Artists' : release.artist;
    var year = opts.year === false ? 0 : (release.group && /^\d{4}/.test(release.group.firstDate || '') ? +release.group.firstDate.slice(0, 4) : release.year);
    var albumDir = release.title + (year ? ' (' + year + ')' : '');
    var num = (track.discTotal > 1 ? track.disc + '-' : '') + pad2(track.position);
    var song = comp || (track.artist && norm(track.artist) !== norm(release.artist)) ? (comp ? track.artist + ' - ' : '') + track.title : track.title;
    return { folder: ['Music', safe(who), safe(albumDir)], file: safe(num + ' - ' + song).slice(0, 140) + '.' + ext };
  }
  /** The tags a file gets (flat, as tags.writeTo takes them). opts: { genres: bool } */
  function tagsFor(release, track, opts) {
    opts = opts || {};
    var v = {
      title: track.title, artists: [track.artist || release.artist], artistsSort: [track.artistSort || release.artistSort || ''],
      album: release.title, albumArtists: [release.compilation ? 'Various Artists' : release.artist], albumArtistsSort: [release.compilation ? 'Various Artists' : release.artistSort || ''],
      track: track.position, trackTotal: track.trackTotal, disc: track.disc, discTotal: track.discTotal,
      year: release.year || (release.group && /^\d{4}/.test(release.group.firstDate || '') ? +release.group.firstDate.slice(0, 4) : 0),
      compilation: !!release.compilation,
      'mb.release': release.id, 'mb.releaseGroup': (release.group && release.group.id) || '', 'mb.recording': track.recording || '',
      'mb.artist': (track.artistIds || release.artistIds || []).join('/'), 'mb.albumArtist': (release.artistIds || []).join('/'),
      'mb.country': release.country || '', 'mb.status': (release.status || '').toLowerCase(), 'mb.type': ((release.group && release.group.primaryType) || '').toLowerCase()
    };
    if (opts.genres && release.genres && release.genres.length) v.genres = release.genres.slice(0, 3).map(function (g) { return g.replace(/\b\w/g, function (c) { return c.toUpperCase(); }); });
    return v;
  }
  var LABELS = { title: 'Title', artists: 'Artist', album: 'Album', albumArtists: 'Album artist', track: 'Track', disc: 'Disc', year: 'Year', genres: 'Genre', compilation: 'Compilation', 'mb.release': 'MusicBrainz link' };
  /** Before → after, for the fields people care about (only those that change are `changed`). */
  function tagDiff(old, next) {
    var o = old && old.ok ? old : { artists: [], albumArtists: [], genres: [], mb: {} };
    var val = function (k, src, isNew) {
      if (k === 'track') return src.track ? src.track + (src.trackTotal ? ' of ' + src.trackTotal : '') : '';
      if (k === 'disc') return src.disc ? src.disc + (src.discTotal ? ' of ' + src.discTotal : '') : '';
      if (k === 'compilation') return src.compilation ? 'Yes' : 'No';
      if (k === 'mb.release') { // in words: which edition the file is linked to
        var id = isNew ? src['mb.release'] : src.mb && src.mb.release;
        return !id ? '' : id === next['mb.release'] ? 'This edition' : 'Another edition';
      }
      var x = src[k];
      return Array.isArray(x) ? x.filter(Boolean).join('; ') : x ? String(x) : '';
    };
    return Object.keys(LABELS).filter(function (k) { return k !== 'genres' || next.genres; }).map(function (k) {
      var b = val(k, o, false), a = val(k, next, true);
      return { field: k, label: LABELS[k], before: b, after: a, changed: b !== a };
    });
  }

  var api = {
    AUDIO_EXT: AUDIO_EXT, LYRICS_EXT: LYRICS_EXT, VARIOUS: VARIOUS,
    norm: norm, sim: sim, artistSim: artistSim, parseTrackName: parseTrackName, groupAlbums: groupAlbums, tracksOf: tracksOf,
    assign: assign, searchScore: searchScore, rankReleases: rankReleases, pickHome: pickHome, lookAlbum: lookAlbum, plainTitle: plainTitle, releaseFromTags: releaseFromTags, lookLocal: lookLocal,
    plexName: plexName, tagsFor: tagsFor, tagDiff: tagDiff
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShelfMusic = api;
})(this);
