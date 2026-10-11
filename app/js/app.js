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

  function isReady(item) { return !item.epBlock && (item.status === 'matched' || (item.status === 'review' && item.confirmed)); }
  function needsReview(item) { return item.status === 'review' && (!item.confirmed || item.epBlock) || item.status === 'nomatch' || item.status === 'error'; }

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
          var fileCtx = Object.assign({}, ctx, { file: { minutes: i.minutes || null, cards: i.cards || null, parts: i.cardParts || null } });
          var r = P.resolveEpisode(i.parsed, list, fileCtx);
          var s = i.parsed.season != null ? i.parsed.season : 1, e = i.parsed.episode || 1;
          i.showKeyId = id;
          i.segmented = !!ctx.segmented;
          i.numberMode = i.minutes && ctx.segmented ? (i.minutes <= 15 ? 'segments' : 'halfhours') : ctx.mode;
          i.numberSure = !!(i.minutes && ctx.segmented) || ctx.sure !== false && !!(chosen || det.sure);
          i.episode = r ? { season: r.season, number: r.number, end: r.end, name: r.name, how: r.how } : null;
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
    switch (item.status) {
      case 'pending': case 'matching':
        t = el('span', { class: 'tag tag-wait' }, [el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Matching']); break;
      case 'matched': t = el('span', { class: 'tag tag-ok', text: (current(item) ? current(item).score : '') + '%' }); break;
      case 'review': t = item.confirmed ? el('span', { class: 'tag tag-ok', text: 'Confirmed' }) : el('span', { class: 'tag tag-warn', text: 'Review' }); break;
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
      // Rows that haven't changed are reused, not rebuilt: keeps long lists smooth.
      var sig = [item.status, item.confirmed, item.needsKey, c ? c.id + ':' + c.score + ':' + (settings.posters ? c.poster : '') : '', plex ? plex.folder.join('/') + '/' + plex.file : '', item.parsed.title].join('|');
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
      var newName = plex ? plex.file : (item.status === 'skipped' ? '—' : item.status === 'matching' || item.status === 'pending' ? 'Looking up “' + (item.parsed.title || item.name) + '”…' : 'Not matched yet');
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
      var epInfo = item.episode && item.episode.number != null ? item.episode : null;
      if (item.parsed.airdate && !epInfo) meta.push('Aired ' + item.parsed.airdate);
      else {
        var sN = epInfo ? epInfo.season : item.parsed.season != null ? item.parsed.season : 1;
        var eN = epInfo ? epInfo.number : item.parsed.episode || 1;
        var eEnd = epInfo ? epInfo.end : item.parsed.episodeEnd;
        meta.push((sN === 0 ? 'Special' : 'Season ' + sN + ',') + (eEnd ? ' Episodes ' + eN + '–' + eEnd : ' Episode ' + eN));
      }
      if (item.episode && item.episode.name) meta.push('“' + item.episode.name + '”');
    } else if (c && c.year) meta.push(String(c.year));
    $('inspMeta').textContent = meta.join(' · ');

    var errBox = $('inspError');
    errBox.hidden = !item.error;
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
    var segWrap = $('inspSegWrap');
    segWrap.hidden = !(item.kind === 'episode' && item.segmented);
    $('readCards').hidden = !settings.cardScan;
    $('checkLengths').disabled = $('readCards').disabled = scanning || !item.fullPath;
    document.querySelectorAll('#inspSeg button').forEach(function (b) {
      b.setAttribute('aria-pressed', item.numberSure && b.dataset.mode === item.numberMode ? 'true' : 'false');
    });

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
      var readNames = item.episode && item.episode.how === 'card' ? item.episode.name : '';
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
    $('inspFile').textContent = plex ? plex.file : 'Pick a match to see the new name.';

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
  function handleDrop(e) {
    e.preventDefault();
    document.body.classList.remove('dragging');
    var dt = e.dataTransfer;
    native.expandDropped(dt.files).then(addFiles);
  }

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
      ' will get Plex names.' + (waiting ? ' ' + waiting + ' still need' + (waiting === 1 ? 's' : '') + ' a look and will be left alone.' : '');
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
      var ops = real.map(function (i) { var p = plexFor(i); byPath[i.fullPath] = i; return { source: i.fullPath, folder: p.folder, file: p.file }; });
      var btn = $('renameNow');
      btn.disabled = true;
      var stop = native.onProgress(function (p) { btn.textContent = 'Renaming ' + p.done + ' of ' + p.total + '…'; });
      native.rename(ops, settings.mode).then(function (results) {
        var ok = 0, skipped = 0, failed = 0;
        results.forEach(function (r) {
          var item = byPath[r.source];
          if (!item) return;
          if (r.ok && r.to) { ok++; item.status = 'done'; item.error = ''; item.origPath = item.fullPath; if (settings.mode === 'move') item.fullPath = r.to; item.newPath = r.to; }
          else if (r.ok || r.skipped) { skipped++; item.error = r.skipped || ''; }
          else { failed++; item.error = 'Couldn’t rename: ' + r.error; }
        });
        $('renameSheet').close();
        $('undoBar').hidden = !ok;
        render();
        toast('Renamed ' + ok + ' file' + (ok === 1 ? '' : 's') + (skipped ? ', skipped ' + skipped : '') + (failed ? ', ' + failed + ' failed (see details)' : '') + '.');
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
  on('clearBtn', 'click', function () { items = []; showChoices = {}; selectedId = null; filter = 'all'; render(); });
  on('renameBtn', 'click', function () { openSheet('rename'); });
  on('removeBtn', 'click', function () {
    var idx = items.findIndex(function (i) { return i.id === selectedId; });
    if (idx < 0) return;
    items.splice(idx, 1);
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
    items = []; selectedId = null; filter = 'all';
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
      var got = 0;
      files.forEach(function (i) { var secs = res[i.fullPath]; if (secs) { i.minutes = secs / 60; got++; } });
      setScanStatus(got ? 'Checked ' + got + ' of ' + files.length + ' videos.' : 'Couldn’t tell the length of these videos (unusual format).');
      return resolveShow(current(linkedVideo(item) || item));
    }).catch(function (e) { setScanStatus('Couldn’t check: ' + e.message); })
      .then(function () { scanning = false; render(); });
  });
  on('readCards', 'click', function () {
    var item = itemById(selectedId); if (!item || scanning) return;
    var files = showFiles(item); if (!files.length) return;
    var c = current(linkedVideo(item) || item);
    scanning = true; setScanStatus('Waiting for your OK…');
    var stop = native.onCardProgress(function (p) {
      if (p.done < p.total) { setScanStatus('Reading title cards: video ' + (p.done + 1) + ' of ' + p.total + '…'); $('cancelCards').hidden = false; }
    });
    listFor(c).then(function (list) {
      var titles = list.filter(function (e) { return e.number != null && e.name; }).map(function (e) { return e.name; });
      return native.readCards(files.map(function (i) { return { path: i.fullPath, titles: titles }; }));
    }).then(function (res) {
      if (!res) { setScanStatus('Cancelled. No videos were read.'); return; }
      var read = 0;
      files.forEach(function (i) {
        var r = res[i.fullPath]; if (!r) return;
        if (r.secs) i.minutes = r.secs / 60;
        if (r.texts) { i.cards = r.texts; i.cardParts = r.parts; read++; }
      });
      setScanStatus('Read ' + read + ' of ' + files.length + ' videos.');
      return resolveShow(c);
    }).catch(function (e) { setScanStatus('Couldn’t read the title cards: ' + e.message); })
      .then(function () { stop(); scanning = false; $('cancelCards').hidden = true; render(); });
  });
  on('cancelCards', 'click', function () { native.cancelCards(); setScanStatus('Stopping…'); });
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
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
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
  on('checkUpdates', 'click', function () {
    // Opens the downloads page in your browser. Shelf itself never checks in anywhere.
    window.open('https://github.com/Groot36-yep/shelf/releases/latest', '_blank');
  });

  render();
  window.Shelf = { addFiles: addFiles, items: function () { return items; } }; // handy for testing
})();
