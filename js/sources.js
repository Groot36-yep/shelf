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
  // TMDB allows ~40 requests/second; TVmaze allows 20 per 10 seconds.
  var limits = {
    'api.themoviedb.org': { parallel: 6, gapMs: 25, active: 0, waiting: [], last: 0 },
    'api.tvmaze.com': { parallel: 2, gapMs: 520, active: 0, waiting: [], last: 0 }
  };
  function slot(host) {
    var L = limits[host];
    return new Promise(function (resolve) { L.waiting.push(resolve); pump(L); });
  }
  function pump(L) {
    if (!L.waiting.length || L.active >= L.parallel) return;
    var delay = Math.max(0, L.last + L.gapMs - Date.now());
    if (delay) { if (!L.timer) L.timer = setTimeout(function () { L.timer = null; pump(L); }, delay); return; }
    L.active++; L.last = Date.now();
    var go = L.waiting.shift();
    go(function release() { L.active--; pump(L); });
    pump(L);
  }

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
        if (r.status === 429 && n < 3) return wait(2000 * (n + 1)).then(function () { return attempt(n + 1); });
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
      poster: show.image ? safeUrl(show.image.medium || show.image.original, ['https://static.tvmaze.com/']) : null,
      overview: (show.summary || '').replace(/<[^>]+>/g, ''),
      network: (show.network && show.network.name) || (show.webChannel && show.webChannel.name) || '',
      url: safeUrl(show.url, ['https://www.tvmaze.com/'])
    };
  }

  function searchShows(title) {
    return getJSON(TVMAZE + '/search/shows?q=' + encodeURIComponent(title))
      .then(function (j) { return (j || []).slice(0, 8).map(function (r) { return showToCandidate(r.show, r.score); }); });
  }

  function getEpisode(showId, season, episode) {
    // One request per show (cached), then every episode file is looked up locally.
    return getJSON(TVMAZE + '/shows/' + parseInt(showId, 10) + '/episodes?specials=1')
      .then(function (list) {
        var s = parseInt(season, 10), n = parseInt(episode, 10);
        var ep = (list || []).filter(function (e) { return e.season === s && e.number === n; })[0];
        if (!ep) return null;
        return { name: String(ep.name || ''), airdate: ep.airdate };
      });
  }

  root.ShelfSources = {
    searchMovies: searchMovies,
    testTmdbKey: testTmdbKey,
    searchShows: searchShows,
    getEpisode: getEpisode
  };
})(this);
