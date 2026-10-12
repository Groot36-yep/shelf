/* Shelf — the app window's logic. Files are renamed by the app itself (desktop/fileops.js). */
(function () {
  'use strict';

  var P = window.ShelfParser;
  var S = window.ShelfSources;

  // The bridge to the app (see desktop/preload.js): the only way this window can touch files.
  var native = window.shelfNative;
  document.documentElement.classList.add('native', 'os-' + native.platform);

  // ---------- Preferences (nothing about your files is ever stored) ----------
  function load(key, fallback) {
    try { var v = localStorage.getItem('shelf.' + key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem('shelf.' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }
  var settings = {
    movieIds: load('movieIds', false),
    showYear: load('showYear', false),
    quality: load('quality', false),
    order: load('order', 'tmdb'),      // which episode order Plex uses: tmdb | tvdb | tvdbdvd
    showIds: load('showIds', true),    // {tmdb-387} in show folders
    cardScan: load('cardScan', false), // Advanced: offer "Read Title Cards" (always asks first)
    theme: load('theme', 'studio'),    // the look: studio | seventies (set before drawing by theme-boot.js)
    tvdbKey: '', tvdbPin: '',
    posters: load('posters', true),
    mode: load('mode', 'move'),
    tmdbKey: '' // loaded from the encrypted store at start-up
  };

  // What the lookups need: the keys and the chosen order.
  function keys() { return { tmdb: settings.tmdbKey, tvdb: settings.tvdbKey, tvdbPin: settings.tvdbPin, order: settings.order }; }
  // Which service TV lookups actually go to right now (TVmaze when the chosen one has no key).
  function tvService() {
    if (settings.order === 'tmdb' && settings.tmdbKey) return 'TMDB';
    if (settings.order !== 'tmdb' && settings.tvdbKey) return 'TheTVDB';
    return 'TVmaze';
  }

  function saveKey(key, name) {
    name = name || 'tmdb';
    if (name === 'tmdb') settings.tmdbKey = key; else if (name === 'tvdb') settings.tvdbKey = key; else settings.tvdbPin = key;
    native.setKey(name, key).then(function (stored) {
      if (!stored && key) toast('Your computer’s secure storage isn’t available, so the key is kept only until you close Shelf.');
    });
  }

  // ---------- State ----------
  var items = [];          // see makeItem()
  var selectedId = null;
  var filter = 'all';
  var nextId = 1;

  var SAMPLES = [
    'charade.1963.1080p.bluray.x264-GRP.mkv',
    'Night_of_the_Living_Dead.HD.mov',
    'nosferatu_restored.avi',
    'His Girl Friday 1940 DVDRip.m4v',
    'bonanza.s01e01.a.rose.for.lotta.mkv',
    'bonanza.s01e01.a.rose.for.lotta.en.srt',
    'The.Twilight.Zone.S01E08.720p.mkv'
  ];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ---------- DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'style') n.style.cssText = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function svgArrow() {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'arrow'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M5 12h14M13 6l6 6-6 6');
    s.appendChild(p);
    return s;
  }
  function initials(s) {
    var w = (s || '?').replace(/^(the|a|an)\s+/i, '').split(/\s+/).filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
  }
  var TINTS = ['#FFB27A', '#C9B8FF', '#B8C2CE', '#F5D58A', '#9CC7FF', '#A8E0C0', '#F4A9B8'];
  function tintFor(s) { var h = 0; for (var i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return TINTS[Math.abs(h) % TINTS.length]; }
  function posterNode(cls, url, label) {
    var box = el('div', { class: cls });
    if (url && settings.posters) {
      box.appendChild(el('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
    } else {
      box.style.background = tintFor(label);
      box.textContent = initials(label);
    }
    return box;
  }
  function fmtSize(b) {
    if (!b) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i >= 3 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
  }
  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  // ---------- Items ----------
  function makeItem(name, relPath, size, fullPath, parents) {
    var folders = Array.isArray(parents) ? parents.map(String) : String(relPath || '').split('/').slice(0, -1);
    var parsed = P.parsePath(name, folders);
    var ok = parsed.isVideo || parsed.isSubtitle;
    return {
      id: nextId++, name: name, relPath: relPath || name, size: size || 0, parsed: parsed, fullPath: fullPath || null,
      kind: parsed.kind === 'episode' ? 'episode' : 'movie',
      status: ok ? 'pending' : 'skipped',
      error: ok ? '' : 'Not a video or subtitle file',
      candidates: [], choice: 0, confirmed: false, episode: null
    };
  }

  function current(item) { return item.candidates[item.choice] || null; }

  function matchFor(item) {
    var c = current(item);
    if (!c) return null;
    if (item.kind === 'movie') return { type: 'movie', title: c.title, year: c.year, id: c.id };
    var ep = item.episode;
    var season = ep && ep.season != null ? ep.season : item.parsed.season != null ? item.parsed.season : 1;
    var idTag = !settings.showIds ? '' : c.source === 'TMDB' ? 'tmdb-' + c.id : c.source === 'TheTVDB' ? 'tvdb-' + c.id : c.tvdbId ? 'tvdb-' + c.tvdbId : '';
    return {
      type: 'episode', show: c.title, showYear: c.year, id: c.id, idTag: idTag,
      season: season, episode: ep && ep.number != null ? ep.number : item.parsed.episode || 1,
      episodeEnd: ep ? ep.end : item.parsed.episodeEnd,
      episodeTitle: ep ? ep.name : item.parsed.episodeTitle,
      // Two shows share this name (The Office 2001 / 2005): put the year in the folder so Plex can tell.
      needsYear: item.candidates.some(function (o) { return o !== c && o.id !== c.id && P.titleSimilarity(o.title, c.title) >= 0.99 && o.year !== c.year; })
    };
  }

  // A subtitle uses its video's quality, so the two names still line up for Plex.
  function qualityFor(item) {
    if (!settings.quality) return '';
    var v = linkedVideo(item);
    return P.qualityLabel(v ? v.parsed : item.parsed);
  }

  function plexFor(item) {
    var m = matchFor(item);
    if (!m) return null;
    return P.plexName(item.parsed, m, { movieIds: settings.movieIds, showYear: settings.showYear || m.needsYear, quality: qualityFor(item) });
  }

  function isReady(item) {
    if (item.split && (item.status === 'matched' || item.status === 'review')) return true; // you chose how to split it
    var v = item.linkTo && linkedVideo(item);
    if (v && v.split) return item.status !== 'done' && subSplittable(item) && isReady(v); // cut along with its video
    return !item.epBlock && (item.status === 'matched' || (item.status === 'review' && item.confirmed));
  }
  // Text subtitles (SRT, WebVTT, ASS/SSA) can be cut along with their video; picture ones (IDX/SUB) can't.
  var SUB_SPLIT = ['srt', 'vtt', 'ass', 'ssa'];
  function subSplittable(item) { return item.parsed.isSubtitle && SUB_SPLIT.indexOf(String(item.parsed.ext).toLowerCase()) >= 0; }
  // The split that applies to this file: its own, or (for a subtitle) its video's.
  function splitOf(item) {
    if (item.split) return item.split;
    var v = item.parsed.isSubtitle && item.linkTo && linkedVideo(item);
    return v && v.split && subSplittable(item) ? v.split : null;
  }
  // The names each piece of a split video (or its subtitle) will get.
  function pieceNames(item) {
    var m = matchFor(item);
    var sp = splitOf(item);
    if (!m || !sp) return [];
    return sp.pieces.map(function (pc) {
      var mm = Object.assign({}, m, { season: pc.entry.season, episode: pc.entry.number, episodeEnd: null, episodeTitle: pc.entry.name });
      return P.plexName(item.parsed, mm, { movieIds: settings.movieIds, showYear: settings.showYear || m.needsYear, quality: qualityFor(item) });
    });
  }
  function needsReview(item) {
    var v = item.linkTo && linkedVideo(item);
    if (v && v.split) return false; // goes with its video (split along, or explained in the rename summary)
    return !splitOf(item) && (item.status === 'review' && (!item.confirmed || item.epBlock) || item.status === 'nomatch' || item.status === 'error');
  }

  function addFiles(list) {
    var added = 0;
    list.forEach(function (f) {
      if (/^\./.test(f.name) || /^(thumbs\.db|desktop\.ini)$/i.test(f.name)) return; // hidden/system files
      var keyOf = f.fullPath || f.relPath;
      if (items.some(function (i) { return (i.fullPath || i.relPath) === keyOf; })) return;
      var it = makeItem(f.name, f.relPath, f.size, f.fullPath, f.parents);
      if (it.status === 'skipped' && !/\.(nfo|txt|jpg|jpeg|png|url)$/i.test(f.name)) { items.push(it); added++; return; }
      if (it.status === 'skipped') return; // quietly ignore artwork / nfo files
      items.push(it); added++;
    });
    if (!selectedId && items.length) selectedId = items[0].id;
    render();
    matchAll();
    if (added) toast('Added ' + added + ' file' + (added === 1 ? '' : 's'));
  }

  // ---------- Matching ----------
  var running = 0;
  var networkWarned = false;
  // A subtitle next to a video with the same name ("Film.mkv" + "Film.en.srt") just follows that video's match.
  function stemKey(item) {
    var dir = item.relPath.indexOf('/') >= 0 ? item.relPath.slice(0, item.relPath.lastIndexOf('/')) : '';
    var base = item.name.replace(/\.[^.]+$/, '');
    if (item.parsed.isSubtitle) for (var k = 0; k < 3; k++) base = base.replace(/\.(?:[a-z]{2,3}|forced|sdh|cc|hi)$/i, '');
    return (dir + '/' + base).toLowerCase();
  }
  var subsOf = {}; // video id → its subtitles
  function linkSubtitles() {
    var videos = {};
    subsOf = {};
    items.forEach(function (i) { if (i.parsed.isVideo) videos[stemKey(i)] = i; });
    items.forEach(function (i) {
      if (!i.parsed.isSubtitle || i.unlinked) return;
      var v = videos[stemKey(i)];
      i.linkTo = v ? v.id : null;
      if (v) (subsOf[v.id] = subsOf[v.id] || []).push(i);
    });
  }
  // Fast lookup by id (rebuilt only when the list changes), so big folders stay quick.
  var index = {}, indexOf = null, indexLen = -1;
  function itemById(id) {
    if (indexOf !== items || indexLen !== items.length) {
      index = {}; items.forEach(function (i) { index[i.id] = i; }); indexOf = items; indexLen = items.length;
    }
    return index[id] || null;
  }
  function linkedVideo(item) {
    return item.linkTo ? itemById(item.linkTo) : null;
  }
  function followVideo(video) {
    (subsOf[video.id] || []).forEach(function (sub) {
      if (sub.linkTo !== video.id || sub.status === 'done') return;
      sub.kind = video.kind;
      sub.candidates = video.candidates;
      sub.choice = video.choice;
      sub.episode = video.episode;
      sub.epNote = video.epNote; sub.epBlock = video.epBlock; sub.segmented = video.segmented; sub.showKeyId = video.showKeyId;
      sub.status = video.status === 'pending' ? 'matching' : video.status;
      sub.confirmed = video.confirmed;
      sub.error = video.error;
      sub.needsKey = video.needsKey;
      sub.sent = null;
    });
  }

  function matchAll() {
    linkSubtitles();
    items.filter(function (i) { return i.status === 'pending' && !linkedVideo(i); }).forEach(function (i) { matchItem(i); });
    items.filter(function (i) { return linkedVideo(i); }).forEach(function (i) { followVideo(linkedVideo(i)); });
  }

  // "SpongeBob SquarePants - Reef Blower" (no episode number): is it an episode of that show?
  // Only if the show really has an episode with that title; otherwise it's matched as a movie.
  function tryAsEpisode(alt) {
    return S.searchShowsFor(alt.show, keys()).then(function (cands) {
      var ranked = P.rankCandidates({ title: alt.show, year: null, country: alt.country }, cands);
      var top = ranked[0];
      if (!top || top._sim < 0.9) return null;
      return listFor(top).then(function (list) {
        var m = P.matchByTitle(alt.episodeTitle, list, null);
        return m && m.coverage >= 0.7 ? m : null;
      });
    }).catch(function () { return null; });
  }

  function matchItem(item, query) {
    item.status = 'matching'; item.error = ''; item.confirmed = false;
    running++; scheduleRender();
    var parsed = item.parsed;
    if (!query && item.kind === 'movie' && parsed.altTv && !item.triedTv) {
      item.triedTv = true;
      var alt = parsed.altTv;
      return tryAsEpisode(alt).then(function (m) {
        if (m) {
          var last = m.entries[m.entries.length - 1];
          item.kind = 'episode';
          item.parsed = Object.assign({}, parsed, {
            kind: 'episode', title: alt.show, country: alt.country, year: null, episodeTitle: alt.episodeTitle,
            season: m.season, episode: m.entries[0].number, episodeEnd: last.number > m.entries[0].number ? last.number : null,
            numberFromTitle: true // not evidence of how this show's files are numbered
          });
        }
        running--;
        return matchItem(item);
      });
    }
    var title = query || parsed.title;
    var year = query ? null : parsed.year;
    if (!title) {
      item.status = 'nomatch';
      item.error = item.kind === 'episode'
        ? 'Couldn’t tell which show this is from its name or folder. Type the show name below.'
        : 'Couldn’t read a title from this name. Type it below.';
      running--; scheduleRender();
      return Promise.resolve();
    }
    item.sent = { to: item.kind === 'movie' ? 'TMDB' : tvService(), text: title + (item.kind === 'movie' && year ? ' · ' + year : '') };
    item.epBlock = false; item.epNote = ''; item.episode = null; item.candidates = []; item.choice = 0;
    var lookup;
    if (item.kind === 'movie') {
      lookup = S.searchMovies(title, year, settings.tmdbKey);
    } else {
      lookup = S.searchShowsFor(title, keys());
    }
    return lookup.then(function (cands) {
      var ranked = P.rankCandidates(query ? { title: query, year: null } : parsed, cands);
      // Already picked this show for another episode? Use the same one.
      var known = !query && item.kind === 'episode' && showChoices[showKey(parsed)];
      if (known && known.source !== (ranked[0] && ranked[0].source)) known = null; // order changed since
      if (known) {
        var at = ranked.findIndex(function (r) { return r.id === known.id; });
        if (at < 0) { ranked.unshift(known); at = 0; }
        else ranked.unshift(ranked.splice(at, 1)[0]);
        ranked.ambiguous = false;
        item.confirmed = true;
      }
      item.candidates = ranked.slice(0, 6);
      item.choice = 0;
      if (!ranked.length) {
        item.status = 'nomatch';
        item.error = 'Nothing found for "' + title + '". Try searching by title below.';
        return;
      }
      var top = ranked[0];
      var status = known ? 'review' : top.score >= 78 && !ranked.ambiguous ? 'matched' : 'review';
      var error = ranked.ambiguous ? 'A few titles look alike. Pick the right one below.'
        : status === 'review' ? 'Not sure about this one. Check it below.' : '';
      if (query) { status = 'review'; error = ''; }
      item.showStatus = status; item.showError = error; item.showAmbiguous = !!(ranked.ambiguous && !known);
      // A TV file only counts as matched once its episode is worked out too.
      if (item.kind === 'episode') return loadEpisode(item).then(function () { if (item.status === 'matching') { item.status = 'review'; applyStatus(item); } });
      item.status = status; item.error = error;
    }).catch(function (err) {
      item.status = 'error';
      item.error = err.message || 'Lookup failed';
      if (err.code === 'nokey' || err.code === 'auth') item.needsKey = true;
      if (err.code === 'network' && !networkWarned) { networkWarned = true; toast(err.message); }
    }).then(function () {
      running--; followVideo(item); scheduleRender();
    });
  }

  // ---------- Episodes ----------
  // Each show's full episode list is fetched once (in the order Plex uses), then every file of
  // that show is worked out together: titles first, then numbers — read as single cartoons or
  // as half-hours, depending on how this show's files are numbered.
  var episodeLists = {};   // "TMDB:387:tmdb" → Promise<list>
  var numbering = {};      // "TMDB:387" → 'segments' | 'halfhours', when you've chosen
  function showIdKey(c) { return c.source + ':' + c.id; }
  function listFor(c) {
    var k = showIdKey(c) + ':' + settings.order;
    if (!episodeLists[k]) {
      episodeLists[k] = S.getEpisodeList(c, keys());
      episodeLists[k].catch(function () { delete episodeLists[k]; });
    }
    return episodeLists[k];
  }

  function loadEpisode(item) {
    var c = current(item);
    if (!c) return Promise.resolve();
    return listFor(c).then(function () { return resolveShow(c); }, function (err) {
      item.episode = null; item.epBlock = false;
      item.epNote = 'Couldn’t load the episode list (' + (err.message || 'error') + '). The numbers from the file name are used.';
      applyStatus(item);
    });
  }

  function applyStatus(item) {
    if (['error', 'nomatch', 'skipped', 'done', 'pending'].indexOf(item.status) >= 0) return;
    var problem = item.epProblem || '';
    if (item.showAmbiguous && !item.confirmed) { item.status = 'review'; item.error = item.showError; return; }
    if (item.confirmed) { item.status = 'review'; item.error = item.epBlock ? problem : ''; return; }
    item.status = item.showStatus === 'matched' && !problem ? 'matched' : 'review';
    item.error = item.showStatus !== 'matched' && item.showError ? item.showError : problem;
  }

  // What you chose by hand. Episodes that aren't next to each other still have to be split.
  function manualResult(m) {
    var es = m.entries || [m];
    var together = es.every(function (e, k) { return k === 0 || (e.season === es[k - 1].season && e.number === es[k - 1].number + 1); });
    if (together) return { season: m.season, number: m.number, end: m.end || null, name: m.name, how: 'manual', sure: true, note: 'You chose this episode.', entries: es };
    return { season: es[0].season, number: es[0].number, end: null, name: es[0].name, how: 'manual', sure: false, needsSplit: true, entries: es,
      note: 'You chose episodes that aren’t next to each other, so Plex needs a separate file for each.' };
  }
  function resolveShow(c) {
    var id = showIdKey(c);
    return listFor(c).then(function (list) {
      var mine = items.filter(function (i) {
        var cc = current(i);
        return i.kind === 'episode' && !i.linkTo && cc && showIdKey(cc) === id && i.status !== 'done' && i.status !== 'skipped';
      });
      var bySeason = {};
      mine.forEach(function (i) { var sn = i.parsed.season != null ? i.parsed.season : 1; (bySeason[sn] = bySeason[sn] || []).push(i); });
      Object.keys(bySeason).forEach(function (sn) {
        var group = bySeason[sn];
        var det = P.detectNumbering(group.map(function (i) { return i.parsed; }), list, +sn);
        var chosen = numbering[id];
        var ctx = chosen ? { mode: chosen, sure: true, segmented: det.segmented } : det;
        group.forEach(function (i) {
          var allCards = (i.cards || []).concat(markCards(i));
          var fileCtx = Object.assign({}, ctx, { file: { minutes: i.minutes || null, cards: allCards.length ? allCards : null, parts: i.cardParts || null } });
          var r = i.manualEp ? manualResult(i.manualEp) : P.resolveEpisode(i.parsed, list, fileCtx);
          var s = i.parsed.season != null ? i.parsed.season : 1, e = i.parsed.episode || 1;
          i.showKeyId = id;
          i.segmented = !!ctx.segmented;
          i.numberMode = i.minutes && ctx.segmented ? (i.minutes <= 15 ? 'segments' : 'halfhours') : ctx.mode;
          i.numberSure = !!(i.minutes && ctx.segmented) || ctx.sure !== false && !!(chosen || det.sure);
          i.episode = r ? { season: r.season, number: r.number, end: r.end, name: r.name, how: r.how, entries: r.entries || null, needsSplit: !!r.needsSplit } : null;
          i.epNote = r && r.sure ? r.note : '';
          i.epBlock = !!(r && !r.sure);
          i.epProblem = !r ? (i.parsed.airdate ? 'No episode aired on ' + i.parsed.airdate : 'Season ' + s + ', episode ' + e + ' isn\'t listed') + ' for ' + c.title + ' on ' + c.source + '.'
            : !r.sure ? r.note : '';
          applyStatus(i);
          followVideo(i);
        });
      });
      scheduleRender();
    });
  }

  function retryFailed() {
    networkWarned = false;
    items.forEach(function (i) { if (i.status === 'error' && !i.needsKey) i.status = 'pending'; });
    matchAll();
  }

  // Episodes of one show share a key, so picking the show once fixes every episode.
  var showChoices = {};
  function showKey(parsed) {
    return [String(parsed.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), parsed.year || '', parsed.country || ''].join('|');
  }

  function choose(item, index) {
    if (item.linkTo) { item.linkTo = null; item.unlinked = true; } // picking for a subtitle on its own
    item.choice = index;
    item.confirmed = true;
    item.status = 'review';
    item.error = '';
    if (item.kind === 'episode') {
      var picked = item.candidates[index];
      var key = showKey(item.parsed);
      if (picked && item.parsed.title) showChoices[key] = picked;
      // Every other episode of the same show (not picked by hand) follows.
      var siblings = items.filter(function (o) {
        return o !== item && o.kind === 'episode' && !o.linkTo && !o.handPicked && o.status !== 'done' && o.status !== 'skipped' &&
          o.parsed.title && showKey(o.parsed) === key;
      });
      item.handPicked = true;
      [item].concat(siblings).forEach(function (o) {
        if (o !== item) {
          var at = o.candidates.findIndex(function (cd) { return cd.id === picked.id; });
          if (at < 0) { o.candidates = [picked].concat(o.candidates).slice(0, 6); at = 0; }
          o.choice = at; o.confirmed = true; o.status = 'review'; o.error = '';
        }
        o.showAmbiguous = false;
        o.episode = null;
      });
      render();
      loadEpisode(item).then(function () {
        if (siblings.length) toast('Used ' + picked.title + (picked.year ? ' (' + picked.year + ')' : '') + ' for ' + (siblings.length + 1) + ' episodes');
        render();
      });
    } else {
      followVideo(item);
      render();
    }
  }

  // ---------- Rendering ----------
  function tagFor(item) {
    var t;
    if (item.scan === 'queued') return el('span', { class: 'tag tag-queued', text: 'Queued' });
    if (item.scan === 'reading') {
      var pct = Math.round((item.scanFrac || 0) * 100);
      var ring = el('span', { class: 'ring', 'aria-hidden': 'true' }); ring.style.setProperty('--p', pct);
      return el('span', { class: 'tag tag-scan', title: 'Reading title cards' }, [ring, 'Reading ' + pct + '%']);
    }
    if (item.scan === 'done') {
      var ok = item.episode && item.episode.how === 'card';
      return el('span', { class: 'tag ' + (ok ? 'tag-ok' : 'tag-warn') }, [el('span', { class: 'check-pop', text: ok ? '✓' : '?' }), ok ? ' Read' : ' Not sure']);
    }
    switch (item.status) {
      case 'pending': case 'matching':
        t = el('span', { class: 'tag tag-wait' }, [el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Matching']); break;
      case 'matched': t = el('span', { class: 'tag tag-ok', text: (current(item) ? current(item).score : '') + '%' }); break;
      case 'review': t = splitOf(item) ? el('span', { class: 'tag tag-ok', text: '✂ Split' }) : item.confirmed ? el('span', { class: 'tag tag-ok', text: 'Confirmed' }) : el('span', { class: 'tag tag-warn', text: 'Review' }); break;
      case 'nomatch': t = el('span', { class: 'tag tag-warn', text: 'No match' }); break;
      case 'skipped': t = el('span', { class: 'tag tag-wait', text: 'Skipped' }); break;
      case 'done': t = el('span', { class: 'tag tag-ok', text: '✓ Renamed' }); break;
      default: t = el('span', { class: 'tag tag-err', text: item.needsKey ? 'Needs key' : 'Error' });
    }
    return t;
  }

  function renderList() {
    var list = $('list');
    var shown = items.filter(function (i) { return filter === 'all' || needsReview(i); });
    var nodes = [];
    var keep = {};
    shown.forEach(function (item) {
      var c = current(item);
      var plex = plexFor(item);
      var pieces = splitOf(item) ? pieceNames(item) : null;
      // Rows that haven't changed are reused, not rebuilt: keeps long lists smooth.
      var sig = [pieces ? pieces.map(function (x) { return x.file; }).join('+') : '', item.status, item.confirmed, item.needsKey, item.scan || '', Math.round((item.scanFrac || 0) * 50), c ? c.id + ':' + c.score + ':' + (settings.posters ? c.poster : '') : '', plex ? plex.folder.join('/') + '/' + plex.file : '', item.parsed.title].join('|');
      var cached = rowCache[item.id];
      keep[item.id] = 1;
      if (cached && cached.sig === sig) {
        var on = item.id === selectedId;
        cached.node.classList.toggle('is-selected', on);
        cached.node.setAttribute('aria-selected', on ? 'true' : 'false');
        nodes.push(cached.node);
        return;
      }
      var title = c ? c.title : item.parsed.title || item.name;
      var newName = pieces && pieces.length ? pieces.length + ' files: ' + pieces.map(function (x) { return x.file.replace(/\.[^.]+$/, '').replace(/^.* - (S\d+E\d+)/, '$1'); }).join(' + ') : plex ? plex.file : (item.status === 'skipped' ? '—' : item.status === 'matching' || item.status === 'pending' ? 'Looking up “' + (item.parsed.title || item.name) + '”…' : 'Not matched yet');
      var where = plex ? plex.folder.join(' › ') : (item.parsed.kind === 'episode' ? 'TV episode' : item.parsed.isVideo ? 'Movie' : '');
      var sel = item.id === selectedId;
      var row = el('button', {
        type: 'button', class: 'row-item' + (sel ? ' is-selected' : ''), role: 'option', 'aria-selected': sel ? 'true' : 'false',
        'data-id': item.id, onclick: function () { select(item.id); }
      }, [
        posterNode('thumb', c && c.poster, title),
        el('div', { class: 'cell orig-cell' }, [
          el('span', { class: 'orig', text: item.name, title: item.relPath }),
          el('span', { class: 'sub', text: [fmtSize(item.size), P.qualityLabel(item.parsed), item.parsed.isSubtitle ? 'Subtitle' + (item.parsed.lang ? ' · ' + item.parsed.lang.toUpperCase() : '') : ''].filter(Boolean).join(' · ') || ' ' })
        ]),
        svgArrow(),
        el('div', { class: 'cell new-cell' }, [
          el('span', { class: 'newname', text: newName }),
          el('span', { class: 'sub', text: where })
        ]),
        el('div', { class: 'match-cell' }, [tagFor(item)])
      ]);
      if (item.scan === 'reading') row.classList.add('is-scanning');
      if (item.scan === 'queued') row.classList.add('is-queued');
      if (item.scan === 'done') row.classList.add('scan-flash');
      rowCache[item.id] = { sig: sig, node: row };
      nodes.push(row);
    });
    Object.keys(rowCache).forEach(function (id) { if (!keep[id] && !itemById(+id)) delete rowCache[id]; });
    if (!shown.length && items.length) {
      nodes.push(el('p', { class: 'muted center', style: 'padding:40px 0', text: 'Nothing needs review. Everything is matched.' }));
    }
    list.replaceChildren.apply(list, nodes);
  }

  function renderInspector() {
    var item = itemById(selectedId);
    $('inspector').hidden = !item;
    if (!item) return;
    var c = current(item);
    var title = c ? c.title : (item.parsed.title || item.name);

    var poster = $('inspPoster');
    poster.textContent = ''; poster.removeAttribute('style');
    if (c && c.poster && settings.posters) poster.appendChild(el('img', { src: c.poster, alt: 'Poster for ' + c.title, referrerpolicy: 'no-referrer' }));
    else { poster.style.background = tintFor(title); poster.textContent = initials(title); }

    $('inspTitle').textContent = title;
    var meta = [];
    if (item.kind === 'episode') {
      // The show; the episode card below says which episode(s).
      if (c) meta.push(['TV show', c.year, c.network].filter(Boolean).join(' · '));
    } else if (c && c.year) meta.push(String(c.year));
    $('inspMeta').textContent = meta.join(' · ');

    var errBox = $('inspError');
    var src1 = linkedVideo(item) || item;
    // Episode questions are explained in the episode card; don't say them twice.
    errBox.hidden = !item.error || !!src1.split || !!(src1.episode && (src1.episode.needsSplit || item.epBlock)) || item.status === 'done' || !!(item.kind === 'episode' && current(item) && issueFor(item));
    errBox.textContent = item.error;
    if (item.status === 'error' && !item.needsKey) {
      errBox.appendChild(document.createTextNode(' '));
      errBox.appendChild(el('button', { type: 'button', class: 'link-btn', style: 'padding:0', text: 'Try Again', onclick: retryFailed }));
    }
    if (item.needsKey) {
      errBox.appendChild(document.createTextNode(' '));
      errBox.appendChild(el('button', { type: 'button', class: 'link-btn', style: 'padding:0', text: 'Open Settings', onclick: function () { openSheet('settings'); } }));
    }

    var note = $('inspNote');
    note.hidden = !item.epNote || item.epNote === item.error;
    note.textContent = item.epNote || '';
    // The cartoon/half-hour switch only when Shelf isn't sure (or you've used it for this show).
    var segWrap = $('inspSegWrap');
    var showId0 = current(linkedVideo(item) || item) ? showIdKey(current(linkedVideo(item) || item)) : '';
    segWrap.hidden = !(item.kind === 'episode' && item.segmented && !item.split && (!item.numberSure || numbering[showId0]));
    $('inspLookWrap').hidden = !(item.kind === 'episode' && item.segmented && (linkedVideo(item) || item).fullPath);
    $('readCards').hidden = !settings.cardScan;
    $('checkLengths').disabled = $('readCards').disabled = scanning || !item.fullPath;
    document.querySelectorAll('#inspSeg button').forEach(function (b) {
      b.setAttribute('aria-pressed', item.numberSure && b.dataset.mode === item.numberMode ? 'true' : 'false');
    });

    // What Shelf thinks this file is, how it knows, and ways to check or change it.
    var epWrap = $('inspEpWrap');
    var showEp = item.kind === 'episode' && !!current(item);
    epWrap.hidden = !showEp;
    var src0 = linkedVideo(item) || item;
    if (showEp) {
      var list0 = $('inspEpList'); list0.textContent = '';
      var rowsEp = episodeRows(src0, item);
      var how = src0.split ? 'split' : src0.episode ? src0.episode.how : '';
      var sure = !item.epBlock && (item.status === 'matched' || item.confirmed);
      rowsEp.forEach(function (e, i) {
        var thumb = null;
        if (e.card != null && src0.fullPath) {
          thumb = el('button', { type: 'button', class: 'ep-thumb', title: 'The title card Shelf read (' + fmtClock(e.card) + '). Click to open it in Check Episodes.', onclick: function () { openEditor(item); } });
          cardFrame(src0, e.card, 240).then(function (url) { if (url) thumb.appendChild(el('img', { src: url, alt: 'Title card' })); });
        }
        var row = el('div', { class: 'ep-card-row' + (thumb ? ' has-thumb' : ''), 'data-part': src0.split || rowsEp.length > 1 ? i % 2 : '' }, [
          thumb,
          el('span', { class: 'ep-card-txt' }, [
            el('span', { class: 'ep-card-code', text: 'S' + pad2(e.season) + 'E' + pad2(e.number) }),
            el('span', { class: 'ep-card-name', text: e.name || '(no title listed)', title: e.name || '' })
          ]),
          src0.split ? null : el('button', { type: 'button', class: 'ep-change', 'data-opens-browser': '1', id: i === 0 ? 'changeEp' : null, text: 'Change', title: 'Pick a different episode for this', onclick: function (ev) { changeEntry(src0, i, ev.currentTarget); } })
        ]);
        list0.appendChild(row);
      });
      $('inspEpLabel').textContent = src0.split ? 'Will be split into ' + rowsEp.length + ' files' : rowsEp.length > 1 ? 'In this file' : 'This file is';
      var why = {
        split: '✂ You chose to split it. Each part gets its own name.',
        manual: '✓ You chose this.',
        card: '✓ Read from the title cards in the video.',
        title: '✓ Matched by the episode title in the file name.',
        date: '✓ Matched by the air date in the file name.',
        halfhour: 'From the half-hour number in the file name' + (src0.minutes ? ' and the video’s length.' : '.'),
        number: 'From the episode number in the file name.'
      }[how] || 'From the file name.';
      var iss = issueFor(item);
      $('inspEpWhy').textContent = why + (iss || sure || how === 'split' || how === 'manual' || how === 'card' ? '' : settings.cardScan && src0.segmented ? ' To be sure, read the title cards.' : ' Not sure? Check Episodes… shows you the video.');
      $('inspEpWhy').className = 'ep-why' + (/^✓|^✂/.test(why) ? ' is-sure' : '');
      var badge = $('inspEpBadge');
      badge.textContent = iss ? 'Needs a look' : src0.split ? 'Split' : /^✓/.test(why) ? 'Sure' : 'Probably';
      badge.className = 'ep-badge ' + (iss ? 'warn' : /^✓|^✂/.test(why) ? 'ok' : 'maybe');
      $('checkEps').hidden = !src0.fullPath || !src0.parsed.isVideo;
      $('checkEps').textContent = src0.split ? 'Edit Split…' : 'Check Episodes…';
      $('checkEps').disabled = scanning;
      $('clearSplit').hidden = !src0.split;
      // Deep Scan once a quick read has missed a card for this video.
      $('deepScan').hidden = !(canDeep(item) && src0.cards && rowsEp.some(function (e) { return e.card == null; }));
      $('deepScan').disabled = scanning;
    }
    // The problem card.
    var iss1 = showEp ? issueFor(item) : null, issBox = $('inspIssue');
    issBox.hidden = !iss1;
    if (iss1) {
      issBox.className = 'insp-issue ' + iss1.kind;
      $('issueTitle').textContent = iss1.title;
      $('issueText').textContent = iss1.text;
      var acts = $('issueActions'); acts.textContent = '';
      iss1.actions.forEach(function (a, k) { acts.appendChild(el('button', { type: 'button', class: 'pill small-pill' + (k === 0 ? ' pill-primary' : ''), text: a.label, title: a.title || '', onclick: a.run })); });
    }

    var facts = $('inspFacts');
    facts.textContent = '';
    function fact(k, v) { facts.appendChild(el('div', { class: 'fact' }, [el('span', { text: k }), typeof v === 'string' ? el('span', { text: v }) : v])); }
    fact('Type', item.parsed.isSubtitle ? 'Subtitle' : item.kind === 'episode' ? 'TV Episode' : 'Movie');
    if (c) {
      var link = c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer', text: c.source }) : el('span', { text: c.source });
      fact('Source', el('span', {}, [link]));
      var col = c.score >= 78 ? 'var(--green)' : 'var(--orange)';
      fact('Confidence', el('span', {}, [el('span', { class: 'bar' }, [el('i', { style: 'width:' + c.score + '%;background:' + col })]), c.score + '%']));
    }
    var src = linkedVideo(item) || item;
    if (src.minutes) fact('Length', Math.round(src.minutes) + ' min');
    if (src.cards) {
      var ep1 = src.episode;
      var readNames = ep1 && ep1.how === 'card' ? (ep1.entries && ep1.entries.length ? ep1.entries.filter(function (e) { return e.card != null; }).map(function (e) { return e.name; }).join(', ') || ep1.name : ep1.name) : '';
      fact('Title cards', readNames ? 'Read: ' + readNames : src.cards.length ? 'Couldn’t read them clearly' : 'None found');
    }
    var ql = P.qualityLabel(linkedVideo(item) ? linkedVideo(item).parsed : item.parsed);
    if (ql) fact('Quality', ql);
    if (item.sent) fact('Shared with ' + item.sent.to, '“' + item.sent.text + '”');
    if (linkedVideo(item)) fact('Match', 'Follows its video');
    fact('Original', el('span', { style: 'font-family:var(--mono);font-size:11px;overflow-wrap:anywhere', text: item.relPath }));

    var candWrap = $('inspCandWrap'), cands = $('inspCands');
    cands.textContent = '';
    candWrap.hidden = item.candidates.length < 2;
    item.candidates.forEach(function (cd, idx) {
      var on = idx === item.choice;
      cands.appendChild(el('button', {
        type: 'button', class: 'cand' + (on ? ' is-on' : ''), role: 'radio', 'aria-checked': on ? 'true' : 'false',
        onclick: function () { choose(item, idx); }
      }, [
        el('span', { class: 'radio', 'aria-hidden': 'true' }),
        posterNode('cand-thumb', cd.poster, cd.title),
        el('span', { class: 'cand-text' }, [
          el('b', { text: cd.title + (cd.year ? ' (' + cd.year + ')' : '') }),
          el('span', { text: [cd.network, cd.country === 'GB' ? 'UK' : cd.country, cd.score + '% match'].filter(Boolean).join(' · ') })
        ])
      ]));
    });

    var plex = plexFor(item);
    var crumbs = $('inspCrumbs');
    crumbs.textContent = '';
    if (plex) {
      plex.folder.forEach(function (f, i) {
        if (i) crumbs.appendChild(el('span', { class: 'chev', text: '›' }));
        crumbs.appendChild(el('span', { class: 'folder', text: f }));
      });
    }
    $('inspFile').textContent = splitOf(item) ? pieceNames(item).map(function (x) { return x.file; }).join('\n') : plex ? plex.file : 'Pick a match to see the new name.';

    $('searchKind').value = item.kind;
    var si = $('searchInput');
    if (document.activeElement !== si) si.value = '';
    si.placeholder = item.parsed.title ? 'e.g. ' + item.parsed.title : 'Movie or show name';
  }

  var renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    // At most ~8 redraws a second while lots of lookups finish at once.
    setTimeout(function () { renderQueued = false; render(); }, 120);
  }

  function render() {
    var has = items.length > 0;
    $('dropZone').hidden = has;
    $('listWrap').hidden = !has;
    $('filterSeg').hidden = !has;
    $('addBtn').hidden = !has;
    $('clearBtn').hidden = !has;
    var ready = items.filter(isReady).length;
    var review = items.filter(needsReview).length;
    $('renameBtn').disabled = ready === 0;
    $('retryBtn').hidden = !items.some(function (i) { return i.status === 'error' && !i.needsKey; });
    $('reviewCount').textContent = review;
    $('navCount').hidden = !has;
    $('navCount').textContent = items.length;
    var busy = items.filter(function (i) { return i.status === 'matching' || i.status === 'pending'; }).length;
    var done = items.filter(function (i) { return i.status !== 'skipped'; }).length - busy;
    var total = items.filter(function (i) { return i.status !== 'skipped'; }).length;
    $('subtitle').textContent = has ? items.length + ' item' + (items.length === 1 ? '' : 's') + (busy ? ' · matching ' + done + ' of ' + total + '…' : '') : 'No items';
    $('statusText').textContent = has ? ready + ' ready to rename' + (review ? ' · ' + review + ' need' + (review === 1 ? 's' : '') + ' a look' : '') : '';
    document.querySelectorAll('#filterSeg button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.filter === filter ? 'true' : 'false'); });

    var st = $('tmdbStatus');
    st.querySelector('.dot').className = 'dot ' + (settings.tmdbKey ? 'dot-ok' : 'dot-warn');
    st.querySelector('.src-note').textContent = settings.tmdbKey ? 'Ready' : 'Add key';
    var tv = $('tvdbStatus');
    tv.querySelector('.dot').className = 'dot ' + (settings.tvdbKey ? 'dot-ok' : 'dot-warn');
    tv.querySelector('.src-note').textContent = settings.tvdbKey ? 'Ready' : 'Add key';

    if (has) { renderList(); renderInspector(); }
    else $('inspector').hidden = true;
  }

  var rowCache = {};
  function select(id) {
    // Just move the highlight and refresh the side panel; the list itself doesn't change.
    var old = document.querySelector('.row-item.is-selected');
    if (old) { old.classList.remove('is-selected'); old.setAttribute('aria-selected', 'false'); }
    selectedId = id;
    var now = document.querySelector('.row-item[data-id="' + id + '"]');
    if (now) { now.classList.add('is-selected'); now.setAttribute('aria-selected', 'true'); }
    renderInspector();
    var row = document.querySelector('.row-item[data-id="' + id + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  // ---------- Files in ----------
  // The drop itself is read by the app bridge (see preload.js); here we only stop the browser
  // from opening the file, and show what happened.
  function handleDrop(e) {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
  native.onDropFiles(function (r) {
    if (r.state === 'start') { toast('Adding ' + (r.count === 1 ? 'what you dropped' : r.count + ' items') + '…'); return; }
    if (r.state === 'error') { toast('Couldn’t add those: ' + r.message); return; }
    var list = Array.isArray(r.list) ? r.list : [];
    if (!list.length) { toast(r.found ? 'No videos or subtitles in what you dropped.' : 'Couldn’t read where those files are. Try Choose Files… instead.'); return; }
    addFiles(list);
  });

  // ---------- Sheets ----------
  function openSheet(name) {
    var d = $(name + 'Sheet');
    if (name === 'rename') prepareRename();
    if (name === 'settings') {
      $('keyInput').value = settings.tmdbKey;
      $('optIds').checked = settings.movieIds;
      $('optShowYear').checked = settings.showYear;
      $('optQuality').checked = settings.quality;
      $('optShowIds').checked = settings.showIds;
      $('optCardScan').checked = settings.cardScan;
      $('optOrder').value = settings.order;
      $('tvdbInput').value = settings.tvdbKey;
      $('tvdbPinInput').value = settings.tvdbPin;
      syncOrderHelp();
      $('optPosters').checked = settings.posters;
      $('keyStatus').textContent = 'Stored encrypted with your computer account. Only ever sent to TMDB.';
    }
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }

  var MODE_HELP = {
    move: 'Originals move into your library.',
    copy: 'Originals stay where they are; copies go into your library.',
    link: 'No extra disk space. Great for files you keep seeding. Library must be on the same drive.'
  };

  function readyItems() { return items.filter(isReady); }

  function prepareRename() {
    var r = readyItems();
    var movies = r.filter(function (i) { return i.kind === 'movie'; }).length;
    var eps = r.length - movies;
    var waiting = items.filter(needsReview).length;
    $('renameTitle').textContent = 'Rename ' + r.length + ' item' + (r.length === 1 ? '' : 's') + '?';
    $('renameSummary').textContent =
      [movies ? movies + ' movie file' + (movies === 1 ? '' : 's') : '', eps ? eps + ' TV file' + (eps === 1 ? '' : 's') : ''].filter(Boolean).join(' and ') +
      ' will get Plex names.' + (waiting ? ' ' + waiting + ' still need' + (waiting === 1 ? 's' : '') + ' a look and will be left alone.' : '') +
      (function () {
        var sp = r.filter(function (i) { return i.split; }); // videos only (subtitles follow along)
        if (!sp.length) return '';
        var pieces = sp.reduce(function (t, i) { return t + i.split.pieces.length; }, 0);
        var subsOfSplit = items.filter(function (i) { return i.parsed.isSubtitle && i.linkTo && linkedVideo(i) && linkedVideo(i).split && isReady(linkedVideo(i)); });
        var cut = subsOfSplit.filter(isReady).length, left = subsOfSplit.length - cut;
        return ' ' + sp.length + ' video' + (sp.length === 1 ? '' : 's') + ' will be split into ' + pieces + ' files (no re-encoding; originals are kept).' +
          (cut ? ' ' + cut + ' subtitle file' + (cut === 1 ? '' : 's') + ' will be split to match.' : '') +
          (left ? ' ' + left + ' picture subtitle' + (left === 1 ? '' : 's') + ' (IDX/SUB) can’t be split and will be left alone.' : '');
      })();
    syncMode();
    native.getLibrary().then(function (lib) { $('libPath').textContent = lib || 'Not chosen yet'; $('renameNow').disabled = !lib || !r.length; });
    native.canUndo().then(function (yes) { $('undoNow').hidden = !yes; });
    $('renameNow').textContent = 'Rename ' + r.length + ' Now';
  }

  function syncMode() {
    document.querySelectorAll('#modeSeg button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.mode === settings.mode ? 'true' : 'false'); });
    $('modeHelp').textContent = MODE_HELP[settings.mode];
  }

  // ---------- Events ----------
  function on(id, ev, fn) { $(id).addEventListener(ev, fn); }

  // The system's own file pickers hand Shelf the real file locations.
  function pickFiles() { native.pickFiles().then(addFiles); }
  function pickFolder() { native.pickFolder().then(addFiles); }
  on('chooseFiles', 'click', pickFiles);
  on('chooseFolder', 'click', pickFolder);
  {
    on('pickLib', 'click', function () {
      native.pickLibrary().then(function (lib) { if (lib) { $('libPath').textContent = lib; $('renameNow').disabled = !readyItems().length; } });
    });
    on('renameNow', 'click', function () {
      var ready = readyItems();
      var real = ready.filter(function (i) { return i.fullPath; });
      if (!real.length) { toast('Sample files are just examples. Choose your own files to rename them.'); return; }
      var byPath = {};
      var ops = real.map(function (i) {
        byPath[i.fullPath] = i;
        if (splitOf(i)) {
          var names = pieceNames(i);
          return { source: i.fullPath, split: splitOf(i).pieces.map(function (pc, k) { return { start: pc.start, end: pc.end, folder: names[k].folder, file: names[k].file }; }) };
        }
        var p = plexFor(i); return { source: i.fullPath, folder: p.folder, file: p.file };
      });
      var btn = $('renameNow');
      btn.disabled = true;
      var stop = native.onProgress(function (p) { btn.textContent = 'Renaming ' + p.done + ' of ' + p.total + '…'; });
      native.rename(ops, settings.mode).then(function (results) {
        var ok = 0, skipped = 0, failed = 0;
        results.forEach(function (r) {
          var item = byPath[r.source];
          if (!item) return;
          if (r.ok && r.split) { ok++; item.status = 'done'; item.error = (r.subtitle ? 'Subtitles split into ' + r.pieces.length + ' file' + (r.pieces.length === 1 ? '' : 's') + ' to match the video.' : 'Split into ' + r.pieces.length + ' files.') + ' Your original was kept where it was.'; item.newPath = r.to; }
          else if (r.ok && r.to) { ok++; item.status = 'done'; item.error = ''; item.origPath = item.fullPath; if (settings.mode === 'move') item.fullPath = r.to; item.newPath = r.to; }
          else if (r.ok || r.skipped) { skipped++; item.error = r.skipped || ''; }
          else { failed++; item.error = 'Couldn’t rename: ' + r.error; }
        });
        $('renameSheet').close();
        $('undoBar').hidden = !ok;
        render();
        toast('Renamed ' + ok + ' file' + (ok === 1 ? '' : 's') + (skipped ? ', skipped ' + skipped : '') + (failed ? ', ' + failed + ' failed (see details)' : '') + '.');
        if (ok && !failed) celebrate();
      }).catch(function (err) {
        toast(err.message || 'Renaming failed.');
      }).then(function () { stop(); btn.disabled = false; prepareRename(); });
    });
    function undoLast() {
      native.undo().then(function (r) {
        $('undoBar').hidden = true;
        if (r.nothing) { toast('Nothing to undo.'); return; }
        items.forEach(function (i) {
          if (i.status === 'done') { i.status = 'matched'; i.fullPath = i.origPath || i.fullPath; i.newPath = null; }
        });
        $('renameSheet').close();
        toast('Put back ' + r.undone + ' file' + (r.undone === 1 ? '' : 's') + (r.kept ? '. Left ' + r.kept + ' alone that had changed since.' : '.'));
        render();
      });
    }
    on('undoNow', 'click', undoLast);
    on('undoBar', 'click', undoLast);
    native.canUndo().then(function (yes) { $('undoBar').hidden = !yes; });
    on('openLib', 'click', function () { native.showLibrary(); });
  }

  on('sampleBtn', 'click', function () {
    addFiles(SAMPLES.map(function (n) { return { name: n, relPath: n, size: 0 }; }));
    if (!settings.tmdbKey) toast('Movies need a free TMDB key — add it in Settings. TV works right away.');
  });
  on('addBtn', 'click', pickFiles);
  on('retryBtn', 'click', retryFailed);
  // Title-card pictures from your videos are kept only while the video is in the list.
  function dropFrames(list) {
    list.forEach(function (v) {
      Object.keys(v._frames || {}).forEach(function (k) { v._frames[k].then(function (url) { if (url) URL.revokeObjectURL(url); }); });
      v._frames = null;
    });
  }
  on('clearBtn', 'click', function () { dropFrames(items); items = []; showChoices = {}; selectedId = null; filter = 'all'; render(); });
  on('renameBtn', 'click', function () { openSheet('rename'); });
  on('removeBtn', 'click', function () {
    var idx = items.findIndex(function (i) { return i.id === selectedId; });
    if (idx < 0) return;
    dropFrames(items.splice(idx, 1));
    selectedId = items.length ? items[Math.min(idx, items.length - 1)].id : null;
    render();
  });

  document.querySelectorAll('[data-open]').forEach(function (b) {
    b.addEventListener('click', function () { openSheet(b.dataset.open); });
  });
  document.querySelectorAll('#filterSeg button').forEach(function (b) {
    b.addEventListener('click', function () { filter = b.dataset.filter; render(); });
  });
  document.querySelectorAll('#modeSeg button').forEach(function (b) {
    b.addEventListener('click', function () { settings.mode = b.dataset.mode; save('mode', settings.mode); syncMode(); });
  });
  on('searchForm', 'submit', function (e) {
    e.preventDefault();
    var item = itemById(selectedId);
    var q = $('searchInput').value.trim();
    if (!item || !q) return;
    item.kind = $('searchKind').value;
    item.needsKey = false;
    if (item.linkTo) { item.linkTo = null; item.unlinked = true; }
    matchItem(item, q);
  });

  on('keyInput', 'change', function (e) {
    saveKey(e.target.value.trim()); render();
  });
  on('testKey', 'click', function () {
    var key = $('keyInput').value.trim();
    var status = $('keyStatus');
    if (!key) { status.textContent = 'Paste your key first.'; return; }
    status.textContent = 'Checking…';
    S.testTmdbKey(key).then(function () {
      status.textContent = 'It works! Movies will now be matched.';
      saveKey(key); render();
    }).catch(function () { status.textContent = 'TMDB didn\'t accept that key. Copy it again from themoviedb.org → Settings → API.'; });
  });
  on('optPosters', 'change', function (e) { settings.posters = e.target.checked; save('posters', settings.posters); render(); });
  on('forgetKey', 'click', function () {
    saveKey(''); $('keyInput').value = ''; $('keyStatus').textContent = 'Key removed from this computer.'; render();
  });
  on('eraseAll', 'click', function () {
    native.eraseAll();
    dropFrames(items); items = []; selectedId = null; filter = 'all';
    settings.tmdbKey = ''; settings.movieIds = false; settings.showYear = false; settings.quality = false; settings.posters = true;
    settings.tvdbKey = ''; settings.tvdbPin = ''; settings.order = 'tmdb'; settings.showIds = true; settings.cardScan = false; numbering = {}; episodeLists = {}; settings.mode = 'move';
    $('privacySheet').close();
    render();
    toast('Erased. Shelf has nothing stored on this computer.');
  });
  on('optIds', 'change', function (e) { settings.movieIds = e.target.checked; save('movieIds', settings.movieIds); render(); });
  on('optShowYear', 'change', function (e) { settings.showYear = e.target.checked; save('showYear', settings.showYear); render(); });
  on('optQuality', 'change', function (e) { settings.quality = e.target.checked; save('quality', settings.quality); render(); });
  on('optShowIds', 'change', function (e) { settings.showIds = e.target.checked; save('showIds', settings.showIds); render(); });
  on('optCardScan', 'change', function (e) { settings.cardScan = e.target.checked; save('cardScan', settings.cardScan); render(); });

  // ---------- Looking inside videos (only when you click, and Shelf's own prompt asks first) ----------
  var scanning = false;
  function showFiles(item) {
    var v = linkedVideo(item) || item;
    var c = current(v);
    if (!c) return [];
    var id = showIdKey(c);
    return items.filter(function (i) {
      var cc = current(i);
      return i.kind === 'episode' && !i.linkTo && i.fullPath && i.parsed.isVideo && cc && showIdKey(cc) === id && ['done', 'skipped'].indexOf(i.status) < 0;
    });
  }
  function setScanStatus(text) { $('scanStatus').textContent = text || ''; }
  on('checkLengths', 'click', function () {
    var item = itemById(selectedId); if (!item || scanning) return;
    var files = showFiles(item); if (!files.length) return;
    scanning = true; setScanStatus('Waiting for your OK…');
    native.checkLengths(files.map(function (i) { return i.fullPath; })).then(function (res) {
      if (!res) { setScanStatus('Cancelled. Nothing was read.'); return; }
      scanBar('Checked the length of ' + files.length + ' video' + (files.length === 1 ? '' : 's'), 1);
      setTimeout(function () { if (!scanning) scanBar(null); }, 1500);
      var got = 0;
      files.forEach(function (i) { var secs = res[i.fullPath]; if (secs) { i.minutes = secs / 60; got++; } });
      setScanStatus(got ? 'Checked ' + got + ' of ' + files.length + ' videos.' : 'Couldn’t tell the length of these videos (unusual format).');
      return resolveShow(current(linkedVideo(item) || item));
    }).catch(function (e) { setScanStatus('Couldn’t check: ' + e.message); })
      .then(function () { scanning = false; render(); });
  });
  // The bar at the bottom while Shelf reads videos.
  function scanBar(text, frac) {
    var bar = $('scanBar');
    bar.hidden = text == null;
    $('dropHint').hidden = text != null;
    if (text == null) return;
    $('scanBarText').textContent = text;
    $('scanBarFill').style.width = Math.round(Math.max(0, Math.min(1, frac || 0)) * 100) + '%';
  }
  function itemByPath(p) { return items.filter(function (i) { return i.fullPath === p; })[0] || null; }

  // The live reader: a small card that shows the frame Shelf is reading and the titles it finds.
  var reader = (function () {
    var box = $('reader'), cv = [$('readerA'), $('readerB')], front = 0, holdUntil = 0, queued = null, timer = 0, outTimer = 0;
    function clock(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), sec = Math.floor(t % 60); return m + ':' + (sec < 10 ? '0' : '') + sec; }
    function step(text) {
      var n = $('readerStep');
      if (n.textContent === text) return;
      n.textContent = text; n.classList.remove('swap'); void n.offsetWidth; n.classList.add('swap');
    }
    function draw(p) {
      if (!p.image) return;
      var c = cv[1 - front];
      if (c.width !== p.image.w || c.height !== p.image.h) { c.width = p.image.w; c.height = p.image.h; }
      try { c.getContext('2d').putImageData(new ImageData(p.image.data, p.image.w, p.image.h), 0, 0); } catch (e) { return; }
      c.classList.add('on'); cv[front].classList.remove('on'); front = 1 - front;
      box.classList.add('has-frame', 'is-reading'); box.dataset.state = 'read';
      $('readerTime').textContent = clock(p.t);
      step('Reading the words at ' + clock(p.t) + '…');
    }
    function later(fn) { clearTimeout(timer); timer = setTimeout(fn, Math.max(0, holdUntil - Date.now())); }
    return {
      start: function (total, deep) {
        clearTimeout(outTimer); box.hidden = false; box.classList.remove('is-out', 'has-frame', 'is-reading'); document.body.classList.add('has-reader');
        box.dataset.state = 'seek'; front = 0; holdUntil = 0; queued = null;
        cv.forEach(function (c) { c.classList.remove('on'); });
        $('readerFound').replaceChildren(); $('readerFill').style.width = '0%'; $('readerTime').textContent = '';
        $('readerTitle').textContent = deep ? 'Deep scan' : 'Reading title cards'; $('readerCount').textContent = deep ? 'a closer look' : total > 1 ? total + ' videos' : '';
        box.classList.toggle('is-deep', !!deep);
        $('readerFile').textContent = ''; $('readerStop').disabled = false; $('readerStop').hidden = false;
        step('Waiting for your OK…');
      },
      file: function (name, index, total) {
        var go = function () {
          $('readerFile').textContent = name;
          $('readerFound').replaceChildren(); // the titles found in this video
          box.classList.remove('has-frame'); cv.forEach(function (c) { c.classList.remove('on'); });
          $('readerCount').textContent = total > 1 ? 'Video ' + (index + 1) + ' of ' + total : '';
          box.classList.remove('is-reading'); box.dataset.state = 'seek'; $('readerTime').textContent = '';
          step('Finding the quiet, still moments…');
        };
        if (Date.now() < holdUntil) later(go); else go();
      },
      peek: function (p) {
        if (Date.now() < holdUntil) { queued = p; later(function () { if (queued) { var q = queued; queued = null; draw(q); } }); return; }
        draw(p);
      },
      found: function (p) {
        queued = null;
        box.classList.remove('is-reading'); box.dataset.state = 'found';
        $('readerTime').textContent = clock(p.t);
        step('Found a title card at ' + clock(p.t));
        var chips = $('readerFound');
        chips.appendChild(el('span', { class: 'reader-chip', title: p.title }, [el('b', { text: '✓' }), p.title]));
        while (chips.children.length > 4) chips.removeChild(chips.firstChild);
        holdUntil = Date.now() + 1100; // let the find sink in before the next frame
      },
      progress: function (frac) { $('readerFill').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; },
      stopping: function () { $('readerStop').disabled = true; step('Stopping after this video…'); },
      end: function (text, title, count) {
        var finish = function () {
          box.classList.remove('is-reading'); box.dataset.state = 'done';
          $('readerTitle').textContent = title; $('readerCount').textContent = count;
          $('readerStop').hidden = true;
          $('readerFill').style.width = '100%'; step(text);
          outTimer = setTimeout(function () { box.classList.add('is-out'); outTimer = setTimeout(function () { box.hidden = true; document.body.classList.remove('has-reader'); }, 340); }, 2600);
        };
        clearTimeout(timer);
        if (Date.now() < holdUntil) setTimeout(finish, holdUntil - Date.now()); else finish();
      },
      hide: function () { clearTimeout(timer); clearTimeout(outTimer); box.hidden = true; document.body.classList.remove('has-reader'); }
    };
  })();

  on('deepScan', 'click', function () { var item = itemById(selectedId); if (item) deepScan(item); });
  on('readCards', 'click', function () {
    var item = itemById(selectedId); if (!item || scanning) return;
    readCardsOf(item, showFiles(item), false);
  });
  // Deep Scan: one video, much more thorough (for title cards the quick read missed).
  function deepScan(item) {
    var v = linkedVideo(item) || item;
    if (scanning || !v.fullPath) return;
    readCardsOf(item, [v], true);
  }
  function readCardsOf(item, files, deepNext) {
    if (!files.length) return;
    var c = current(linkedVideo(item) || item);
    scanning = true; setScanStatus('Waiting for your OK…');
    var read = 0, titlesFound = 0;
    // The answer can arrive before the last progress messages do, so keep listening until "end" (or a few seconds).
    var ended, endedP = new Promise(function (res) { ended = res; });
    var stop = native.onCardProgress(function (p) {
      var it = p.path ? itemByPath(p.path) : null;
      if (p.kind === 'queue') { p.paths.forEach(function (fp) { var q = itemByPath(fp); if (q) { q.scan = 'queued'; q.scanFrac = 0; } }); $('cancelCards').hidden = false; reader.start(p.total, deepNext); }
      if (p.kind === 'start' && it) { it.scan = 'reading'; it.scanFrac = 0; }
      if (p.kind === 'start') reader.file(p.file || (it && it.name) || '', p.index, p.total);
      if (p.kind === 'step' && it) it.scanFrac = p.frac;
      if (p.kind === 'peek') { reader.peek(p); return; }
      if (p.kind === 'found') { titlesFound++; reader.found(p); return; }
      if (p.kind === 'start' || p.kind === 'step') {
        reader.progress((p.index + (p.kind === 'step' ? p.frac : 0)) / p.total);
        setScanStatus('Reading title cards: video ' + (p.index + 1) + ' of ' + p.total + '…');
      }
      if (p.kind === 'file' && it) {
        var r = p.result || {};
        if (r.secs) it.minutes = r.secs / 60;
        if (r.texts) { it.cards = r.texts; it.cardParts = r.parts; read++; }
        it.scan = p.stopped && !r.texts ? null : 'done'; it.scanFrac = 1;
        // Show this episode's answer straight away, then settle back to the normal tag.
        resolveShow(c).then(function () {
          scheduleRender();
          setTimeout(function () { if (it.scan === 'done') { it.scan = null; scheduleRender(); } }, 1800);
        });
      }
      if (p.kind === 'end') {
        items.forEach(function (i) { if (i.scan === 'queued' || i.scan === 'reading') i.scan = null; });
        var nTitles = titlesFound + ' title card' + (titlesFound === 1 ? '' : 's');
        reader.end(titlesFound ? 'Found ' + nTitles + '. Check the episodes in the side panel.' : 'No title cards could be read. Shelf will go by name and length.',
          p.stopped ? 'Stopped' : 'Finished reading', read + ' of ' + p.total + ' video' + (p.total === 1 ? '' : 's'));
        ended();
      }
      scheduleRender();
    });
    listFor(c).then(function (list) {
      var titles = list.filter(function (e) { return e.number != null && e.name; }).map(function (e) { return e.name; });
      // Episodes the file's name points near: a slightly weaker reading is enough for these.
      var nearFor = function (i) {
        var es = i.episode ? (i.episode.entries && i.episode.entries.length ? i.episode.entries : [i.episode]) : [];
        return list.filter(function (e) { return e.number != null && es.some(function (x) { return x.season === e.season && Math.abs(x.number - e.number) <= 6; }); }).map(function (e) { return e.name; });
      };
      return native.readCards(files.map(function (i) { return { path: i.fullPath, titles: titles, near: nearFor(i) }; }), { deep: !!deepNext });
    }).then(function (res) {
      if (!res) return res;
      return Promise.race([endedP, new Promise(function (r) { setTimeout(r, 4000); })]).then(function () { return res; });
    }).then(function (res) {
      if (!res) { reader.hide(); setScanStatus('Cancelled. No videos were read.'); return; }
      setScanStatus('Read ' + read + ' of ' + files.length + ' videos.');
      return resolveShow(c);
    }).catch(function (e) { setScanStatus('Couldn’t read the title cards: ' + e.message); })
      .then(function () { stop(); scanning = false; $('cancelCards').hidden = true; render(); });
  }
  on('scanBarStop', 'click', function () { native.cancelCards(); scanBar('Stopping after this video…', 1); });
  on('readerStop', 'click', function () { native.cancelCards(); reader.stopping(); setScanStatus('Stopping…'); });
  on('cancelCards', 'click', function () { native.cancelCards(); reader.stopping(); setScanStatus('Stopping…'); });
  function syncOrderHelp() {
    var svc = tvService();
    var want = settings.order === 'tmdb' ? 'The Movie Database' : 'TheTVDB';
    $('orderHelp').textContent = (svc === 'TVmaze'
      ? 'Add your ' + (settings.order === 'tmdb' ? 'TMDB' : 'TheTVDB') + ' key to use this order. Until then TV shows are looked up on TVmaze, which follows TheTVDB’s aired order. '
      : '') + (settings.order === 'tmdb'
      ? 'Plex uses The Movie Database unless you change it in Plex (open the show → Edit → Advanced → Episode ordering).'
      : 'In Plex, set the show (or the library, under Advanced) to Episode ordering → ' + (settings.order === 'tvdbdvd' ? 'TheTVDB (DVD)' : 'TheTVDB (Aired)') + '.');
  }
  // Changing the order or a TV key re-matches every TV show that isn't renamed yet.
  function rematchTv() {
    episodeLists = {}; showChoices = {};
    items.forEach(function (i) {
      if (i.kind === 'episode' && !i.linkTo && ['done', 'skipped'].indexOf(i.status) < 0 && !i.handPickedQuery) {
        i.status = 'pending'; i.candidates = []; i.choice = 0; i.confirmed = false; i.handPicked = false; i.needsKey = false;
      }
    });
    matchAll();
  }
  on('optOrder', 'change', function (e) { settings.order = e.target.value; save('order', settings.order); syncOrderHelp(); tvDirty = true; });
  on('tvdbInput', 'change', function (e) { saveKey(e.target.value.trim(), 'tvdb'); syncOrderHelp(); tvDirty = true; render(); });
  on('tvdbPinInput', 'change', function (e) { saveKey(e.target.value.trim(), 'tvdbPin'); tvDirty = true; });
  on('testTvdb', 'click', function () {
    var key = $('tvdbInput').value.trim(), pin = $('tvdbPinInput').value.trim();
    var st = $('tvdbStatusText');
    if (!key) { st.textContent = 'Paste your key first.'; return; }
    st.textContent = 'Checking…';
    S.testTvdbKey(key, pin).then(function () {
      st.textContent = 'It works! TV shows can now use TheTVDB.';
      saveKey(key, 'tvdb'); saveKey(pin, 'tvdbPin'); syncOrderHelp(); tvDirty = true; render();
    }).catch(function (err) { st.textContent = err.code === 'network' ? err.message : 'TheTVDB didn’t accept that key. Copy it again from thetvdb.com → Dashboard → API Keys.'; });
  });
  on('forgetTvdb', 'click', function () {
    saveKey('', 'tvdb'); saveKey('', 'tvdbPin'); $('tvdbInput').value = ''; $('tvdbPinInput').value = '';
    $('tvdbStatusText').textContent = 'Key removed from this computer.'; syncOrderHelp(); tvDirty = true; render();
  });
  var tvDirty = false;
  // "One cartoon" / "A half-hour" in the side panel: applies to every file of that show.
  document.querySelectorAll('#inspSeg button').forEach(function (b) {
    b.addEventListener('click', function () {
      var item = itemById(selectedId);
      var c = item && current(linkedVideo(item) || item);
      if (!c) return;
      numbering[showIdKey(c)] = b.dataset.mode;
      resolveShow(c).then(function () { render(); });
    });
  });
  on('settingsSheet', 'close', function () {
    if (tvDirty) { tvDirty = false; rematchTv(); }
    // Retry anything that failed for lack of a key.
    if (!settings.tmdbKey && !settings.tvdbKey) return;
    items.forEach(function (i) { if (i.needsKey) { i.needsKey = false; i.status = 'pending'; } });
    matchAll();
  });

  // Drag and drop anywhere
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragend', function () { dragDepth = 0; document.body.classList.remove('dragging'); });
  window.addEventListener('drop', function (e) { dragDepth = 0; handleDrop(e); });

  // Keyboard shortcuts
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    var typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    var sheetOpen = !!document.querySelector('dialog[open]');
    var k = e.key.toLowerCase();
    if (mod && k === 'o') { e.preventDefault(); if (e.shiftKey) pickFolder(); else pickFiles(); return; }
    if (mod && k === ',') { e.preventDefault(); if (!sheetOpen) openSheet('settings'); return; }
    if (mod && k === 'enter' && !sheetOpen) { e.preventDefault(); if (!$('renameBtn').disabled) openSheet('rename'); return; }
    if (mod && k === 'z' && !typing && !sheetOpen) { if (!$('undoBar').hidden) { e.preventDefault(); $('undoBar').click(); } return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && !sheetOpen && selectedId) { e.preventDefault(); $('removeBtn').click(); }
  });
  // Arrow keys move through the list
  document.addEventListener('keydown', function (e) {
    if (!items.length || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var shown = items.filter(function (i) { return filter === 'all' || needsReview(i); });
    var idx = shown.findIndex(function (i) { return i.id === selectedId; });
    var next = shown[Math.max(0, Math.min(shown.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { e.preventDefault(); select(next.id); }
  });

  window.addEventListener('error', function (e) { toast('Something went wrong: ' + (e.message || 'unknown error')); });
  window.addEventListener('unhandledrejection', function (e) { toast('Something went wrong: ' + ((e.reason && e.reason.message) || 'unknown error')); });

  native.getKey('tmdb').then(function (k) { settings.tmdbKey = k || ''; render(); });
  native.getKey('tvdb').then(function (k) { settings.tvdbKey = k || ''; render(); });
  native.getKey('tvdbPin').then(function (k) { settings.tvdbPin = k || ''; });
  native.version().then(function (v) { $('appVersion').textContent = 'Version ' + v; });
  // ---------- Updates (only when you click; see desktop/updates.js) ----------
  var up = { state: 'idle', info: null };
  function fmtMB(b) { return b >= 1e6 ? Math.round(b / 1048576) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function fmtDate(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); }
  // Release notes as tidy lines: "- x" become bullets, "## x" small headings. Plain text only.
  function notesInto(box, text) {
    box.textContent = '';
    var list = null;
    (text || '').split('\n').forEach(function (line) {
      var b = line.match(/^\s*[-•*]\s+(.*)$/), h = line.match(/^#+\s*(.*)$/);
      if (b) { if (!list) { list = el('ul'); box.appendChild(list); } list.appendChild(el('li', { text: b[1] })); return; }
      if (/^\s+\S/.test(line) && list && list.lastChild) { list.lastChild.textContent += ' ' + line.trim(); return; }
      list = null;
      if (h) box.appendChild(el('h4', { text: h[1] }));
      else if (line.trim()) box.appendChild(el('p', { text: line.trim() }));
    });
    if (!box.childNodes.length) box.appendChild(el('p', { class: 'muted', text: 'Fixes and improvements.' }));
  }
  function upShow(state, o) {
    o = o || {};
    up.state = state;
    var box = $('upBox'); box.dataset.state = state;
    $('upTitle').textContent = o.title || '';
    $('upSub').textContent = o.sub || '';
    $('upBadge').className = 'up-badge ' + (o.badge || '');
    $('upNotesBox').hidden = !o.notes;
    if (o.notes) notesInto($('upNotes'), o.notes);
    $('upProgressBox').hidden = state !== 'downloading' && state !== 'starting';
    $('upTrust').hidden = !o.trust;
    var p = $('upPrimary'), s2 = $('upSecondary');
    p.hidden = !o.primary; p.textContent = o.primary || ''; p.disabled = false;
    s2.textContent = o.secondary || 'Close'; s2.hidden = o.secondary === false;
  }
  function upProgress(got, total) {
    var f = total ? Math.min(1, got / total) : 0;
    $('upBar').style.width = (f * 100).toFixed(1) + '%';
    $('upProgressText').textContent = total ? 'Downloading ' + fmtMB(got) + ' of ' + fmtMB(total) : 'Downloading ' + fmtMB(got);
    $('upProgressPct').textContent = total ? Math.round(f * 100) + '%' : '';
  }
  native.onUpdateProgress(function (p) { if (up.state === 'downloading') upProgress(p.got, p.total); });
  function checkForUpdates() {
    var d = $('updateSheet');
    if (!d.open) d.showModal();
    if (up.state === 'downloading' || up.state === 'starting') return;
    upShow('checking', { title: 'Checking for updates…', sub: 'Asking Shelf’s GitHub page for the newest version.', badge: 'spin', secondary: 'Cancel' });
    native.checkUpdate().then(function (r) {
      if (up.state !== 'checking') return;
      up.info = r;
      $('updateDot').hidden = !r.newer;
      if (!r.newer) {
        upShow('current', { title: 'Shelf is up to date', sub: 'Version ' + r.current + ' is the newest version.', badge: 'ok', secondary: 'Done' });
        return;
      }
      var how = r.kind === 'portable' ? 'Download & Open' : r.kind === 'setup' ? 'Download & Install' : 'Open Download Page';
      upShow('available', {
        title: 'Shelf ' + r.version + ' is available',
        sub: 'You have ' + r.current + (r.date ? ' · Released ' + fmtDate(r.date) : '') + (r.size ? ' · ' + fmtMB(r.size) : ''),
        badge: 'new', notes: r.notes || ' ', trust: r.canInstall, primary: how, secondary: 'Later'
      });
      $('upTrustText').textContent = r.kind === 'portable'
        ? 'Saved next to this copy of Shelf, from Shelf’s GitHub page, and checked against its fingerprint before it opens.'
        : 'Downloaded from Shelf’s GitHub page and checked against its fingerprint before it runs. Your settings and keys are kept.';
    }).catch(function (e) {
      if (up.state !== 'checking') return;
      upShow('error', { title: 'Couldn’t check for updates', sub: (e && e.message ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Check your internet connection and try again.'), badge: 'warn', primary: 'Try Again', secondary: 'Close' });
    });
  }
  on('updatesNav', 'click', checkForUpdates);
  on('checkUpdates', 'click', function () { $('aboutSheet').close(); checkForUpdates(); });
  on('upPrimary', 'click', function () {
    if (up.state === 'error') { checkForUpdates(); return; }
    if (up.state !== 'available' || !up.info) return;
    if (!up.info.canInstall) { native.installUpdate(); $('updateSheet').close(); up.state = 'idle'; return; }
    var portable = up.info.kind === 'portable';
    upShow('downloading', { title: 'Downloading Shelf ' + up.info.version + '…', sub: portable ? 'The new copy will open when it’s ready.' : 'The installer will start when it’s ready. Shelf will close so it can update.', badge: 'spin', trust: true, secondary: 'Cancel' });
    upProgress(0, up.info.size);
    native.installUpdate().then(function (r) {
      upShow('starting', { title: portable ? 'Opening Shelf ' + up.info.version + '…' : 'Starting the installer…', sub: portable ? 'Saved as ' + r.file + ' next to this copy. This window will close.' : 'Follow the installer’s steps. Shelf will close now.', badge: 'ok', trust: true, secondary: false });
      $('upBar').style.width = '100%'; $('upProgressText').textContent = 'Downloaded and checked'; $('upProgressPct').textContent = '✓';
    }).catch(function (e) {
      var msg = e && e.message ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '';
      if (/Cancelled/.test(msg)) { upShow('available', { title: 'Shelf ' + up.info.version + ' is available', sub: 'Download cancelled. Nothing was changed.', badge: 'new', notes: up.info.notes || ' ', trust: true, primary: portable ? 'Download & Open' : 'Download & Install', secondary: 'Later' }); return; }
      upShow('error', { title: 'The update didn’t finish', sub: msg || 'Something went wrong. Nothing was changed.', badge: 'warn', primary: 'Try Again', secondary: 'Close' });
    });
  });
  on('upSecondary', 'click', function () {
    if (up.state === 'downloading') { native.cancelUpdate(); return; }
    if (up.state === 'checking') up.state = 'idle';
    $('updateSheet').close();
  });
  $('updateSheet').addEventListener('cancel', function (e) { if (up.state === 'downloading' || up.state === 'starting') e.preventDefault(); else if (up.state === 'checking') up.state = 'idle'; });
  // While Shelf's permission window is open, this window steps back.
  native.onModal(function (open) { document.body.classList.toggle('is-asking', open); });

  // ---------- Check Episodes window ----------
  // Title cards Shelf read in this video, for the window to show (and jump to).
  // Title cards you marked yourself (for ones Shelf couldn't read), in the form the matcher reads:
  // which part of the video each is in, and the episode it is.
  function markCards(v) {
    var secs = v.secs || (v.minutes || 22) * 60;
    var parts = v.cardParts || Math.max(1, Math.min(4, Math.round(secs / 660)));
    return (v.marks || []).map(function (m) {
      return { part: Math.min(parts - 1, Math.floor(m.t / (secs / parts))), t: m.t, texts: [], mark: { season: m.season, number: m.number } };
    });
  }
  function cardsFor(v, list) {
    var out = {};
    (v.marks || []).forEach(function (m) {
      var k = m.season + 'x' + m.number;
      out[k] = { t: m.t, start: m.t, key: k, name: m.name, season: m.season, number: m.number, text: '', score: 1, manual: true };
    });
    (v.cards || []).forEach(function (r) {
      var m = P.matchCardText(r.texts, list);
      if (!m) return;
      var k = m.entry.season + 'x' + m.entry.number;
      // Show the clearest of the readings (the one closest to the title on its own).
      var best = r.texts.map(function (t) { var one = P.matchCardText([t], [m.entry]); return { t: t, s: one ? one.score : 0 }; })
        .sort(function (a, b) { return b.s - a.s || a.t.length - b.t.length; })[0];
      if (out[k] && out[k].manual) return;
      if ((v.marks || []).some(function (mk) { return Math.abs(mk.t - r.t) < 120; })) return; // near a card you marked: yours wins
      if (!out[k] || m.score > out[k].score) out[k] = { t: r.t, start: r.start != null ? r.start : r.t, key: k, name: m.entry.name, text: best ? best.t : '', score: m.score };
    });
    return Object.keys(out).map(function (k) { return out[k]; });
  }
  function nameFor(v, entries) {
    var m = matchFor(v);
    if (!m || !entries.length) return '';
    var first = entries[0], last = entries[entries.length - 1];
    var mm = Object.assign({}, m, { season: first.season, episode: first.number, episodeEnd: last.number > first.number ? last.number : null, episodeTitle: P.joinNames(entries) });
    return P.plexName(v.parsed, mm, { movieIds: settings.movieIds, showYear: settings.showYear || m.needsYear, quality: qualityFor(v) }).file;
  }
  // Files of the same show, in episode order (for "Save & Next").
  function showRun(v) {
    var c = current(v); if (!c) return [];
    var id = showIdKey(c);
    return items.filter(function (i) {
      var cc = current(i);
      return i.kind === 'episode' && !i.linkTo && i.fullPath && i.parsed.isVideo && cc && showIdKey(cc) === id && i.status !== 'done';
    }).sort(function (a, b) {
      var sa = a.parsed.season != null ? a.parsed.season : 1, sb = b.parsed.season != null ? b.parsed.season : 1;
      return sa - sb || (a.parsed.episode || 0) - (b.parsed.episode || 0) || a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }
  // ---------- Episodes in a file: rows, title-card frames, problems, fixing them ----------
  function epCode(e) { return 'S' + pad2(e.season) + 'E' + pad2(e.number); }
  function fmtClock(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), sec = Math.floor(t % 60); return m + ':' + (sec < 10 ? '0' : '') + sec; }
  function inRow(es) { return es.every(function (e, k) { return k === 0 || (e.season === es[k - 1].season && e.number === es[k - 1].number + 1); }); }
  function joinAnd(xs) { return xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }
  // The episodes Shelf thinks a video holds, in the order they play (with where each title card was read).
  function episodeRows(v, item) {
    if (v.split) return v.split.pieces.map(function (p) { return p.entry; });
    var ep = v.episode;
    if (ep) return ep.entries && ep.entries.length ? ep.entries : [{ season: ep.season, number: ep.number, name: ep.name }];
    var it = item || v, s0 = it.parsed.season != null ? it.parsed.season : 1;
    return [{ season: s0, number: it.parsed.episode || 1, name: it.parsed.episodeTitle || '' }];
  }
  // A title card's frame (fetched only for videos you let Shelf look inside; kept in memory).
  function cardFrame(v, t, w) {
    v._frames = v._frames || {};
    var key = t.toFixed(2) + '@' + w;
    if (!v._frames[key]) {
      v._frames[key] = (native.cardFrame ? native.cardFrame(v.fullPath, t, w) : Promise.resolve(null)).then(function (bytes) {
        return bytes ? URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })) : null;
      }).catch(function () { return null; });
    }
    return v._frames[key];
  }
  // A problem with a file's episodes, in plain words, and what you can do about it.
  function issueFor(item) {
    var v = linkedVideo(item) || item, ep = v.episode;
    if (!ep || v.split || item.status === 'done' || item.kind !== 'episode') return null;
    var names = function (es) { return es.map(function (e) { return epCode(e) + ' “' + e.name + '”'; }); };
    if (ep.needsSplit) {
      var es = ep.entries || [];
      return { kind: 'apart', title: 'This file holds ' + es.length + ' separate episodes',
        text: joinAnd(names(es)) + ' aren’t next to each other in the episode list, so Plex needs a separate file for each. Shelf can split it for you, without re-encoding.',
        actions: [{ label: 'Resolve…', run: function () { openResolve(item); } }] };
    }
    if (!item.epBlock) return null;
    var note = item.epProblem || '';
    if (ep.how === 'card' && /one long episode/.test(note)) {
      return { kind: 'single', title: 'One long episode?',
        text: 'Shelf read one title card (“' + ep.name + '”) and no second one. Is the whole file this episode?',
        actions: [{ label: 'Yes, One Episode', run: function () { useEntries(v, [episodeRows(v)[0]], 'Confirmed: one episode.'); } }, { label: 'Resolve…', run: function () { openResolve(item); } }].concat(deepAction(item))
          .concat(v.fullPath ? [{ label: 'Mark 2nd Card…', title: 'Find the second title card in the video yourself and say which episode it is', run: function () { openEditor(item, { part: 1, of: 2 }); } }] : []) };
    }
    return { kind: 'check', title: 'Check this episode', text: note || 'Shelf isn’t sure which episode this is.',
      actions: [{ label: 'Resolve…', run: function () { openResolve(item); } }].concat(deepAction(item)) };
  }
  // Deep Scan, offered where a title card is missing (if title-card reading is turned on).
  function canDeep(item) { var v = linkedVideo(item) || item; return !!(settings.cardScan && v.fullPath && v.parsed.isVideo && !v.split); }
  function deepAction(item) {
    return canDeep(item) ? [{ label: 'Deep Scan', title: 'Take a much closer look for the title cards in this video (a few minutes)', run: function () { deepScan(item); } }] : [];
  }
  // You chose these episodes for one file.
  function useEntries(v, es, msg) {
    var clean = es.map(function (e) { return { season: e.season, number: e.number, name: e.name, runtime: e.runtime || null, card: e.card != null ? e.card : null }; });
    var last = clean[clean.length - 1];
    v.manualEp = { season: clean[0].season, number: clean[0].number, end: inRow(clean) && last.number > clean[0].number ? last.number : null, name: P.joinNames(clean), entries: clean };
    v.split = null; v.confirmed = true;
    var c = current(v);
    if (c) resolveShow(c).then(render);
    if (msg) toast(msg);
  }
  // "Change" on one episode row: pick it from the show's list.
  function changeEntry(v, i, anchor) {
    var c = current(v); if (!c) return;
    listFor(c).then(function (list) {
      var rows = episodeRows(v).map(function (e) { return Object.assign({}, e); });
      ShelfEditor.browse(anchor, {
        list: list, marked: [rows[i]], season: rows[i] ? rows[i].season : null, title: rows.length > 1 ? 'Which episode is part ' + (i + 1) + '?' : 'Which episode is this file?',
        onPick: function (x) {
          rows[i] = { season: x.season, number: x.number, name: x.name, runtime: x.runtime || null, card: rows[i] ? rows[i].card : null };
          useEntries(v, rows, 'Changed to ' + epCode(x) + ' ' + x.name);
        }
      });
    });
  }
  // Split a video into one file per part, finding the gaps between them (no window needed).
  function autoSplit(v, parts) {
    var c = current(v);
    var secs0 = (v.minutes || 22) * 60;
    var hints = parts.slice(1).map(function (e, k) {
      var rd = e.card != null ? (v.cards || []).filter(function (r) { return Math.abs(r.t - e.card) < 0.05; })[0] : null;
      return e.card != null ? { card: rd && rd.start != null ? rd.start : e.card } : { est: secs0 * (k + 1) / parts.length };
    });
    return native.suggestCuts(v.fullPath, hints).then(function (res) {
      if (!res) { toast('Cancelled. Nothing was changed.'); return false; }
      var secs = res.secs || secs0;
      var cuts = res.cuts.map(function (g, k) { return g ? g.at : secs * (k + 1) / parts.length; });
      v.split = { pieces: parts.map(function (e, k) {
        return { start: k ? cuts[k - 1] : 0, end: k < parts.length - 1 ? cuts[k] : secs, entry: { season: e.season, number: e.number, name: e.name, runtime: e.runtime || null, card: e.card != null ? e.card : null } };
      }) };
      v.manualEp = null;
      var g0 = res.cuts[0];
      toast('Will split into ' + parts.length + ' files' + (g0 ? ' at ' + fmtClock(g0.at) + (g0.why === 'black + silence' ? ' (a black, silent moment)' : '') : '') + '. Check it any time with Edit Split…');
      if (c) resolveShow(c).then(render);
      return true;
    });
  }
  // The Resolve window: the title cards Shelf read, each episode changeable, and one clear choice.
  function openResolve(item) {
    var v = linkedVideo(item) || item, c = current(v);
    if (!c) return;
    var iss = issueFor(item) || { kind: 'check', title: 'Check this file' };
    listFor(c).then(function (list) {
      var parts = episodeRows(v, item).map(function (e) { return Object.assign({}, e); });
      var single = iss.kind === 'single';
      $('rsTitle').textContent = iss.title;
      $('rsFile').textContent = v.name;
      $('rsIcon').className = 'rs-icon ' + iss.kind;
      $('rsLead').textContent = single
        ? 'Is the whole file this one episode, or does it also hold a cartoon whose title card Shelf couldn’t read?'
        : 'These are the title cards Shelf read. Check each part is the right episode (Change… if not), then choose below.';
      function act(btn, label, run) {
        btn.hidden = !label; btn.textContent = label || ''; btn.disabled = false;
        btn.onclick = function () {
          btn.disabled = true;
          Promise.resolve(run()).then(function (done) { if (done !== false) $('resolveSheet').close(); else btn.disabled = false; })
            .catch(function (e) { btn.disabled = false; toast('Couldn’t do that: ' + e.message); });
        };
      }
      function draw() {
        var box = $('rsParts'); box.textContent = '';
        box.className = 'rs-parts n' + parts.length;
        parts.forEach(function (e, i) {
          var frame = el('div', { class: 'rs-frame' }, [el('span', { class: 'rs-noframe' }, e.card != null ? [] : [
            'No title card read for this part',
            el('span', { class: 'rs-noframe-btns' }, [
              el('button', { type: 'button', class: 'pill small-pill', text: 'Mark It Yourself…', title: 'Find this title card in the video and say which episode it is', onclick: function () { $('resolveSheet').close(); openEditor(item, { part: i, of: parts.length }); } }),
              canDeep(item) ? el('button', { type: 'button', class: 'pill small-pill', text: 'Deep Scan', title: 'Take a much closer look for this video’s title cards (a few minutes)', onclick: function () { $('resolveSheet').close(); deepScan(item); } }) : null
            ])
          ])]);
          if (e.card != null) cardFrame(v, e.card, 480).then(function (url) { if (url) frame.replaceChildren(el('img', { src: url, alt: 'Title card of ' + e.name })); else frame.firstChild.textContent = 'Picture not available'; });
          var change = el('button', { type: 'button', class: 'pill small-pill', 'data-opens-browser': '1', text: 'Change…' });
          change.onclick = function () {
            ShelfEditor.browse(change, { list: list, marked: [e], season: e.season, title: parts.length > 1 ? 'Which episode is part ' + (i + 1) + '?' : 'Which episode is this?',
              onPick: function (x) { parts[i] = { season: x.season, number: x.number, name: x.name, runtime: x.runtime || null, card: e.card }; draw(); } });
          };
          box.appendChild(el('div', { class: 'rs-part', 'data-part': i % 2 }, [
            frame,
            el('span', { class: 'rs-part-k' }, [parts.length > 1 ? el('i', { text: String(i + 1) }) : null, e.card != null ? 'Title card at ' + fmtClock(e.card) : 'No title card']),
            el('div', { class: 'rs-ep' }, [el('span', { class: 'ep-card-code', text: epCode(e) }), el('span', { class: 'ep-card-name', text: e.name, title: e.name }), change])
          ]));
        });
        var verdict = $('rsVerdict'), names;
        if (single || parts.length === 1) {
          names = [nameFor(v, [parts[0]])];
          verdict.replaceChildren(el('span', { text: 'Will be named' }), el('code', { text: names[0] }));
          act($('rsMain'), single ? 'Yes, One Episode' : 'Use This Episode', function () { useEntries(v, [parts[0]], 'Saved: ' + names[0]); });
          act($('rsAlt'), single ? 'It Has a Second Cartoon…' : null, function () { v.wantSplit = true; $('resolveSheet').close(); openEditor(item); return false; });
        } else if (inRow(parts)) {
          names = [nameFor(v, parts)];
          verdict.replaceChildren(el('span', { class: 'ok', text: '✓ These are next to each other, so one file can hold them:' }), el('code', { text: names[0] }));
          act($('rsMain'), 'Keep One File', function () { useEntries(v, parts, 'Saved: ' + names[0]); });
          act($('rsAlt'), 'Split Anyway', function () { return autoSplit(v, parts); });
        } else {
          names = parts.map(function (e) { return nameFor(v, [e]); });
          verdict.replaceChildren.apply(verdict, [el('span', { text: 'Not next to each other, so each gets its own file:' })].concat(names.map(function (n) { return el('code', { text: n }); })));
          act($('rsMain'), 'Split into ' + parts.length + ' Files', function () { $('rsMain').textContent = 'Finding the gap…'; return autoSplit(v, parts); });
          act($('rsAlt'), null);
        }
      }
      $('rsEditor').onclick = function () { $('resolveSheet').close(); openEditor(item); };
      $('rsClose').onclick = function () { $('resolveSheet').close(); };
      draw();
      $('resolveSheet').showModal();
    });
  }

  function openEditor(item, lookFor) {
    var v = linkedVideo(item) || item;
    var c = current(v);
    if (!c || !v.fullPath) return;
    var btn = $('checkEps'); btn.disabled = true;
    var run = showRun(v), at = run.indexOf(v), nextItem = at >= 0 ? run[at + 1] : null;
    var also = at >= 0 ? run.slice(at + 1).map(function (i) { return i.fullPath; }) : [];
    listFor(c).then(function (list) {
      return native.openSplit(v.fullPath, also).then(function (r) {
        if (!r) { toast('Cancelled. The video wasn’t opened.'); return; }
        var wantSplit = v.wantSplit; v.wantSplit = false;
        var how = v.episode ? v.episode.how : 'number';
        var entries = v.episode && v.episode.entries && v.episode.entries.length
          ? v.episode.entries.map(function (e) { return Object.assign({ how: how }, e); })
          : v.episode ? [{ season: v.episode.season, number: v.episode.number, name: v.episode.name, how: how }] : [];
        // Fill in runtimes from the list (used to estimate where episodes change).
        entries.forEach(function (e) { var f = list.filter(function (x) { return x.season === e.season && x.number === e.number; })[0]; if (f) { e.runtime = e.runtime || f.runtime; e.name = e.name || f.name; } });
        ShelfEditor.open({
          native: native, token: r.token, secs: r.secs, fps: r.fps, name: v.name, list: list,
          entries: entries, cards: cardsFor(v, list), lookFor: lookFor || null,
          onMarks: function (marks, secs) {
            // Your marks count like title cards Shelf read (and beat them). Shelf works the episodes out again.
            v.marks = marks; v.secs = secs || v.secs; v.manualEp = null; v.split = null;
            resolveShow(c).then(render);
          },
          mode: v.split || wantSplit || (v.episode && v.episode.needsSplit) ? 'split' : 'one',
          existing: v.split ? { pieces: v.split.pieces } : null,
          position: run.length > 1 && at >= 0 ? 'File ' + (at + 1) + ' of ' + run.length + ' of this show' : '',
          nextName: nextItem ? nextItem.name : '',
          onNext: nextItem ? function () { select(nextItem.id); openEditor(nextItem); } : null,
          preview: function (mode, ents) { return mode === 'split' ? ents.map(function (e) { return nameFor(v, [e]); }) : [nameFor(v, ents)]; },
          onSave: function (res) {
            if (res.mode === 'split') { v.split = { pieces: res.pieces }; toast('Will split into ' + res.pieces.length + ' files when you rename.'); }
            else {
              v.split = null;
              var es = res.entries, last = es[es.length - 1];
              v.manualEp = { season: es[0].season, number: es[0].number, end: last.number > es[0].number ? last.number : null, name: P.joinNames(es), entries: es };
              v.confirmed = true;
              toast('Saved: ' + nameFor(v, es));
            }
            resolveShow(c).then(render);
          }
        });
      });
    }).catch(function (e) { toast('Couldn’t open the video: ' + e.message); })
      .then(function () { btn.disabled = false; });
  }
  on('checkEps', 'click', function () { var item = itemById(selectedId); if (item) openEditor(item); });
  on('clearSplit', 'click', function () { var item = itemById(selectedId); var v = item && (linkedVideo(item) || item); if (v) { v.split = null; render(); } });
  render();
  // ---------- Looks (themes) ----------
  var THEMES = ['studio', 'seventies'];
  function syncThemePicker() {
    document.querySelectorAll('[data-theme-pick]').forEach(function (b) { b.setAttribute('aria-checked', b.dataset.themePick === settings.theme ? 'true' : 'false'); });
  }
  // Switch the look. From a click, the new room sweeps in as a circle from where you clicked.
  function setTheme(name, instant, from) {
    if (THEMES.indexOf(name) < 0) name = 'studio';
    var changed = document.documentElement.dataset.theme !== name;
    settings.theme = name; save('theme', name); syncThemePicker();
    if (native.setTheme) native.setTheme(name);
    if (!changed) return;
    var apply = function () { document.documentElement.dataset.theme = name; };
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (instant || calm || !document.startViewTransition) { apply(); return; }
    var x = from ? from.x : innerWidth / 2, y = from ? from.y : innerHeight / 2;
    var r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    var root = document.documentElement;
    root.style.setProperty('--vt-x', x + 'px'); root.style.setProperty('--vt-y', y + 'px'); root.style.setProperty('--vt-r', Math.ceil(r) + 'px');
    root.classList.add('theme-moving');
    var vt = document.startViewTransition(apply);
    vt.finished.then(function () { root.classList.remove('theme-moving'); }, function () { root.classList.remove('theme-moving'); });
  }
  document.querySelectorAll('[data-theme-pick]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      var r = b.getBoundingClientRect();
      setTheme(b.dataset.themePick, false, { x: e.clientX || r.left + r.width / 2, y: e.clientY || r.top + r.height / 2 });
    });
  });
  $('themePicker').addEventListener('keydown', function (e) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
    e.preventDefault();
    var i = THEMES.indexOf(settings.theme) + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1);
    var name = THEMES[(i + THEMES.length) % THEMES.length];
    setTheme(name); var b = document.querySelector('[data-theme-pick="' + name + '"]'); if (b) b.focus();
  });
  setTheme(settings.theme, true);
  // Renamed: a moment of joy (the Living Room theme throws a little sunburst).
  function celebrate() {
    var c = $('celebrate');
    if (!c || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    c.replaceChildren.apply(c, [0, 1, 2, 3, 4, 5].map(function () { return el('i'); }));
    c.classList.remove('go'); void c.offsetWidth; c.classList.add('go');
    clearTimeout(celebrate.t); celebrate.t = setTimeout(function () { c.classList.remove('go'); c.textContent = ''; }, 1800);
  }

  window.Shelf = { addFiles: addFiles, items: function () { return items; }, setTheme: setTheme, celebrate: celebrate }; // handy for testing
})();
