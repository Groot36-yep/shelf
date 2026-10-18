/*
 * Shelf — data sources.
 * Movies: TMDB (needs the user's own free key, kept only in their browser).
 * TV episodes: TVmaze (free, no key).
 */
(function (root) {
  'use strict';

  var cache = {}; // the services' raw answers, in memory only; gone when Shelf closes

  // Only ever use links and images that point where we expect.
  function safeUrl(u, allowed) {
    if (typeof u !== 'string') return null;
    u = u.replace(/^http:\/\//, 'https://');
    return allowed.some(function (prefix) { return u.indexOf(prefix) === 0; }) ? u : null;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // One polite line per service, so a slow or blocked service never holds up the other.
  // Each follows the service's published limit exactly: at most `max` requests in any
  // `windowMs` stretch. Small batches go out at once; big ones run at full allowed speed.
  // TVmaze: 20 per 10 seconds. TMDB: about 40 per second.
  var limits = {
    'api.themoviedb.org': { parallel: 8, max: 35, windowMs: 1000, margin: 60 },
    'api.tvmaze.com': { parallel: 4, max: 19, windowMs: 10000, margin: 400 },
    'api4.thetvdb.com': { parallel: 6, max: 20, windowMs: 1000, margin: 60 }
  };
  Object.keys(limits).forEach(function (h) { var L = limits[h]; L.active = 0; L.waiting = []; L.sent = []; L.pauseUntil = 0; });
  function slot(host) {
    var L = limits[host];
    return new Promise(function (resolve) { L.waiting.push(resolve); pump(L); });
  }
  function pump(L) {
    var now = Date.now();
    // (+ a small margin, because the service's clock starts when the request arrives, not when it's sent)
    while (L.sent.length && now - L.sent[0] >= L.windowMs + L.margin) L.sent.shift();
    while (L.waiting.length && L.active < L.parallel && L.sent.length < L.max && now >= L.pauseUntil) {
      L.sent.push(now); L.active++;
      L.waiting.shift()(function release() { L.active--; pump(L); });
    }
    if (L.waiting.length && L.active < L.parallel && !L.timer) {
      var wait = Math.max(L.pauseUntil - now, L.sent.length >= L.max ? L.sent[0] + L.windowMs + L.margin - now : 0);
      L.timer = setTimeout(function () { L.timer = null; pump(L); }, Math.max(5, wait + 5));
    }
  }
  // Told to slow down (HTTP 429): pause that service for a moment.
  function backOff(host) { var L = limits[host]; if (L) L.pauseUntil = Math.max(L.pauseUntil, Date.now() + 2000); }

  var TIMEOUT_MS = 15000;
  var inflight = {}; // the same request asked twice at once is only sent once

  function serviceName(host) { return host.indexOf('tvmaze') >= 0 ? 'TVmaze' : host.indexOf('thetvdb') >= 0 ? 'TheTVDB' : 'TMDB'; }
  function friendlyNetworkError(host, err) {
    var name = serviceName(host);
    var why = err && err.name === 'AbortError' ? 'it took too long to answer' : 'the connection was blocked or failed';
    var e = new Error('Couldn’t reach ' + name + ' (' + why + '). Check your internet, or whether an ad-blocker, antivirus or firewall is blocking ' + host + '.');
    e.code = 'network';
    return e;
  }

  function fetchWithTimeout(url, headers, body) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    // No cookies, no referrer: the services learn nothing about where the request came from.
    var opts = { headers: headers || {}, credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', signal: ctrl ? ctrl.signal : undefined };
    if (body) { opts.method = 'POST'; opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
    return fetch(url, opts)
      .then(function (res) {
        if (!res.ok) return { status: res.status };
        return res.json().then(function (j) { return { status: res.status, json: j }; });
      })
      .then(function (r) { clearTimeout(timer); return r; }, function (err) { clearTimeout(timer); throw err; });
  }

  function getJSON(url, headers) {
    if (cache[url]) return Promise.resolve(cache[url]);
    if (inflight[url]) return inflight[url];
    var host = url.split('/')[2];
    var p = (function attempt(n) {
      return slot(host).then(function (release) {
        return fetchWithTimeout(url, headers).then(function (r) { release(); return r; }, function (err) { release(); throw err; });
      }).then(function (r) {
        if (r.status === 429 && n < 3) { backOff(host); return wait(1500 * (n + 1)).then(function () { return attempt(n + 1); }); }
        if (r.status === 404) return null;
        if (r.status === 401) { var e = new Error(serviceName(host) + ' rejected the key. Check it in Settings.'); e.code = 'auth'; e.host = host; throw e; }
        if (r.status >= 400 || !r.json) { var e2 = new Error('Lookup failed (error ' + r.status + '). Try again in a moment.'); e2.code = 'server'; throw e2; }
        cache[url] = r.json;
        return r.json;
      }, function (err) {
        if (n < 1) return wait(1000).then(function () { return attempt(n + 1); }); // one retry for a blip
        throw friendlyNetworkError(host, err);
      });
    })(0);
    inflight[url] = p;
    p.then(function () { delete inflight[url]; }, function () { delete inflight[url]; });
    return p;
  }

  // ---------- Remembered lookups (kept on this computer, see remember.js) ----------
  // Searches are remembered for 30 days (a day when nothing was found), episode lists for a week
  // (a day while the show is still airing). What's remembered is the tidy answer Shelf uses, under
  // a name like "tvmaze:search:lost": never your keys.
  var store = root.ShelfRemember ? root.ShelfRemember.open() : null;
  var asked = {}; // this session: name → Promise<{ v, at }>
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function unwrap(r) {
    var v = clone(r.v);
    // An answer remembered from an earlier session says so (an episode list can then be checked afresh).
    if (r.at && v && typeof v === 'object') Object.defineProperty(v, 'rememberedAt', { value: r.at });
    return v;
  }
  function remembered(name, days, look, fresh) {
    if (!fresh && asked[name]) return asked[name].then(unwrap);
    var p = (store && !fresh ? store.get(name) : Promise.resolve(null)).then(function (hit) {
      if (hit) return hit;
      return look().then(function (v) {
        if (store) store.set(name, v, days(v));
        return { v: v, at: null };
      });
    });
    asked[name] = p;
    p.catch(function () { if (asked[name] === p) delete asked[name]; });
    return p.then(unwrap);
  }
  function searchDays(list) { return list && list.length ? 30 : 1; }
  function episodeDays(list) {
    var recent = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
    return (list || []).some(function (e) { return e.aired && e.aired >= recent; }) ? 1 : 7;
  }
  /** Forget every remembered lookup (and this session's answers), so everything is asked afresh. */
  function forgetRemembered() {
    asked = {}; cache = {};
    return store ? store.clear() : Promise.resolve();
  }
  /** For tests: use this store instead of the window's own. */
  function rememberIn(s) { store = s; asked = {}; cache = {}; }

  // ---------- TMDB ----------
  var TMDB = 'https://api.themoviedb.org/3';
  var TMDB_IMG = 'https://image.tmdb.org/t/p/w342';

  function tmdbRequest(path, params, key) {
    key = (key || '').trim();
    var qs = Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); });
    var headers = { accept: 'application/json' };
    // A "Read Access Token" is a long JWT (starts with eyJ); the short one is the v3 API key.
    if (key.indexOf('eyJ') === 0) headers.Authorization = 'Bearer ' + key;
    else qs.push('api_key=' + encodeURIComponent(key));
    return getJSON(TMDB + path + '?' + qs.join('&'), headers);
  }

  function tmdbToCandidate(m) {
    var year = m.release_date ? parseInt(m.release_date.slice(0, 4), 10) : null;
    return {
      type: 'movie',
      source: 'TMDB',
      id: parseInt(m.id, 10),
      title: String(m.title || ''),
      altTitle: String(m.original_title || ''),
      year: year,
      popularity: m.popularity || 0,
      poster: /^\/[A-Za-z0-9_.-]+$/.test(m.poster_path || '') ? TMDB_IMG + m.poster_path : null,
      overview: m.overview || '',
      url: 'https://www.themoviedb.org/movie/' + parseInt(m.id, 10)
    };
  }

  function searchMovies(title, year, key) {
    if (!key) { var e = new Error('Add your free TMDB key in Settings to match movies.'); e.code = 'nokey'; return Promise.reject(e); }
    return remembered('tmdb:movies:' + title + ':' + (year || ''), searchDays, function () { return lookMovies(title, year, key); });
  }
  function lookMovies(title, year, key) {
    // Fast path: ONE search without the year returns every version (originals and remakes),
    // and Shelf picks the year itself. Only if the year isn't among them, ask once more with it.
    return tmdbRequest('/search/movie', { query: title, include_adult: 'false' }, key)
      .then(function (j) {
        var results = (j && j.results) || [];
        var hasYear = !year || results.some(function (m) { return Math.abs(parseInt((m.release_date || '').slice(0, 4), 10) - year) <= 1; });
        if (hasYear) return results;
        return tmdbRequest('/search/movie', { query: title, primary_release_year: year, include_adult: 'false' }, key).then(function (j2) {
          var seen = {};
          return ((j2 && j2.results) || []).concat(results).filter(function (m) { if (seen[m.id]) return false; seen[m.id] = 1; return true; });
        });
      })
      .then(function (results) { return results.slice(0, 12).map(tmdbToCandidate); });
  }

  // A movie named by its TMDB id ("The Matrix (1999) {tmdb-603}"): no search needed.
  function movieById(id, key) {
    id = parseInt(id, 10);
    if (!key || !(id > 0)) return Promise.resolve([]);
    return remembered('tmdb:movie:' + id, searchDays, function () {
      return tmdbRequest('/movie/' + id, {}, key).then(function (j) { return j && j.id ? [tmdbToCandidate(j)] : []; });
    }).then(byId);
  }
  function byId(list) { (list || []).forEach(function (c) { c.byId = true; }); return list || []; }

  function testTmdbKey(key) {
    return tmdbRequest('/configuration', {}, key).then(function () { return true; });
  }

  // ---------- TVmaze ----------
  var TVMAZE = 'https://api.tvmaze.com';

  function showToCandidate(show, searchScore) {
    var year = show.premiered ? parseInt(show.premiered.slice(0, 4), 10) : null;
    return {
      type: 'episode',
      source: 'TVmaze',
      id: parseInt(show.id, 10),
      title: String(show.name || ''),
      altTitle: '',
      year: year,
      popularity: (show.weight || 0) + (searchScore || 0) * 10,
      weight: typeof show.weight === 'number' ? show.weight : null,
      country: ((show.network && show.network.country) || (show.webChannel && show.webChannel.country) || {}).code || null,
      poster: show.image ? safeUrl(show.image.medium || show.image.original, ['https://static.tvmaze.com/']) : null,
      overview: (show.summary || '').replace(/<[^>]+>/g, ''),
      network: (show.network && show.network.name) || (show.webChannel && show.webChannel.name) || '',
      tvdbId: show.externals && parseInt(show.externals.thetvdb, 10) || null,
      url: safeUrl(show.url, ['https://www.tvmaze.com/'])
    };
  }

  function searchShows(title) {
    // "The Office", "the office" and "THE OFFICE" are one request, shared by every episode.
    var q = String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return remembered('tvmaze:search:' + q, searchDays, function () {
      return getJSON(TVMAZE + '/search/shows?q=' + encodeURIComponent(q))
        .then(function (j) { return (j || []).slice(0, 8).map(function (r) { return showToCandidate(r.show, r.score); }); });
    });
  }

  // ---------- Episode lists (one shape for every service) ----------
  // [{ season, number, name, aired, runtime }] — number is null for TVmaze's unnumbered specials.
  function tvmazeEpisodes(showId) {
    return getJSON(TVMAZE + '/shows/' + parseInt(showId, 10) + '/episodes?specials=1').then(function (list) {
      return (list || []).map(function (e) {
        return { season: e.number == null ? 0 : e.season, number: e.number == null ? null : e.number, name: String(e.name || ''), aired: e.airdate || '', runtime: e.runtime || null };
      });
    });
  }

  // ---------- TMDB TV (the order Plex uses by default) ----------
  function tmdbShowToCandidate(m) {
    var year = m.first_air_date ? parseInt(m.first_air_date.slice(0, 4), 10) : null;
    return {
      type: 'episode', source: 'TMDB', id: parseInt(m.id, 10),
      title: String(m.name || ''), altTitle: String(m.original_name || ''), year: year,
      popularity: m.popularity || 0, weight: null,
      country: (m.origin_country && m.origin_country[0]) || null,
      poster: /^\/[A-Za-z0-9_.-]+$/.test(m.poster_path || '') ? TMDB_IMG + m.poster_path : null,
      overview: m.overview || '', network: '',
      url: 'https://www.themoviedb.org/tv/' + parseInt(m.id, 10)
    };
  }
  function searchShowsTmdb(title, key) {
    if (!key) { var e = new Error('Add your free TMDB key in Settings, or choose TheTVDB order.'); e.code = 'nokey'; return Promise.reject(e); }
    var q = String(title).toLowerCase().trim();
    return remembered('tmdb:tvsearch:' + q, searchDays, function () {
      return tmdbRequest('/search/tv', { query: q, include_adult: 'false' }, key)
        .then(function (j) { return ((j && j.results) || []).slice(0, 10).map(tmdbShowToCandidate); });
    });
  }
  // One request gets the show and up to 19 seasons (TMDB's append_to_response), so most shows cost 1 request.
  function tmdbShowPage(id, from, key) {
    var seasons = []; for (var n = from; n < from + 19; n++) seasons.push('season/' + n);
    return tmdbRequest('/tv/' + id, { append_to_response: seasons.join(',') }, key);
  }
  function tmdbEpisodes(showId, key) {
    var id = parseInt(showId, 10);
    function batch(from) { return tmdbShowPage(id, from, key); }
    return batch(0).then(function (j) {
      var count = (j && j.number_of_seasons) || 0;
      var more = [];
      for (var f = 19; f <= count; f += 19) more.push(batch(f));
      return Promise.all(more).then(function (rest) { return [j].concat(rest); });
    }).then(function (pages) {
      var out = [];
      pages.forEach(function (j) {
        Object.keys(j || {}).forEach(function (k) {
          if (!/^season\/\d+$/.test(k) || !j[k] || !j[k].episodes) return;
          j[k].episodes.forEach(function (e) {
            out.push({ season: e.season_number, number: e.episode_number, name: String(e.name || ''), aired: e.air_date || '', runtime: e.runtime || null });
          });
        });
      });
      return out.sort(function (a, b) { return a.season - b.season || a.number - b.number; });
    });
  }

  // ---------- TheTVDB ----------
  var TVDB = 'https://api4.thetvdb.com/v4';
  var tvdbAuth = { key: '', pin: '', token: null, pending: null };
  var COUNTRY3 = { usa: 'US', gbr: 'GB', can: 'CA', aus: 'AU', nzl: 'NZ', irl: 'IE', jpn: 'JP', kor: 'KR', deu: 'DE', fra: 'FR', esp: 'ES', ita: 'IT', swe: 'SE', dnk: 'DK', nor: 'NO', ind: 'IN', bra: 'BR', mex: 'MX' };

  function tvdbLogin(key, pin) {
    if (!key) { var e = new Error('Add your TheTVDB key in Settings to use TheTVDB.'); e.code = 'nokey'; return Promise.reject(e); }
    if (tvdbAuth.token && tvdbAuth.key === key && tvdbAuth.pin === (pin || '')) return Promise.resolve(tvdbAuth.token);
    if (tvdbAuth.pending && tvdbAuth.key === key) return tvdbAuth.pending;
    tvdbAuth.key = key; tvdbAuth.pin = pin || ''; tvdbAuth.token = null;
    var body = { apikey: key }; if (pin) body.pin = pin;
    tvdbAuth.pending = slot('api4.thetvdb.com').then(function (release) {
      return fetchWithTimeout(TVDB + '/login', { accept: 'application/json' }, body)
        .then(function (r) { release(); return r; }, function (err) { release(); throw friendlyNetworkError('api4.thetvdb.com', err); });
    }).then(function (r) {
      tvdbAuth.pending = null;
      var token = r.json && r.json.data && r.json.data.token;
      if (!token) { var e2 = new Error('TheTVDB didn’t accept that key' + (r.status === 401 ? '' : ' (error ' + r.status + ')') + '. Check it in Settings.'); e2.code = 'auth'; e2.host = 'api4.thetvdb.com'; throw e2; }
      tvdbAuth.token = token; // kept in memory only; it lasts a month, Shelf asks again next launch
      return token;
    }, function (err) { tvdbAuth.pending = null; throw err; });
    return tvdbAuth.pending;
  }
  function tvdbGet(path, key, pin) {
    return tvdbLogin(key, pin).then(function (token) {
      return getJSON(TVDB + path, { accept: 'application/json', Authorization: 'Bearer ' + token }).catch(function (err) {
        if (err.code !== 'auth') throw err;
        tvdbAuth.token = null; // token expired: sign in once more
        return tvdbLogin(key, pin).then(function (t2) { return getJSON(TVDB + path, { accept: 'application/json', Authorization: 'Bearer ' + t2 }); });
      });
    });
  }
  function testTvdbKey(key, pin) { tvdbAuth.token = null; return tvdbLogin(key, pin).then(function () { return true; }); }

  function tvdbToCandidate(r, i) {
    var id = parseInt(r.tvdb_id || r.id, 10);
    var name = (r.translations && r.translations.eng) || r.name || '';
    return {
      type: 'episode', source: 'TheTVDB', id: id, tvdbId: id,
      title: String(name), altTitle: String(r.name || ''), year: parseInt(r.year, 10) || null,
      popularity: 10 - i, weight: null,
      country: COUNTRY3[String(r.country || '').toLowerCase()] || null,
      poster: safeUrl(r.thumbnail || r.image_url, ['https://artworks.thetvdb.com/']),
      overview: (r.overviews && r.overviews.eng) || r.overview || '', network: r.network || '',
      url: r.slug ? 'https://thetvdb.com/series/' + encodeURIComponent(r.slug) : 'https://thetvdb.com/'
    };
  }
  function searchShowsTvdb(title, key, pin) {
    var q = String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return remembered('tvdb:search:' + q, searchDays, function () {
      return tvdbGet('/search?type=series&limit=10&query=' + encodeURIComponent(q), key, pin)
        .then(function (j) { return ((j && j.data) || []).slice(0, 10).map(tvdbToCandidate); });
    });
  }
  // order: 'default' (aired) or 'dvd'. Pages of up to 500 episodes; English names when available.
  function tvdbEpisodes(showId, order, key, pin) {
    var id = parseInt(showId, 10), type = order === 'dvd' ? 'dvd' : 'default';
    var out = [];
    function page(n, lang) {
      return tvdbGet('/series/' + id + '/episodes/' + type + lang + '?page=' + n, key, pin).then(function (j) {
        var eps = (j && j.data && j.data.episodes) || [];
        eps.forEach(function (e) {
          if (e.number == null || e.seasonNumber == null) return;
          out.push({ season: e.seasonNumber, number: e.number, name: String(e.name || ''), aired: e.aired || '', runtime: e.runtime || null });
        });
        var hasNext = (j && j.links && j.links.next) || eps.length >= 500;
        return hasNext && n < 20 ? page(n + 1, lang) : out;
      });
    }
    return page(0, '/eng').then(function (list) {
      if (list.length) return list;
      out = []; return page(0, ''); // no English listing: use the original language
    }, function () { out = []; return page(0, ''); })
      .then(function (list) { return list.sort(function (a, b) { return a.season - b.season || a.number - b.number; }); });
  }

  /**
   * The full episode list of a show, in the order Plex will use.
   * cand: a candidate from searchShows*; keys: { tmdb, tvdb, tvdbPin }; order: 'tmdb' | 'tvdb' | 'tvdbdvd'
   */
  function getEpisodeList(cand, keys, opts) {
    var id = parseInt(cand.id, 10), dvd = keys.order === 'tvdbdvd' ? 'dvd' : 'default';
    var name = cand.source === 'TMDB' ? 'tmdb:episodes:' + id : cand.source === 'TheTVDB' ? 'tvdb:episodes:' + id + ':' + dvd : 'tvmaze:episodes:' + id;
    return remembered(name, episodeDays, function () {
      if (cand.source === 'TMDB') return tmdbEpisodes(id, keys.tmdb);
      if (cand.source === 'TheTVDB') return tvdbEpisodes(id, dvd, keys.tvdb, keys.tvdbPin);
      return tvmazeEpisodes(id);
    }, !!(opts && opts.fresh)); // fresh: not an answer remembered from an earlier session
  }

  function tvServiceFor(keys) {
    if (keys.order === 'tmdb' && keys.tmdb) return 'TMDB';
    if ((keys.order === 'tvdb' || keys.order === 'tvdbdvd') && keys.tvdb) return 'TheTVDB';
    return 'TVmaze';
  }
  /** Search shows on the service that matches the chosen Plex order (TVmaze when there's no key). */
  function searchShowsFor(title, keys) {
    var svc = tvServiceFor(keys);
    if (svc === 'TMDB') return searchShowsTmdb(title, keys.tmdb);
    if (svc === 'TheTVDB') return searchShowsTvdb(title, keys.tvdb, keys.tvdbPin);
    return searchShows(title);
  }

  /**
   * A show named by its id in its folder ("Lost {tmdb-4607}", "Lost {tvdb-73739}"), looked up on
   * the service Plex's order uses, without a search. ids: { tmdb, tvdb }. Resolves [] when it
   * can't be looked up that way (Shelf then searches by name as usual).
   */
  function showByIdFor(ids, keys) {
    var svc = tvServiceFor(keys), tmdb = parseInt(ids && ids.tmdb, 10), tvdb = parseInt(ids && ids.tvdb, 10);
    var name = null, look = null;
    if (svc === 'TMDB' && tmdb > 0) {
      // The same request as the first page of its episode list, so the two share one answer.
      name = 'tmdb:tv:' + tmdb;
      look = function () { return tmdbShowPage(tmdb, 0, keys.tmdb).then(function (j) { return j && j.id ? [tmdbShowToCandidate(j)] : []; }); };
    } else if (svc === 'TMDB' && tvdb > 0) {
      name = 'tmdb:tvdb:' + tvdb;
      look = function () {
        return tmdbRequest('/find/' + tvdb, { external_source: 'tvdb_id' }, keys.tmdb)
          .then(function (j) { return ((j && j.tv_results) || []).slice(0, 1).map(tmdbShowToCandidate); });
      };
    } else if (svc === 'TVmaze' && tvdb > 0) {
      name = 'tvmaze:tvdb:' + tvdb;
      look = function () {
        return getJSON(TVMAZE + '/lookup/shows?thetvdb=' + tvdb).then(function (show) { return show && show.id ? [showToCandidate(show, 0)] : []; });
      };
    }
    if (!look) return Promise.resolve([]);
    return remembered(name, searchDays, look).then(byId);
  }

  root.ShelfSources = {
    searchMovies: searchMovies,
    testTmdbKey: testTmdbKey,
    searchShows: searchShows,
    searchShowsFor: searchShowsFor,
    showByIdFor: showByIdFor,
    movieById: movieById,
    getEpisodeList: getEpisodeList,
    testTvdbKey: testTvdbKey,
    forgetRemembered: forgetRemembered,
    rememberIn: rememberIn
  };
})(this);
