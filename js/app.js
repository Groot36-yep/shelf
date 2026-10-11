/* Shelf — app logic. */
(function () {
  'use strict';

  var P = window.ShelfParser;
  var S = window.ShelfSources;

  // ---------- Settings (kept in this browser only) ----------
  // Nothing about your files is ever stored. Only these preferences are, in this browser.
  function store(kind) { try { return window[kind]; } catch (e) { return null; } }
  function load(key, fallback, kind) {
    try { var v = store(kind || 'localStorage').getItem('shelf.' + key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function save(key, value, kind) {
    try { store(kind || 'localStorage').setItem('shelf.' + key, JSON.stringify(value)); } catch (e) { /* storage blocked: fine */ }
  }
  function forget(key, kind) { try { store(kind || 'localStorage').removeItem('shelf.' + key); } catch (e) { /* ignore */ } }

  var isWindows = /win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  var settings = {
    rememberKey: load('rememberKey', true),
    movieIds: load('movieIds', false),
    showYear: load('showYear', false),
    posters: load('posters', true),
    mode: load('mode', 'move'),
    platform: load('platform', isWindows ? 'windows' : 'mac'),
    libraryMac: load('libraryMac', load('library', '~/Media')),
    libraryWin: load('libraryWin', '~\\Videos')
  };
  settings.tmdbKey = settings.rememberKey ? load('tmdbKey', '') : load('tmdbKey', '', 'sessionStorage');

  function saveKey(key) {
    settings.tmdbKey = key;
    forget('tmdbKey'); forget('tmdbKey', 'sessionStorage');
    if (key) save('tmdbKey', key, settings.rememberKey ? 'localStorage' : 'sessionStorage');
  }
  function eraseEverything() {
    ['localStorage', 'sessionStorage'].forEach(function (kind) {
      var st = store(kind); if (!st) return;
      try { Object.keys(st).filter(function (k) { return k.indexOf('shelf.') === 0; }).forEach(function (k) { st.removeItem(k); }); } catch (e) { /* ignore */ }
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
  function makeItem(name, relPath, size) {
    var parsed = P.parseFilename(name);
    var ok = parsed.isVideo || parsed.isSubtitle;
    return {
      id: nextId++, name: name, relPath: relPath || name, size: size || 0, parsed: parsed,
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
    return {
      type: 'episode', show: c.title, showYear: c.year, id: c.id,
      season: item.parsed.season || 1, episode: item.parsed.episode || 1,
      episodeTitle: item.episode ? item.episode.name : item.parsed.episodeTitle
    };
  }

  function plexFor(item) {
    var m = matchFor(item);
    if (!m) return null;
    return P.plexName(item.parsed, m, { movieIds: settings.movieIds, showYear: settings.showYear });
  }

  function isReady(item) { return item.status === 'matched' || (item.status === 'review' && item.confirmed); }
  function needsReview(item) { return item.status === 'review' && !item.confirmed || item.status === 'nomatch' || item.status === 'error'; }

  function addFiles(list) {
    var added = 0;
    list.forEach(function (f) {
      if (/^\./.test(f.name) || /^(thumbs\.db|desktop\.ini)$/i.test(f.name)) return; // hidden/system files
      if (items.some(function (i) { return i.relPath === f.relPath; })) return;
      var it = makeItem(f.name, f.relPath, f.size);
      if (it.status === 'skipped' && !/\.(nfo|txt|jpg|jpeg|png|url)$/i.test(f.name)) { items.push(it); added++; return; }
      if (it.status === 'skipped') return; // quietly ignore artwork / nfo files
      items.push(it); added++;
    });
    normalisePaths();
    if (!selectedId && items.length) selectedId = items[0].id;
    render();
    matchAll();
    if (added) toast('Added ' + added + ' file' + (added === 1 ? '' : 's'));
  }

  // If every file came from the same top folder, paths in the script are relative to that folder.
  var scriptBase = '';
  function normalisePaths() {
    var tops = {};
    items.forEach(function (i) { var seg = i.relPath.split('/'); tops[seg.length > 1 ? seg[0] : ''] = 1; });
    var keys = Object.keys(tops);
    scriptBase = keys.length === 1 && keys[0] ? keys[0] : '';
  }
  function scriptPath(item) {
    return scriptBase && item.relPath.indexOf(scriptBase + '/') === 0 ? item.relPath.slice(scriptBase.length + 1) : item.relPath;
  }

  // ---------- Matching ----------
  var running = 0;
  function matchAll() {
    items.filter(function (i) { return i.status === 'pending'; }).forEach(function (i) { matchItem(i); });
  }

  function matchItem(item, query) {
    item.status = 'matching'; item.error = ''; item.confirmed = false;
    running++; render();
    var parsed = item.parsed;
    var title = query || parsed.title;
    var year = query ? null : parsed.year;
    item.sent = { to: item.kind === 'movie' ? 'TMDB' : 'TVmaze', text: title + (item.kind === 'movie' && year ? ' · ' + year : '') };
    var lookup;
    if (item.kind === 'movie') {
      lookup = S.searchMovies(title, year, settings.tmdbKey);
    } else {
      lookup = S.searchShows(title);
    }
    return lookup.then(function (cands) {
      var ranked = P.rankCandidates(query ? { title: query, year: null } : parsed, cands);
      item.candidates = ranked.slice(0, 6);
      item.choice = 0;
      if (!ranked.length) {
        item.status = 'nomatch';
        item.error = 'Nothing found for "' + title + '". Try searching by title below.';
        return;
      }
      var top = ranked[0];
      var status = top.score >= 78 && !ranked.ambiguous ? 'matched' : 'review';
      var error = ranked.ambiguous ? 'A few titles look alike. Pick the right one below.'
        : status === 'review' ? 'Not sure about this one. Check it below.' : '';
      if (query) { status = 'review'; error = ''; }
      var finish = function () {
        // loadEpisode may already have flagged a missing episode.
        if (item.status !== 'review') { item.status = status; item.error = error; }
      };
      if (item.kind === 'episode') return loadEpisode(item).then(finish);
      finish();
    }).catch(function (err) {
      item.status = 'error';
      item.error = err.message || 'Lookup failed';
      if (err.code === 'nokey' || err.code === 'auth') item.needsKey = true;
    }).then(function () {
      running--; render();
    });
  }

  function loadEpisode(item) {
    var c = current(item);
    if (!c) return Promise.resolve();
    var s = item.parsed.season || 1, e = item.parsed.episode || 1;
    return S.getEpisode(c.id, s, e).then(function (ep) {
      item.episode = ep;
      if (!ep) {
        item.status = 'review';
        item.error = 'Season ' + s + ', episode ' + e + ' isn\'t listed for ' + c.title + ' on TVmaze.';
      }
    }).catch(function () { item.episode = null; });
  }

  function choose(item, index) {
    item.choice = index;
    item.confirmed = true;
    item.status = 'review';
    item.error = '';
    if (item.kind === 'episode') {
      item.episode = null;
      render();
      loadEpisode(item).then(function () { item.confirmed = true; render(); });
    } else {
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
      default: t = el('span', { class: 'tag tag-err', text: item.needsKey ? 'Needs key' : 'Error' });
    }
    return t;
  }

  function renderList() {
    var list = $('list');
    list.textContent = '';
    var shown = items.filter(function (i) { return filter === 'all' || needsReview(i); });
    shown.forEach(function (item) {
      var c = current(item);
      var plex = plexFor(item);
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
          el('span', { class: 'sub', text: [fmtSize(item.size), item.parsed.resolution, item.parsed.isSubtitle ? 'Subtitle' + (item.parsed.lang ? ' · ' + item.parsed.lang.toUpperCase() : '') : ''].filter(Boolean).join(' · ') || ' ' })
        ]),
        svgArrow(),
        el('div', { class: 'cell new-cell' }, [
          el('span', { class: 'newname', text: newName }),
          el('span', { class: 'sub', text: where })
        ]),
        el('div', { class: 'match-cell' }, [tagFor(item)])
      ]);
      list.appendChild(row);
    });
    if (!shown.length && items.length) {
      list.appendChild(el('p', { class: 'muted center', style: 'padding:40px 0', text: 'Nothing needs review. Everything is matched.' }));
    }
  }

  function renderInspector() {
    var item = items.filter(function (i) { return i.id === selectedId; })[0];
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
      meta.push('Season ' + (item.parsed.season || 1) + ', Episode ' + (item.parsed.episode || 1));
      if (item.episode && item.episode.name) meta.push('“' + item.episode.name + '”');
    } else if (c && c.year) meta.push(String(c.year));
    $('inspMeta').textContent = meta.join(' · ');

    var errBox = $('inspError');
    errBox.hidden = !item.error;
    errBox.textContent = item.error;
    if (item.needsKey) {
      errBox.appendChild(document.createTextNode(' '));
      errBox.appendChild(el('button', { type: 'button', class: 'link-btn', style: 'padding:0', text: 'Open Settings', onclick: function () { openSheet('settings'); } }));
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
    if (item.parsed.resolution) fact('Quality', item.parsed.resolution);
    if (item.sent) fact('Shared with ' + item.sent.to, '“' + item.sent.text + '”');
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
          el('span', { text: (cd.network ? cd.network + ' · ' : '') + cd.score + '% match' })
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
    $('reviewCount').textContent = review;
    $('navCount').hidden = !has;
    $('navCount').textContent = items.length;
    $('subtitle').textContent = has ? items.length + ' item' + (items.length === 1 ? '' : 's') + (running ? ' · matching…' : '') : 'No items';
    $('statusText').textContent = has ? ready + ' ready to rename' + (review ? ' · ' + review + ' need' + (review === 1 ? 's' : '') + ' a look' : '') : '';
    document.querySelectorAll('#filterSeg button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.filter === filter ? 'true' : 'false'); });

    var st = $('tmdbStatus');
    st.querySelector('.dot').className = 'dot ' + (settings.tmdbKey ? 'dot-ok' : 'dot-warn');
    st.querySelector('.src-note').textContent = settings.tmdbKey ? 'Ready' : 'Add key';

    if (has) { renderList(); renderInspector(); }
    else $('inspector').hidden = true;
  }

  function select(id) {
    selectedId = id;
    render();
    var row = document.querySelector('.row-item[data-id="' + id + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  // ---------- Files in ----------
  function fromFileList(fileList) {
    return Array.prototype.map.call(fileList, function (f) {
      return { name: f.name, relPath: f.webkitRelativePath || f.name, size: f.size };
    });
  }

  function readEntry(entry, path, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(function (f) { out.push({ name: f.name, relPath: path + f.name, size: f.size }); resolve(); }, function () { resolve(); });
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        (function readBatch() {
          reader.readEntries(function (batch) {
            if (!batch.length) {
              Promise.all(all.map(function (e) { return readEntry(e, path + entry.name + '/', out); })).then(resolve);
            } else { all = all.concat(Array.prototype.slice.call(batch)); readBatch(); }
          }, function () { resolve(); });
        })();
      } else resolve();
    });
  }

  function handleDrop(e) {
    e.preventDefault();
    document.body.classList.remove('dragging');
    var dt = e.dataTransfer;
    if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
      var out = [];
      var entries = Array.prototype.map.call(dt.items, function (it) { return it.webkitGetAsEntry(); }).filter(Boolean);
      Promise.all(entries.map(function (en) { return readEntry(en, '', out); })).then(function () { addFiles(out); });
    } else if (dt.files) {
      addFiles(fromFileList(dt.files));
    }
  }

  // ---------- Sheets ----------
  function openSheet(name) {
    var d = $(name + 'Sheet');
    if (name === 'rename') prepareRename();
    if (name === 'settings') {
      $('keyInput').value = settings.tmdbKey;
      $('optIds').checked = settings.movieIds;
      $('optShowYear').checked = settings.showYear;
      $('optRemember').checked = settings.rememberKey;
      $('optPosters').checked = settings.posters;
      $('keyStatus').textContent = 'Saved only in this browser. Never sent anywhere except TMDB.';
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
    syncPlatform();
    syncMode();
  }

  function libKey() { return settings.platform === 'windows' ? 'libraryWin' : 'libraryMac'; }
  function syncPlatform() {
    var win = settings.platform === 'windows';
    document.querySelectorAll('#osSeg button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.os === settings.platform ? 'true' : 'false'); });
    $('libInput').value = settings[libKey()];
    $('libInput').placeholder = win ? '~\\Videos or D:\\Plex' : '~/Media';
    var where = scriptBase ? 'Put the script inside the “' + scriptBase + '” folder you chose.' : 'Put the script in the same folder as your videos.';
    $('scriptWhere').textContent = where;
    $('howTo').textContent = win
      ? 'Then right-click the script and choose “Run with PowerShell”. If Windows asks whether to run it, choose Open or Run once.'
      : 'Then open Terminal, type “bash ” (with a space), drag the script into the window and press Return.';
    $('dlScript').textContent = 'Download Rename Script (.' + (win ? 'ps1' : 'sh') + ')';
  }

  function syncMode() {
    document.querySelectorAll('#osSeg button').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = libKey(); settings[k] = $('libInput').value.trim() || settings[k]; save(k, settings[k]);
      settings.platform = b.dataset.os; save('platform', settings.platform); syncPlatform();
    });
  });
  document.querySelectorAll('#modeSeg button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.mode === settings.mode ? 'true' : 'false'); });
    $('modeHelp').textContent = MODE_HELP[settings.mode];
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/octet-stream' });
    var a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function buildScripts() {
    var k = libKey();
    settings[k] = $('libInput').value.trim() || (settings.platform === 'windows' ? '~\\Videos' : '~/Media');
    save(k, settings[k]);
    var list = readyItems().map(function (i) {
      var p = plexFor(i);
      return { source: scriptPath(i), folder: p.folder, file: p.file };
    });
    return P.buildScript(list, { library: settings[libKey()], mode: settings.mode, platform: settings.platform });
  }

  // ---------- Events ----------
  function on(id, ev, fn) { $(id).addEventListener(ev, fn); }

  on('fileInput', 'change', function (e) { addFiles(fromFileList(e.target.files)); e.target.value = ''; });
  on('folderInput', 'change', function (e) { addFiles(fromFileList(e.target.files)); e.target.value = ''; });
  on('sampleBtn', 'click', function () {
    addFiles(SAMPLES.map(function (n) { return { name: n, relPath: n, size: 0 }; }));
    if (!settings.tmdbKey) toast('Movies need a free TMDB key — add it in Settings. TV works right away.');
  });
  on('addBtn', 'click', function () { $('fileInput').click(); });
  on('clearBtn', 'click', function () { items = []; selectedId = null; filter = 'all'; render(); });
  on('renameBtn', 'click', function () { openSheet('rename'); });
  on('removeBtn', 'click', function () {
    var idx = items.findIndex(function (i) { return i.id === selectedId; });
    if (idx < 0) return;
    items.splice(idx, 1);
    selectedId = items.length ? items[Math.min(idx, items.length - 1)].id : null;
    normalisePaths(); render();
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

  on('dlScript', 'click', function () {
    var s = buildScripts();
    download('shelf-rename.' + s.ext, s.script);
    toast('Downloaded shelf-rename.' + s.ext);
  });
  on('dlUndo', 'click', function () {
    var s = buildScripts();
    download('shelf-undo.' + s.ext, s.undo);
    toast('Downloaded shelf-undo.' + s.ext);
  });

  on('searchForm', 'submit', function (e) {
    e.preventDefault();
    var item = items.filter(function (i) { return i.id === selectedId; })[0];
    var q = $('searchInput').value.trim();
    if (!item || !q) return;
    item.kind = $('searchKind').value;
    item.needsKey = false;
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
  on('optRemember', 'change', function (e) {
    settings.rememberKey = e.target.checked; save('rememberKey', settings.rememberKey); saveKey(settings.tmdbKey);
    toast(settings.rememberKey ? 'Your key will be remembered on this device.' : 'Your key will be forgotten when you close this tab.');
  });
  on('optPosters', 'change', function (e) { settings.posters = e.target.checked; save('posters', settings.posters); render(); });
  on('forgetKey', 'click', function () {
    saveKey(''); $('keyInput').value = ''; $('keyStatus').textContent = 'Key removed from this browser.'; render();
  });
  on('eraseAll', 'click', function () {
    eraseEverything();
    items = []; selectedId = null; filter = 'all';
    settings.tmdbKey = ''; settings.movieIds = false; settings.showYear = false; settings.posters = true; settings.rememberKey = true;
    $('privacySheet').close();
    render();
    toast('Erased. Shelf has nothing stored in this browser.');
  });
  on('optIds', 'change', function (e) { settings.movieIds = e.target.checked; save('movieIds', settings.movieIds); render(); });
  on('optShowYear', 'change', function (e) { settings.showYear = e.target.checked; save('showYear', settings.showYear); render(); });
  on('settingsSheet', 'close', function () {
    // Retry anything that failed for lack of a key.
    if (!settings.tmdbKey) return;
    items.forEach(function (i) { if (i.needsKey) { i.needsKey = false; i.status = 'pending'; } });
    matchAll();
  });

  // Drag and drop anywhere
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { dragDepth = 0; handleDrop(e); });

  // Keyboard: arrow keys move through the list
  document.addEventListener('keydown', function (e) {
    if (!items.length || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var shown = items.filter(function (i) { return filter === 'all' || needsReview(i); });
    var idx = shown.findIndex(function (i) { return i.id === selectedId; });
    var next = shown[Math.max(0, Math.min(shown.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { e.preventDefault(); select(next.id); }
  });

  render();
  window.Shelf = { addFiles: addFiles, items: function () { return items; } }; // handy for testing
})();
