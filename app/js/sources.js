/*
 * Shelf — data sources.
 * Movies: TMDB (needs the user's own free key, kept only in their browser).
 * TV episodes: TVmaze (free, no key).
 */
(function (root) {
  'use strict';

  var cache = {}; // lives only in memory; gone when the tab closes

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
    'api.tvmaze.com': { parallel: 4, max: 19, windowMs: 10000, margin: 400 }
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

  function friendlyNetworkError(host, err) {
    var name = host.indexOf('tvmaze') >= 0 ? 'TVmaze' : 'TMDB';
    var why = err && err.name === 'AbortError' ? 'it took too long to answer' : 'the connection was blocked or failed';
    var e = new Error('Couldn’t reach ' + name + ' (' + why + '). Check your internet, or whether an ad-blocker, antivirus or firewall is blocking ' + host + '.');
    e.code = 'network';
    return e;
  }

  function fetchWithTimeout(url, headers) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    // No cookies, no referrer: the services learn nothing about where the request came from.
    return fetch(url, { headers: headers || {}, credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', signal: ctrl ? ctrl.signal : undefined })
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
        if (r.status === 401) { var e = new Error('TMDB rejected the key. Check it in Settings.'); e.code = 'auth'; throw e; }
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
      url: safeUrl(show.url, ['https://www.tvmaze.com/'])
    };
  }

  function searchShows(title) {
    // "The Office", "the office" and "THE OFFICE" are one request, shared by every episode.
    var q = String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return getJSON(TVMAZE + '/search/shows?q=' + encodeURIComponent(q))
      .then(function (j) { return (j || []).slice(0, 8).map(function (r) { return showToCandidate(r.show, r.score); }); });
  }

  /**
   * Find one episode. One request per show (cached), then every episode file of that show
   * is looked up locally, so a whole season costs a single request.
   * want: { season, episode } or { airdate: 'YYYY-MM-DD' }. Season 0 = specials, in air order.
   */
  function getEpisode(showId, want) {
    return getJSON(TVMAZE + '/shows/' + parseInt(showId, 10) + '/episodes?specials=1')
      .then(function (list) {
        list = list || [];
        var ep = null;
        if (want.airdate) {
          ep = list.filter(function (e) { return e.airdate === want.airdate && e.number != null; })[0] ||
               list.filter(function (e) { return e.airdate === want.airdate; })[0];
        } else {
          var s = parseInt(want.season, 10), n = parseInt(want.episode, 10);
          if (s === 0) {
            var specials = list.filter(function (e) { return e.number == null || e.season === 0; });
            ep = specials.filter(function (e) { return e.season === 0 && e.number === n; })[0] || specials[n - 1] || null;
            if (ep) return { name: String(ep.name || ''), airdate: ep.airdate, season: 0, number: n };
          } else {
            ep = list.filter(function (e) { return e.season === s && e.number === n; })[0];
          }
        }
        if (!ep) return null;
        var out = { name: String(ep.name || ''), airdate: ep.airdate, season: ep.season, number: ep.number };
        if (want.episodeEnd) {
          var last = list.filter(function (e) { return e.season === ep.season && e.number === parseInt(want.episodeEnd, 10); })[0];
          if (last && last.name && last.name !== ep.name) {
            // "Part 1" + "Part 2" → "Title"; otherwise "First & Second"
            var a = out.name.replace(/\s*\(\d+\)$|,?\s*Part\s*(\d+|One|I)$/i, ''), b = last.name.replace(/\s*\(\d+\)$|,?\s*Part\s*(\d+|Two|II)$/i, '');
            out.name = a === b ? a : out.name + ' & ' + last.name;
          }
        }
        return out;
      });
  }

  root.ShelfSources = {
    searchMovies: searchMovies,
    testTmdbKey: testTmdbKey,
    searchShows: searchShows,
    getEpisode: getEpisode
  };
})(this);
