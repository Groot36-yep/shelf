/*
 * Shelf — data sources.
 * Movies: TMDB (needs the user's own free key, kept only in their browser).
 * TV episodes: TVmaze (free, no key).
 */
(function (root) {
  'use strict';

  var cache = {};
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Small polite queue so we never hammer either service.
  var queue = Promise.resolve();
  var GAP_MS = 260; // ~4 requests/second, well under TVmaze's 20 per 10 s.
  function enqueue(fn) {
    var p = queue.then(fn);
    queue = p.catch(function () {}).then(function () { return wait(GAP_MS); });
    return p;
  }

  function getJSON(url, headers, attempt) {
    attempt = attempt || 0;
    if (cache[url]) return Promise.resolve(cache[url]);
    return enqueue(function () {
      return fetch(url, { headers: headers || {} });
    }).then(function (res) {
      if (res.status === 429 && attempt < 3) {
        return wait(1500 * (attempt + 1)).then(function () { return getJSON(url, headers, attempt + 1); });
      }
      if (res.status === 404) return null;
      if (res.status === 401) { var e = new Error('TMDB rejected the key. Check it in Settings.'); e.code = 'auth'; throw e; }
      if (!res.ok) throw new Error('Lookup failed (' + res.status + ')');
      return res.json().then(function (j) { cache[url] = j; return j; });
    });
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
      id: m.id,
      title: m.title,
      altTitle: m.original_title,
      year: year,
      popularity: m.popularity || 0,
      poster: m.poster_path ? TMDB_IMG + m.poster_path : null,
      overview: m.overview || '',
      url: 'https://www.themoviedb.org/movie/' + m.id
    };
  }

  function searchMovies(title, year, key) {
    if (!key) { var e = new Error('Add your free TMDB key in Settings to match movies.'); e.code = 'nokey'; return Promise.reject(e); }
    return tmdbRequest('/search/movie', { query: title, primary_release_year: year || '', include_adult: 'false' }, key)
      .then(function (j) {
        var results = (j && j.results) || [];
        if (!results.length && year) {
          return tmdbRequest('/search/movie', { query: title, include_adult: 'false' }, key).then(function (j2) { return (j2 && j2.results) || []; });
        }
        // Also fetch the no-year search so remakes show up as alternatives.
        if (year) {
          return tmdbRequest('/search/movie', { query: title, include_adult: 'false' }, key).then(function (j2) {
            var seen = {};
            return results.concat((j2 && j2.results) || []).filter(function (m) { if (seen[m.id]) return false; seen[m.id] = 1; return true; });
          });
        }
        return results;
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
      id: show.id,
      title: show.name,
      altTitle: '',
      year: year,
      popularity: (show.weight || 0) + (searchScore || 0) * 10,
      poster: show.image ? (show.image.medium || show.image.original).replace(/^http:/, 'https:') : null,
      overview: (show.summary || '').replace(/<[^>]+>/g, ''),
      network: (show.network && show.network.name) || (show.webChannel && show.webChannel.name) || '',
      url: show.url
    };
  }

  function searchShows(title) {
    return getJSON(TVMAZE + '/search/shows?q=' + encodeURIComponent(title))
      .then(function (j) { return (j || []).slice(0, 8).map(function (r) { return showToCandidate(r.show, r.score); }); });
  }

  function getEpisode(showId, season, episode) {
    return getJSON(TVMAZE + '/shows/' + showId + '/episodebynumber?season=' + season + '&number=' + episode)
      .then(function (ep) {
        if (!ep) return null;
        return { name: ep.name, airdate: ep.airdate, runtime: ep.runtime, url: ep.url };
      });
  }

  root.ShelfSources = {
    searchMovies: searchMovies,
    testTmdbKey: testTmdbKey,
    searchShows: searchShows,
    getEpisode: getEpisode
  };
})(this);
