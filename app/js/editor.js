/*
 * Shelf — the "Check Episodes" window: see which episodes a video holds, check where each starts,
 * and (only if you choose) split it into one file per episode. Plus the episode browser.
 *
 * The timeline playhead is a true scrubber: dragging anywhere moves the playhead, never a cut.
 * Cuts only change with the "Set Cut Here" / "Add Cut" buttons (or their keys).
 */
(function (root) {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'style') n.style.cssText = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function fmt(t, precise) {
    t = Math.max(0, t || 0);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t - h * 3600 - m * 60;
    var ss = precise === false ? String(Math.floor(s)).padStart(2, '0') : (s < 10 ? '0' : '') + s.toFixed(1);
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + ss;
  }
  function code(e) { return 'S' + String(e.season).padStart(2, '0') + 'E' + String(e.number).padStart(2, '0'); }
  function keyOf(e) { return e ? e.season + 'x' + e.number : ''; }
  function svg(path) {
    var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path'); p.setAttribute('d', path); s.appendChild(p);
    return s;
  }
  // Brief "pressed" glow on a button, also when triggered by a key.
  // (Restarted a frame later rather than by forcing the page to lay itself out on the spot,
  // which on a big window costs a noticeable moment every time.)
  function replay(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    requestAnimationFrame(function () { requestAnimationFrame(function () { node.classList.add(cls); }); });
  }
  function hit(btn) { replay(btn, 'is-hit'); }
  // The status line under the timeline (eases in when it changes).
  function info(text) { var n = $('edInfo'); if (n.textContent === text) return; n.textContent = text; replay(n, 'swap'); }
  function scissors() {
    var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>';
    return s;
  }
  // Where the episode's title sits in what Shelf read, so it can be highlighted.
  function marked(text, name) {
    var t = String(text || ''), lo = t.toLowerCase(), n = String(name || '').toLowerCase(), at = lo.indexOf(n), len = n.length;
    if (at < 0) {
      var words = n.split(/\s+/).filter(function (w) { return w.length >= 4; }).sort(function (a, b) { return b.length - a.length; });
      for (var i = 0; i < words.length && at < 0; i++) { at = lo.indexOf(words[i]); len = words[i].length; }
    }
    if (at < 0) return [document.createTextNode(t.length > 48 ? t.slice(0, 47) + '…' : t)];
    var a = Math.max(0, at - 14), z = Math.min(t.length, at + len + 14);
    return [document.createTextNode((a ? '…' : '') + t.slice(a, at)), el('mark', { text: t.slice(at, at + len) }), document.createTextNode(t.slice(at + len, z) + (z < t.length ? '…' : ''))];
  }

  // =====================================================================
  // Episode browser: seasons as tabs, search across all, clear current marks.
  // =====================================================================
  var eb = { onPick: null, list: [], season: null, sel: 0, rows: [], marked: {} };
  function browse(anchor, opts) {
    var box = $('epBrowser');
    var host = anchor.closest('dialog[open]') || document.body;
    if (box.parentNode !== host) host.appendChild(box);
    eb.list = (opts.list || []).filter(function (e) { return e.number != null; });
    eb.onPick = opts.onPick; eb.marked = {};
    (opts.marked || []).forEach(function (e) { eb.marked[keyOf(e)] = 1; });
    var seasons = []; eb.list.forEach(function (e) { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); });
    seasons.sort(function (a, b) { return (a === 0) - (b === 0) || a - b; });
    eb.season = opts.season != null && seasons.indexOf(opts.season) >= 0 ? opts.season : seasons[0];
    $('ebTitle').textContent = opts.title || 'Choose the episode';
    var tabs = $('ebSeasons'); tabs.textContent = '';
    seasons.forEach(function (sn) {
      tabs.appendChild(el('button', { type: 'button', 'data-season': sn, 'aria-pressed': sn === eb.season ? 'true' : 'false', text: sn === 0 ? 'Specials' : 'Season ' + sn,
        onclick: function () { eb.season = sn; $('ebSearch').value = ''; ebRender(); } }));
    });
    // Place it next to the button, inside the window it belongs to.
    var a = anchor.getBoundingClientRect(), h = host.getBoundingClientRect();
    var W = 420, H = 460;
    var hostW = host === document.body ? window.innerWidth : h.width, hostH = host === document.body ? window.innerHeight : h.height;
    var left = clamp(a.left - h.left + (host.scrollLeft || 0) - 40, 8, hostW - W - 8);
    var top = a.bottom - h.top + (host.scrollTop || 0) + 6;
    if (a.bottom + H + 12 > window.innerHeight) top = Math.max(8, a.top - h.top + (host.scrollTop || 0) - H - 6);
    box.style.left = left + 'px'; box.style.top = top + 'px';
    box.hidden = false;
    $('ebSearch').value = '';
    ebRender();
    setTimeout(function () { $('ebSearch').focus(); }, 0);
  }
  function ebClose() { $('epBrowser').hidden = true; eb.onPick = null; }
  function ebRender() {
    var q = $('ebSearch').value.trim();
    var rows;
    var se = q.match(/^s?(\d{1,2})\s*[ex]\s*(\d{1,3})$/i);
    if (se) rows = eb.list.filter(function (e) { return e.season === +se[1] && e.number === +se[2]; });
    else if (/^\d{1,3}$/.test(q)) rows = eb.list.filter(function (e) { return e.number === +q && (e.season === eb.season); }).concat(eb.list.filter(function (e) { return e.number === +q && e.season !== eb.season; }));
    else if (q) {
      var ql = q.toLowerCase();
      var sim = root.ShelfParser && root.ShelfParser.titleSimilarity;
      rows = eb.list.map(function (e) {
        var nm = (e.name || '').toLowerCase();
        var s = nm.indexOf(ql) === 0 ? 3 : nm.indexOf(ql) > 0 ? 2 : sim ? sim(q, e.name) : 0;
        return { e: e, s: s };
      }).filter(function (x) { return x.s >= 0.55; }).sort(function (a, b) { return b.s - a.s; }).map(function (x) { return x.e; });
    } else rows = eb.list.filter(function (e) { return e.season === eb.season; });
    // Searching looks across every season; the tabs show where you are.
    document.querySelectorAll('#ebSeasons button').forEach(function (b) { b.setAttribute('aria-pressed', !q && +b.dataset.season === eb.season ? 'true' : 'false'); });
    eb.rows = rows.slice(0, 300);
    eb.sel = Math.max(0, eb.rows.findIndex(function (e) { return eb.marked[keyOf(e)]; }));
    var list = $('ebList'); list.textContent = '';
    if (!eb.rows.length) { list.appendChild(el('p', { class: 'eb-empty', text: q ? 'No episode matches “' + q + '”. Try part of the title, or a number like S01E08.' : 'No episodes listed.' })); return; }
    eb.rows.forEach(function (e, i) {
      var on = eb.marked[keyOf(e)];
      list.appendChild(el('button', { type: 'button', class: 'eb-row' + (i === eb.sel ? ' is-sel' : '') + (on ? ' is-marked' : ''), role: 'option', 'aria-selected': i === eb.sel ? 'true' : 'false',
        onclick: function () { ebPick(e); }, onmousemove: function () { if (eb.sel !== i) { eb.sel = i; ebMark(); } } }, [
        el('span', { class: 'eb-code', text: code(e) }),
        el('span', { class: 'eb-name', text: e.name || '(no title)' }),
        el('span', { class: 'eb-meta', text: [e.aired ? e.aired.slice(0, 4) : '', e.runtime ? e.runtime + ' min' : ''].filter(Boolean).join(' · ') }),
        on ? el('span', { class: 'eb-on', text: '✓' }) : el('span')
      ]));
    });
    ebMark(true);
  }
  function ebMark(scroll) {
    document.querySelectorAll('#ebList .eb-row').forEach(function (b, i) {
      b.classList.toggle('is-sel', i === eb.sel); b.setAttribute('aria-selected', i === eb.sel ? 'true' : 'false');
      if (scroll && i === eb.sel) b.scrollIntoView({ block: 'nearest' });
    });
  }
  function ebPick(e) { var fn = eb.onPick; ebClose(); if (fn) fn(e); }
  function ebWire() {
    $('ebSearch').addEventListener('input', ebRender);
    $('ebSearch').addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); ebClose(); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); eb.sel = clamp(eb.sel + (ev.key === 'ArrowDown' ? 1 : -1), 0, eb.rows.length - 1); ebMark(true); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (eb.rows[eb.sel]) ebPick(eb.rows[eb.sel]); }
    });
    $('ebClose').addEventListener('click', ebClose);
    document.addEventListener('mousedown', function (ev) {
      var box = $('epBrowser');
      if (!box.hidden && !box.contains(ev.target) && !ev.target.closest('[data-opens-browser]')) ebClose();
    }, true);
  }

  // =====================================================================
  // The Check Episodes window
  // =====================================================================
  var st = null;
  // Still frames of title cards, fetched once per window (each one is a small job for the video
  // tool; redrawing the panel must never ask for them again).
  var frames = new Map();
  function frameImg(t, w, alt) {
    var key = st.token + '@' + t.toFixed(2) + '@' + w, img = el('img', { alt: alt || '', decoding: 'async' });
    if (!frames.has(key)) frames.set(key, st.o.native.mediaFrame(st.token, t, w).then(function (b) { return b ? URL.createObjectURL(new Blob([b], { type: 'image/jpeg' })) : null; }).catch(function () { return null; }));
    frames.get(key).then(function (u) { if (u) img.src = u; });
    return img;
  }
  function dropFrames() { frames.forEach(function (p) { p.then(function (u) { if (u) URL.revokeObjectURL(u); }); }); frames = new Map(); }
  var ZOOMS = [0, 600, 180, 60, 20, 6]; // 0 = whole video
  var video, seeking = false, pendingSeek = null, rafId = 0, frameTimer = 0;

  function open(o) {
    st = {
      o: o, token: o.token, secs: o.secs || 1320, fps: o.fps || 24, list: o.list || [],
      mode: o.mode || 'one', cuts: [], parts: [], oneEntries: [], sel: 0, t: 0,
      cards: (o.cards || []).slice().sort(function (a, b) { return a.t - b.t; }),
      gaps: [], keys: [], zoom: 0, view: { a: 0, b: o.secs || 1320 }, playable: true, suggested: false, rate: 1
    };
    var ent = (o.entries || []).slice();
    st.oneEntries = ent.length ? ent : [];
    if (o.existing && o.existing.pieces) {
      st.mode = 'split';
      st.cuts = o.existing.pieces.slice(1).map(function (p) { return p.start; });
      st.parts = o.existing.pieces.map(function (p) { return { entry: p.entry }; });
      st.suggested = true;
    } else {
      st.parts = (ent.length ? ent : [null]).map(function (e) { return { entry: e }; });
    }
    $('edFile').textContent = o.name + (o.position ? '   ·   ' + o.position : '');
    info('');
    $('edBusy').hidden = true;
    video = $('edVideo');
    video.hidden = false; $('edFrame').hidden = true; $('edQuick').hidden = true; $('edFallback').hidden = true;
    seeking = false; pendingSeek = null;
    $('edPlay').disabled = false; $('edAround').disabled = false; document.querySelectorAll('#edSpeed button').forEach(function (b) { b.disabled = false; b.setAttribute('aria-pressed', b.dataset.rate === '1' ? 'true' : 'false'); });
    video.playbackRate = 1;
    video.src = 'shelf-media://v/' + st.token;
    video.onerror = function () { useFrames('this video format can’t play inside Shelf'); };
    video.onloadedmetadata = function () {
      if (!st) return;
      if (video.videoWidth === 0) { useFrames('this video’s picture can’t play inside Shelf'); return; }
      seeking = false; pendingSeek = null; doSeek(st.t);
    };
    video.onseeked = function () {
      seeking = false;
      if (pendingSeek != null) { var t = pendingSeek; pendingSeek = null; doSeek(t); return; }
      // The real frame is on screen: take the quick preview picture (and any stand-in frame) away.
      if (st && st.playable && !st.dragging) { $('edQuick').hidden = true; if (Math.abs(video.currentTime - st.t) < 0.06) { clearTimeout(assistTimer); $('edFrame').hidden = true; } }
    };
    video.onplay = function () { clearTimeout(assistTimer); $('edFrame').hidden = true; $('edQuick').hidden = true; syncPlay(); };
    video.onpause = syncPlay;
    var whole = 'shelf-media://s/' + st.token + '?from=0&to=' + st.secs.toFixed(1) + '&n=48&w=96&key=1';
    $('edStripBase').src = whole; st.baseStrip = { url: whole, a: 0, b: st.secs, n: 48 };
    st.scrub = null; st.tlStrip = null; st.oldStrip = null;
    ['edStripImg', 'edStripOld'].forEach(function (id) { $(id).removeAttribute('src'); $(id).classList.add('is-off'); });
    $('edTotal').textContent = '/ ' + fmt(st.secs, false);
    lastHead = {}; syncPlay();
    $('editorSheet').showModal();
    setMode(st.mode, true);
    // Start just before the first title card, or the first cut.
    var startAt = st.cuts.length ? st.cuts[0] - 3 : st.cards.length ? st.cards[0].start || st.cards[0].t : 0;
    var look = o.lookFor; // looking for a title card Shelf couldn't read: start where it usually is
    if (look) startAt = look.part ? Math.max(0, st.secs * look.part / look.of - 20) : Math.min(40, st.secs * 0.04);
    setZoom(st.cuts.length || st.cards.length || look ? 3 : 0, startAt, true);
    seek(startAt);
    if (look) setTimeout(function () { if (st) info('Find the title card for ' + (look.of > 1 ? 'part ' + (look.part + 1) : 'this video') + ' (play or scrub), then click Mark Title Card Here.'); }, 0);
    loop();
  }

  function close(keepBatch) {
    if (!st) return;
    cancelAnimationFrame(rafId); clearTimeout(frameTimer); clearTimeout(assistTimer); clearTimeout(stripTimer); clearTimeout(marksTimer);
    var o = st.o, token = st.token, marks = st.pendingMarks;
    st = null; ebClose();
    video.pause();
    // The window goes away at once; letting go of the video and its pictures happens just after,
    // so closing never waits on them.
    if ($('editorSheet').open) $('editorSheet').close();
    if (marks) o.onMarks(marks.list, marks.secs);
    setTimeout(function () {
      if (st) return; // opened again meanwhile
      video.removeAttribute('src'); video.load();
      ['edStripBase', 'edStripImg', 'edStripOld'].forEach(function (id) { $(id).removeAttribute('src'); });
      dropFrames();
    }, 60);
    o.native.closeSplit(token, keepBatch === true ? false : true);
    if (o.onClose) o.onClose();
  }

  function useFrames(why) {
    if (!st || !st.playable) return;
    st.playable = false;
    video.hidden = true; $('edFrame').hidden = false; $('edQuick').hidden = false;
    $('edFallback').hidden = false; $('edFallback').textContent = 'Frame preview: ' + why;
    $('edPlay').disabled = true; $('edAround').disabled = true; $('edAround').title = 'Can’t play this video inside Shelf; scrub or step through it instead';
    document.querySelectorAll('#edSpeed button').forEach(function (b) { b.disabled = true; });
    seek(st.t);
  }

  // ---- Playhead ----
  // Ask the player to jump; only one jump at a time (the latest wins), and never before the video
  // has loaded (a jump then is silently ignored and would never report back).
  var seekStarted = 0;
  function doSeek(t) {
    if (video.readyState < 1) { pendingSeek = t; return; }
    seeking = true; seekStarted = Date.now();
    video.currentTime = t;
  }
  function seek(t, dragging) {
    if (!st || !isFinite(t)) return;
    t = clamp(t, 0, Math.max(0, st.secs - 0.04));
    st.t = t;
    // A jump that never reported back (rare) doesn't block the next one.
    if (seeking && Date.now() - seekStarted > 1500) seeking = false;
    if (st.playable) {
      // While dragging, a quick preview picture follows your hand at once; the player catches up
      // behind it, and the real frame replaces it the moment it's ready.
      if (dragging) proxy($('edQuick'), t);
      if (seeking || video.readyState < 1) pendingSeek = t; else doSeek(t);
      if (!dragging) assist(t);
    } else showFrame(t);
    if (!dragging) keepInView(t);
    drawHead();
  }
  // Some videos (many MKVs) make the player read through the file to reach a spot, so a jump can
  // take a while. If the player hasn't caught up shortly after you stop, show the exact frame
  // (fetched directly, which is fast) until it has.
  var assistTimer = 0;
  function assist(t) {
    clearTimeout(assistTimer);
    assistTimer = setTimeout(function () {
      if (!st || !st.playable || st.dragging || !video.paused || Math.abs(st.t - t) > 0.001) return;
      if (!seeking && pendingSeek == null && Math.abs(video.currentTime - t) < 0.06) return;
      var img = new Image();
      img.onload = function () {
        if (!st || Math.abs(st.t - t) > 0.001 || st.dragging) return;
        if (!seeking && pendingSeek == null && Math.abs(video.currentTime - t) < 0.06) return; // caught up meanwhile
        var f = $('edFrame'); f.src = img.src; f.hidden = false; $('edQuick').hidden = true;
      };
      img.src = 'shelf-media://f/' + st.token + '?t=' + t.toFixed(3) + '&w=1280&slot=exact';
    }, 120);
  }
  // The best quick picture for a moment: the dense one for this view, else the whole-video one.
  function proxyFor(t) {
    var list = [st.scrub, st.tlStrip, st.baseStrip];
    for (var k = 0; k < list.length; k++) { var x = list[k]; if (x && x.n && t >= x.a && t <= x.b) return x; }
    return null;
  }
  function proxy(node, t) {
    var tl = proxyFor(t);
    if (!tl) return false;
    var i = clamp(Math.round((t - tl.a) / (tl.b - tl.a) * tl.n - 0.5), 0, tl.n - 1);
    node.style.backgroundImage = 'url("' + tl.url + '")';
    node.style.backgroundSize = (tl.n * 100) + '% 100%';
    node.style.backgroundPosition = (tl.n > 1 ? i / (tl.n - 1) * 100 : 0) + '% 0';
    node.hidden = false;
    return true;
  }
  // Without the player: show the nearest strip frame at once, then the exact frame when you pause.
  function showFrame(t) {
    proxy($('edQuick'), t);
    clearTimeout(frameTimer);
    frameTimer = setTimeout(function () {
      if (!st) return;
      var img = new Image();
      img.onload = function () { if (st && Math.abs(st.t - t) < 0.01) { $('edFrame').src = img.src; } };
      img.src = 'shelf-media://f/' + st.token + '?t=' + t.toFixed(3) + '&w=960&slot=exact';
    }, 110);
  }
  function now() { return st ? (st.playable && !seeking && pendingSeek == null ? video.currentTime : st.t) : 0; }
  function loop() {
    if (!st) return;
    if (st.playable && !video.paused) {
      st.t = video.currentTime;
      if (st.stopAt != null && st.t >= st.stopAt) { video.pause(); st.stopAt = null; }
      keepInView(st.t, true);
      drawHead();
    }
    rafId = requestAnimationFrame(loop);
  }
  var PLAY = 'M8 5.5v13l10.5-6.5z', PAUSE = 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z';
  function syncPlay() {
    var playing = st && st.playable && !video.paused, b = $('edPlay');
    b.setAttribute('aria-pressed', playing ? 'true' : 'false');
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    b.querySelector('path').setAttribute('d', playing ? PAUSE : PLAY);
  }
  function play(from, to) {
    if (!st || !st.playable) return;
    if (from != null) seek(from);
    st.stopAt = to != null ? to : null;
    video.play();
  }
  // A soft flash on the picture, so a jump is felt.
  function flash() { replay($('edFlash'), 'go'); }

  // ---- Which part the playhead is in ----
  function bounds() { return [0].concat(st.mode === 'split' ? st.cuts : [], [st.secs]); }
  function partAt(t) { var b = bounds(); for (var i = 0; i < b.length - 1; i++) if (t < b[i + 1]) return i; return b.length - 2; }
  function cardStart(c) { return c.start != null ? c.start : c.t; }
  // The title card the big button jumps to: the one you're at, else the next one (else the last).
  function cardTarget() {
    var t = st.t, at = st.cards.filter(function (c) { return Math.abs(cardStart(c) - t) < 0.6 || (t >= cardStart(c) && t <= c.t + 1); })[0];
    if (at) return { c: at, at: true };
    var nx = st.cards.filter(function (c) { return cardStart(c) > t; })[0];
    return { c: nx || st.cards[st.cards.length - 1], at: false };
  }
  var lastHead = {};
  function drawHead() {
    markBtn();
    if (!st) return;
    var t = st.t, txt = fmt(t);
    if (lastHead.clock !== txt) { $('edClock').textContent = txt; lastHead.clock = txt; }
    var v = st.view, pct = (t - v.a) / (v.b - v.a) * 100, head = $('edHead');
    head.style.left = pct + '%'; head.hidden = pct < 0 || pct > 100;

    // Which part / episode you're in: chip on the picture, highlighted in the lane and the panel.
    var i = partAt(t), split = st.mode === 'split', part = split ? st.parts[i] : null;
    var key = st.mode + ':' + i + ':' + (part && part.entry ? keyOf(part.entry) : '');
    if (lastHead.part !== key) {
      lastHead.part = key;
      var chip = $('edPartChip');
      if (split && part) {
        chip.hidden = false; chip.dataset.part = i % 2;
        chip.replaceChildren(el('i', { text: String(i + 1) }), part.entry ? el('code', { text: code(part.entry) }) : null, el('span', { text: part.entry ? part.entry.name : 'Choose an episode' }));
      } else chip.hidden = true;
      document.querySelectorAll('#edParts .ed-seg').forEach(function (n, k) { n.classList.toggle('is-cur', split && k === i); });
      document.querySelectorAll('#edPanel .ed-part').forEach(function (n, k) { n.classList.toggle('is-cur', split && k === i); });
    }
    // The title-card button on the picture.
    var nav = $('edCardNav');
    nav.hidden = !st.cards.length;
    if (st.cards.length) {
      var tg = cardTarget(), ck = (tg.at ? 'at:' : 'to:') + tg.c.key;
      if (lastHead.card !== ck) {
        lastHead.card = ck;
        $('edCardVerb').textContent = tg.at ? 'Title card' : 'Jump to';
        $('edCardName').textContent = '“' + tg.c.name + '”';
        $('edCardTime').textContent = fmt(tg.c.t, false);
        $('edCardJump').classList.toggle('is-at', tg.at);
        $('edCardJump').title = tg.at ? 'You’re at the title card Shelf read for “' + tg.c.name + '”' : 'Jump to the title card “' + tg.c.name + '” (' + fmt(tg.c.t) + ')';
        document.querySelectorAll('#edCardList .ed-chip').forEach(function (n) { n.classList.toggle('is-at', tg.at && n.dataset.key === tg.c.key); });
      }
    }
  }

  // ---- Zoom + timeline ----
  var zoomAnim = 0;
  function setZoom(z, center, instant) {
    if (!st) return;
    st.zoom = clamp(z, 0, ZOOMS.length - 1);
    var span = Math.min(ZOOMS[st.zoom] || st.secs, st.secs);
    var c = center != null ? center : st.t;
    var a = clamp(c - span / 2, 0, Math.max(0, st.secs - span));
    $('edZoomLabel').textContent = st.zoom === 0 ? 'Whole video' : (span >= 60 ? Math.round(span / 60) + ' min' : Math.round(span) + ' sec') + ' view';
    $('edZoomOut').disabled = st.zoom === 0; $('edZoomIn').disabled = st.zoom === ZOOMS.length - 1;
    var sl = $('edZoomSlider'); sl.value = st.zoom; sl.style.setProperty('--fill-pct', (st.zoom / (ZOOMS.length - 1) * 100) + '%');
    animateView({ a: a, b: a + span }, instant);
  }
  // Glide the visible stretch to its new place (zooming feels continuous, not a jump).
  function animateView(to, instant) {
    cancelAnimationFrame(zoomAnim);
    var from = st.view, t0 = performance.now(), dur = 220;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (instant || reduce || (Math.abs(from.a - to.a) < 1e-3 && Math.abs(from.b - to.b) < 1e-3)) { st.view = to; drawTimeline(); return; }
    // Interpolate in log-space for the width, so zooming in and out feel even.
    var w0 = Math.log(from.b - from.a), w1 = Math.log(to.b - to.a);
    var c0 = (from.a + from.b) / 2, c1 = (to.a + to.b) / 2;
    (function stepAnim() {
      if (!st) return;
      var k = Math.min(1, (performance.now() - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      var w = Math.exp(w0 + (w1 - w0) * e), c = c0 + (c1 - c0) * e;
      st.view = k < 1 ? { a: c - w / 2, b: c + w / 2 } : to;
      drawTimeline(k < 1);
      if (k < 1) zoomAnim = requestAnimationFrame(stepAnim);
    })();
  }
  function keepInView(t, follow) {
    var v = st.view, span = v.b - v.a;
    if (t < v.a || t > v.b) {
      var a = clamp(follow ? t - span * 0.1 : t - span / 2, 0, Math.max(0, st.secs - span));
      if (follow) { st.view = { a: a, b: a + span }; drawTimeline(); } else animateView({ a: a, b: a + span });
    }
  }
  // Put a strip picture where its stretch of video is, in the current view.
  function placeStrip(img, s0) {
    if (!s0) return;
    var v = st.view, span = v.b - v.a;
    img.style.left = ((s0.a - v.a) / span * 100) + '%';
    img.style.width = ((s0.b - s0.a) / span * 100) + '%';
  }
  var stripTimer = 0;
  function drawTimeline(moving) {
    if (!st) return;
    var v = st.view, span = v.b - v.a, X = function (t) { return (t - v.a) / span * 100; };
    // Ruler: labelled ticks, with small ones in between.
    var ticks = $('edTicks'), tk = [];
    var steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    var step = steps.filter(function (s2) { return span / s2 <= 10; })[0] || 600;
    var minor = step / (step >= 60 ? 4 : step >= 10 ? 5 : step >= 2 ? 4 : 5);
    for (var m = Math.ceil(v.a / minor) * minor; m <= v.b; m += minor) {
      var major = Math.abs(m / step - Math.round(m / step)) < 1e-6;
      tk.push(el('span', { class: 'ed-tick' + (major ? '' : ' minor'), style: 'left:' + X(m) + '%' }, major ? [el('i', { text: fmt(m, step < 1 ? undefined : false) })] : null));
    }
    ticks.replaceChildren.apply(ticks, tk);
    // The episode lane, and the parts on the overview.
    var b = bounds(), split = st.mode === 'split', lane = [], ov = [], cur = partAt(st.t);
    for (var i = 0; i < b.length - 1; i++) {
      var e = split ? st.parts[i] && st.parts[i].entry : null;
      var label = split
        ? (e ? [el('code', { text: code(e) }), el('span', { text: e.name })] : [el('span', { text: 'Part ' + (i + 1) + ': choose an episode' })])
        : (st.oneEntries.length ? [el('code', { text: st.oneEntries.map(code).join(' + ') }), el('span', { text: st.oneEntries.map(function (x) { return x.name; }).join(' & ') })] : [el('span', { text: 'Choose which episode this is' })]);
      lane.push(el('div', { class: 'ed-seg' + ((split ? !e : !st.oneEntries.length) ? ' is-empty' : '') + (split && i === cur ? ' is-cur' : ''), 'data-part': i % 2,
        style: 'left:' + X(b[i]) + '%;width:' + ((b[i + 1] - b[i]) / span * 100) + '%' }, [el('div', {}, label)]));
    }
    $('edParts').replaceChildren.apply($('edParts'), lane);
    // Marks: quiet gaps, title cards, cuts
    var mk = [], om = [];
    st.gaps.forEach(function (g) {
      if (g.b < v.a || g.a > v.b) return;
      mk.push(el('div', { class: 'ed-gap ' + g.kind, title: (g.kind === 'black' ? 'Black screen ' : 'Silence ') + fmt(g.a) + ' – ' + fmt(g.b), style: 'left:' + X(g.a) + '%;width:' + Math.max(0.2, (g.b - g.a) / span * 100) + '%' }));
    });
    st.cards.forEach(function (c) {
      if (c.t < v.a || c.t > v.b) return;
      mk.push(el('div', { class: 'ed-card' + (c.manual ? ' is-manual' : ''), style: 'left:' + X(c.t) + '%' }, [el('button', { type: 'button', 'data-card': c.key, title: 'Title card “' + c.name + '”, ' + (c.manual ? 'marked by you' : 'read') + ' at ' + fmt(c.t) + '. Click to go there.', text: c.name })]));
    });
    if (split) st.cuts.forEach(function (c, k) {
      if (c < v.a || c > v.b) return;
      mk.push(el('div', { class: 'ed-cut' + (k === st.sel ? ' is-sel' : '') + (k === st.justSet ? ' is-new' : '') + (st.dragCut === k ? ' is-drag' : ''), 'data-cut': k, style: 'left:' + X(c) + '%',
        title: 'Split point ' + (k + 1) + ' at ' + fmt(c) + '. Drag this handle to move it (it snaps to the black gap); click to go there.' }, [el('span', { class: 'ed-cut-grip' }, [scissors(), String(k + 1)])]));
    });
    st.justSet = null;
    $('edMarks').replaceChildren.apply($('edMarks'), mk);
    lastHead.part = null;
    drawHead();
    // Pictures: the whole-video strip underneath (always there), the last detailed strip stretched
    // into place straight away, and a sharp one for this view swapped in when it's ready.
    placeStrip($('edStripBase'), st.baseStrip);
    placeStrip($('edStripImg'), st.tlStrip);
    placeStrip($('edStripOld'), st.oldStrip);
    clearTimeout(stripTimer);
    if (moving) return;
    stripTimer = setTimeout(loadStrip, 120);
  }
  function loadStrip() {
    if (!st) return;
    var v = st.view, span = v.b - v.a;
    var box = $('edStrip'), w = box.clientWidth || 600, h = box.clientHeight || 62;
    var n = clamp(Math.round(w / (h * 16 / 9)), 4, 24);
    var key = span > 150 ? 1 : 0;
    var url = 'shelf-media://s/' + st.token + '?from=' + v.a.toFixed(2) + '&to=' + v.b.toFixed(2) + '&n=' + n + '&w=192&key=' + key + '&slot=view';
    if (st.tlStrip && st.tlStrip.url === url) return;
    var want = { url: url, a: v.a, b: v.b, n: n };
    st.wantStrip = url;
    var img = new Image();
    img.onload = function () {
      if (!st || st.wantStrip !== url) return;
      // Keep the old picture underneath while the new one fades in.
      var cur = $('edStripImg'), old = $('edStripOld');
      if (st.tlStrip) { old.src = st.tlStrip.url; st.oldStrip = st.tlStrip; placeStrip(old, st.oldStrip); old.classList.remove('is-off'); }
      cur.classList.add('is-off'); cur.src = url; st.tlStrip = want; placeStrip(cur, want);
      requestAnimationFrame(function () { cur.classList.remove('is-off'); });
      box.classList.remove('is-loading');
    };
    box.classList.add('is-loading');
    img.src = url;
    // Quick pictures for this view (up to 2 a second): what you see instantly while scrubbing
    // and skimming, before the exact frame arrives.
    {
      var dn = clamp(Math.round(span * 2), 8, 160), dkey = span > 120 ? 1 : 0;
      var durl = 'shelf-media://s/' + st.token + '?from=' + v.a.toFixed(2) + '&to=' + v.b.toFixed(2) + '&n=' + dn + '&w=192&key=' + dkey + '&slot=dense';
      if (!st.scrub || st.scrub.url !== durl) {
        var dimg = new Image();
        dimg.onload = function () { if (st) { st.scrub = { url: durl, a: v.a, b: v.b, n: dn }; if (!st.playable) showFrame(st.t); } };
        dimg.src = durl;
      }
    }
  }

  // ---- Modes: one file vs split ----
  function setMode(m, first) {
    if (!st) return;
    st.mode = m;
    document.querySelectorAll('#edMode button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.mode === m ? 'true' : 'false'); });
    $('editorSheet').classList.toggle('is-split', m === 'split');
    if (m === 'split') {
      if (st.parts.length < 2) {
        // Splitting something we thought was one episode: start with two parts, the second being the next episode.
        var e0 = st.parts[0] && st.parts[0].entry;
        st.parts = [{ entry: e0 }, { entry: e0 ? next(e0) : null }];
      }
      if (!st.suggested) suggest();
    }
    drawAll();
    if (first && m === 'one') info('Scrub or play to check which episode this is. Holds more than one? Use + Add Another Episode, or Split Into Files to give each its own file.');
    if (!first) info(m === 'split'
      ? 'Split mode: each part becomes its own file. Move the playhead to where a part starts and click Set Cut Here.'
      : 'One file: it keeps one name, listing the episodes in it.');
  }
  function next(e) {
    var l = st.list.filter(function (x) { return x.number != null; });
    var i = l.findIndex(function (x) { return keyOf(x) === keyOf(e); });
    return i >= 0 && l[i + 1] ? l[i + 1] : null;
  }
  // First guesses for cuts: before each part's title card, else from the episodes' lengths.
  function suggest() {
    st.suggested = true;
    var n = st.parts.length, total = 0, acc = 0;
    st.parts.forEach(function (p) { total += (p.entry && p.entry.runtime) || 11; });
    var hints = [];
    for (var i = 1; i < n; i++) {
      acc += (st.parts[i - 1].entry && st.parts[i - 1].entry.runtime) || 11;
      var e = st.parts[i].entry, card = e && st.cards.filter(function (c) { return c.key === keyOf(e); })[0];
      hints.push(card ? { card: card.start != null ? card.start : card.t } : { est: st.secs * acc / total });
    }
    st.cuts = hints.map(function (h) { return h.card != null ? Math.max(1, h.card - 2) : h.est; });
    st.cuts.sort(function (a, b) { return a - b; });
    $('edBusy').hidden = false; $('edSave').disabled = true;
    info('Looking for the black, silent moment between the episodes…');
    var tok = st.token;
    st.o.native.splitSuggest(tok, hints).then(function (res) {
      if (!st || st.token !== tok) return;
      var why = [];
      res.forEach(function (g, i) {
        if (!g) return;
        st.cuts[i] = g.at;
        var wh = g.why === 'black + silence' ? 'a black, silent moment' : g.why === 'black' ? 'a black screen' : g.why === 'silence' ? 'a silent moment' : g.from === 'card' ? 'just before the title card' : 'from the episodes’ lengths';
        why.push('Cut ' + (i + 1) + ' at ' + fmt(g.at) + ' (' + wh + ')');
      });
      st.cuts.sort(function (a, b) { return a - b; });
      info('Shelf’s suggestion: ' + why.join('; ') + '. Check it: Play Around Cut, or move the playhead and Set Cut Here.');
      return around(st.cuts[0]);
    }).catch(function (e) { if (st) info('Couldn’t find a gap (' + e.message + '). Move the playhead to where the next episode starts and click Set Cut Here.'); })
      .then(function () { if (!st) return; $('edBusy').hidden = true; drawAll(); seek(st.cuts[st.sel] - 3); });
  }
  function around(t) {
    return st.o.native.splitAround(st.token, t).then(function (q) {
      if (!st) return;
      st.keys = st.keys.concat(q.keys).filter(function (k, i, a) { return a.indexOf(k) === i; }).sort(function (a, b) { return a - b; });
      q.black.forEach(function (g) { addGap('black', g); }); q.silence.forEach(function (g) { addGap('silence', g); });
    });
  }
  function addGap(kind, g) { if (!st.gaps.some(function (x) { return x.kind === kind && Math.abs(x.a - g.a) < 0.2; })) st.gaps.push({ kind: kind, a: g.a, b: g.b }); }

  // ---- Cuts (only these buttons move them) ----
  function minPart() { return Math.min(30, st.secs / 8); }
  function setCutHere() {
    if (!st || st.mode !== 'split') return;
    var t = st.t, i = st.sel;
    if (!st.cuts.length) { addCut(); return; }
    var lo = (i ? st.cuts[i - 1] : 0) + minPart(), hi = (i < st.cuts.length - 1 ? st.cuts[i + 1] : st.secs) - minPart();
    if (t < lo || t > hi) { info('Cut ' + (i + 1) + ' has to stay between ' + fmt(lo) + ' and ' + fmt(hi) + '. Select another cut on the timeline, or move the playhead.'); return; }
    snapAndSet(i, t);
  }
  function snapAndSet(i, t) {
    info('Setting cut ' + (i + 1) + '…');
    around(t).then(function () {
      if (!st) return;
      var k = st.keys.slice().sort(function (a, b) { return Math.abs(a - t) - Math.abs(b - t); })[0];
      var at = k != null && Math.abs(k - t) < 6 ? k : t;
      st.cuts[i] = at;
      info('Cut ' + (i + 1) + ' set at ' + fmt(at) + (Math.abs(at - t) > 0.05
        ? ' — ' + Math.abs(at - t).toFixed(1) + ' s from the playhead, at the nearest keyframe, so the cut doesn’t re-encode the video.'
        : ' (on a keyframe: a clean, lossless cut).'));
      st.justSet = i;
      drawAll(); seek(at);
    });
  }
  function addCut() {
    if (!st || st.mode !== 'split') return;
    var t = st.t, b = bounds();
    var i = partAt(t);
    if (t - b[i] < minPart() || b[i + 1] - t < minPart()) { info('Too close to another cut or the end. Move the playhead further into the part you want to split.'); return; }
    st.cuts.splice(i, 0, t);
    var prev = st.parts[i].entry;
    st.parts.splice(i + 1, 0, { entry: prev ? next(prev) : null });
    st.sel = i;
    snapAndSet(i, t);
  }
  function removeCut() {
    if (!st || st.mode !== 'split' || !st.cuts.length) return;
    var i = st.sel;
    st.cuts.splice(i, 1);
    st.parts.splice(i + 1, 1);
    st.sel = clamp(i - 1, 0, Math.max(0, st.cuts.length - 1));
    if (!st.cuts.length) { setMode('one'); return; }
    info('Cut removed: those two parts are one now.');
    drawAll();
  }

  // ---- Title cards ----
  function jumpCard(dir) {
    if (!st || !st.cards.length) return;
    var t = st.t, c = dir > 0 ? st.cards.filter(function (x) { return cardStart(x) > t + 0.5; })[0] : st.cards.filter(function (x) { return cardStart(x) < t - 0.5; }).pop();
    if (!c) c = dir > 0 ? st.cards[0] : st.cards[st.cards.length - 1];
    goCard(c);
  }
  // Go to a title card: where it starts on screen, zoomed in enough to see it.
  function goCard(c) {
    if (!st || !c) return;
    if (st.playable) video.pause();
    if (st.zoom < 3) setZoom(3, c.t); else keepInView(c.t);
    seek(cardStart(c)); flash();
    info(c.manual ? 'Title card “' + c.name + '”: you marked it at ' + fmt(c.t) + '.' : 'Title card “' + c.name + '”: Shelf read it at ' + fmt(c.t) + '. Step with ← → to see exactly where it starts.');
  }

  // ---- Marking a title card yourself (for cards Shelf couldn't read) ----
  function markedHere() { return st.cards.filter(function (c) { return c.manual && Math.abs(c.t - st.t) < 1; })[0] || null; }
  function markBtn() {
    var m = st && markedHere(), b = $('edMarkCard');
    var want = m ? 'Remove Mark' : 'Mark Title Card Here';
    if (b.lastChild.textContent !== want) { b.lastChild.textContent = want; b.classList.toggle('is-remove', !!m); b.title = m ? 'Remove the title card you marked here (“' + m.name + '”)' : 'The title card is on screen right now: say which episode it is  (M)'; }
  }
  // Your marks are passed on a moment after the last change (so marking and unmarking quickly
  // doesn't make Shelf work the episodes out again each time), and at the latest when you close.
  var marksTimer = 0;
  function marksChanged() {
    if (!st.o.onMarks) return;
    st.pendingMarks = { list: st.cards.filter(function (c) { return c.manual; }).map(function (c) { return { t: c.t, season: c.season, number: c.number, name: c.name }; }), secs: st.secs };
    clearTimeout(marksTimer);
    marksTimer = setTimeout(function () { if (!st || !st.pendingMarks) return; var m = st.pendingMarks; st.pendingMarks = null; st.o.onMarks(m.list, m.secs); }, 600);
  }
  function markCard() {
    if (!st) return;
    if (st.playable) video.pause();
    var t = st.t, here = markedHere();
    if (here) {
      st.cards.splice(st.cards.indexOf(here), 1);
      drawAll(); marksChanged();
      info('Removed the mark for “' + here.name + '”.');
      return;
    }
    var guess = st.mode === 'split' ? st.parts[partAt(t)] && st.parts[partAt(t)].entry : st.oneEntries[t > st.secs / 2 ? st.oneEntries.length - 1 : 0];
    browse($('edMarkCard'), {
      list: st.list, marked: guess ? [guess] : [], season: guess ? guess.season : null,
      title: 'Whose title card is at ' + fmt(t, false) + '?',
      onPick: function (x) { if (st) addMark(t, x); }
    });
  }
  function addMark(t, x) {
    var pick = { season: x.season, number: x.number, name: x.name, runtime: x.runtime || null, how: 'card' }, k = keyOf(pick);
    // The mark replaces any other card for this episode, and any reading near it (cards are ~11 min apart).
    st.cards = st.cards.filter(function (c) { return c.key !== k && (c.manual || Math.abs(c.t - t) >= 120); });
    st.cards.push({ t: t, start: t, key: k, name: x.name, season: x.season, number: x.number, manual: true, score: 1, text: '' });
    st.cards.sort(function (a, b) { return a.t - b.t; });
    var cardT = function (e) { var c = e && st.cards.filter(function (y) { return y.key === keyOf(e); })[0]; return c ? c.t : null; };
    if (st.mode === 'split') {
      var i = partAt(t);
      st.parts.forEach(function (p, j) { if (j !== i && p.entry && keyOf(p.entry) === k) p.entry = null; });
      st.parts[i].entry = pick;
    } else if (!st.oneEntries.some(function (e) { return keyOf(e) === k; })) {
      // Put it in place of an episode no title card backs up (the one nearest where you marked), or add it.
      var loose = st.oneEntries.map(function (e, j) { return j; }).filter(function (j) { return cardT(st.oneEntries[j]) == null; });
      if (loose.length) st.oneEntries[t > st.secs / 2 ? loose[loose.length - 1] : loose[0]] = pick;
      else st.oneEntries.push(pick);
      st.oneEntries.sort(function (p, q) { return p.season - q.season || p.number - q.number; });
      var en = st.oneEntries;
      var apart = en.length > 1 && !en.every(function (y, j) { return j === 0 || (y.season === en[j - 1].season && y.number === en[j - 1].number + 1); });
      if (apart) {
        // Not next to each other: they need a file each. Order the parts the way they play.
        st.parts = en.slice().sort(function (p, q) { var a = cardT(p), b = cardT(q); return (a == null ? 1e9 : a) - (b == null ? 1e9 : b); }).map(function (e) { return { entry: e }; });
        st.suggested = false; st.newKey = k;
        marksChanged();
        setMode('split');
        return;
      }
    }
    st.newKey = k;
    drawAll(); marksChanged();
    info('Marked: the title card at ' + fmt(t) + ' is ' + code(pick) + ' “' + pick.name + '”.');
  }

  // ---- The parts / episodes panel ----
  function drawAll() { drawTimeline(); drawPanel(); }
  // The row of title cards under the timeline: every card Shelf read, one click away.
  function drawCards() {
    var list = $('edCardList');
    $('edCardsNone').hidden = !!st.cards.length;
    list.hidden = !st.cards.length;
    list.replaceChildren.apply(list, st.cards.map(function (c, i) {
      var part = st.mode === 'split' ? partAt(cardStart(c) + 0.5) : -1;
      return el('button', { type: 'button', class: 'ed-chip' + (c.manual ? ' is-manual' : ''), 'data-key': c.key, title: 'Go to the title card “' + c.name + '” (' + fmt(c.t) + ')' + (c.manual ? ', marked by you' : ''), onclick: function () { goCard(c); } }, [
        frameImg(c.t, 160, ''),
        el('span', { class: 'ed-chip-txt' }, [el('b', { text: c.name }), el('span', { text: (part >= 0 ? 'Part ' + (part + 1) + ' · ' : '') + fmt(c.t, false) }), c.manual ? el('i', { text: 'Marked by you' }) : null])
      ]);
    }));
    lastHead.card = null;
  }
  function drawPanel() {
    if (!st) return;
    drawCards();
    var box = $('edPanel'); box.textContent = '';
    var split = st.mode === 'split';
    $('edPanelTitle').textContent = split ? 'Parts — each becomes its own file' : 'Episodes in this file';
    $('edCutTools').hidden = !split;
    $('edCutLabel').textContent = st.cuts.length ? 'Cut ' + (st.sel + 1) + (st.cuts.length > 1 ? ' of ' + st.cuts.length : '') + ' · at ' + fmt(st.cuts[st.sel]) : 'No cut yet';
    $('edCutHere').replaceChildren(scissors(), document.createTextNode(st.cuts.length ? ' Set Cut ' + (st.sel + 1) + ' Here' : ' Cut Here'));
    $('edRemoveCut').disabled = !st.cuts.length;
    $('edPrevCard').disabled = $('edNextCard').disabled = $('edCardJump').disabled = !st.cards.length;
    $('edAround').lastChild.textContent = split && st.cuts.length ? ' Play Around Cut' : ' Play Around Playhead';
    var b = bounds();
    var items = split ? st.parts.map(function (p, i) { return { entry: p.entry, i: i, a: b[i], z: b[i + 1] }; }) : st.oneEntries.map(function (e, i) { return { entry: e, i: i }; });
    items.forEach(function (it) {
      var e = it.entry, card = e && st.cards.filter(function (c) { return c.key === keyOf(e); })[0];
      var head = el('div', { class: 'ed-part-head' }, [
        el('span', { class: 'ed-dot', 'data-part': it.i % 2, text: String(it.i + 1) }),
        split ? el('span', { class: 'ed-range', text: fmt(it.a) + ' – ' + fmt(it.z) + '  (' + fmt(it.z - it.a, false) + ')' }) : el('span', { class: 'ed-range', text: st.oneEntries.length > 1 ? 'Episode ' + (it.i + 1) + ' in this file' : 'This file' }),
        split ? el('button', { type: 'button', class: 'ed-mini', title: 'Go to where this part starts', text: 'Go to start', onclick: function () { if (st.playable) video.pause(); keepInView(it.a); seek(it.a + (it.a ? 0.05 : 0)); flash(); } }) : null
      ]);
      var epBox = e
        ? el('div', { class: 'ed-ep' + (st.newKey === keyOf(e) ? ' is-new' : '') }, [el('span', { class: 'ed-code', text: code(e) }), el('span', { class: 'ed-name', text: e.name || '(no title)' })])
        : el('div', { class: 'ed-ep is-empty' }, [el('span', { class: 'ed-name', text: 'Choose which episode this is' })]);
      var change = el('button', { type: 'button', class: 'pill small-pill', 'data-opens-browser': '1', text: e ? 'Change…' : 'Choose…' });
      change.addEventListener('click', function () {
        browse(change, {
          list: st.list, marked: e ? [e] : [], season: e ? e.season : (st.parts[0] && st.parts[0].entry ? st.parts[0].entry.season : null),
          title: split ? 'Which episode is part ' + (it.i + 1) + '?' : 'Which episode is this?',
          onPick: function (x) {
            var pick = { season: x.season, number: x.number, name: x.name, runtime: x.runtime || null, how: 'manual' };
            if (split) st.parts[it.i].entry = pick; else st.oneEntries[it.i] = pick;
            if (!split) st.oneEntries.sort(function (p, q) { return p.season - q.season || p.number - q.number; });
            st.newKey = keyOf(pick);
            drawAll();
            info('Changed to ' + code(pick) + ' “' + pick.name + '”.');
          }
        });
      });
      var row = [head, el('div', { class: 'ed-ep-row' }, [epBox, change])];
      if (!split && st.oneEntries.length > 1) row[0].appendChild(el('button', { type: 'button', class: 'ed-mini', title: 'Remove this episode from the name', text: 'Remove', onclick: function () { st.oneEntries.splice(it.i, 1); drawAll(); } }));
      // How we know, and the frame Shelf read, so you can check it.
      if (card) {
        var sure = card.score >= 0.85 ? 'hi' : 'mid';
        if (card.manual) row.push(el('div', { class: 'ed-proof' }, [
          el('button', { type: 'button', class: 'ed-thumb', title: 'Go to this title card in the video', onclick: function () { goCard(card); } },
            [frameImg(card.t, 320, 'The title card you marked')]),
          el('div', { class: 'ed-proof-text' }, [
            el('span', { class: 'ed-sure hi', text: '✓ You marked this title card · ' + fmt(card.t, false) }),
            el('span', { text: 'Wrong spot? Go to it and click Remove Mark.' })
          ])
        ]));
        else row.push(el('div', { class: 'ed-proof' }, [
          el('button', { type: 'button', class: 'ed-thumb', title: 'Go to this title card in the video', onclick: function () { goCard(card); } },
            [frameImg(card.t, 320, 'The frame Shelf read')]),
          el('div', { class: 'ed-proof-text' }, [
            el('span', { class: 'ed-sure ' + sure, text: (sure === 'hi' ? '✓ Title card matches' : '≈ Title card looks like it') + ' · ' + fmt(card.t, false) }),
            el('q', { title: 'Everything Shelf read on that frame: ' + card.text }, marked(card.text, card.name)),
            el('span', { text: 'Not this episode? Click Change…' })
          ])
        ]));
      } else if (e) {
        row.push(el('p', { class: 'ed-how' + (e.how === 'manual' ? ' manual' : ''), text: e.how === 'title' ? 'From the episode title in the file name.' : e.how === 'manual' ? 'You chose this.' : e.how === 'halfhour' ? 'Worked out from the half-hour number in the file name.' : e.how === 'length' ? 'From the video’s length. Check it in the video.' : 'From the episode number in the file name. Check it in the video.' }));
      }
      box.appendChild(el('div', { class: 'ed-part' + (split && it.i === partAt(st.t) ? ' is-cur' : '') + (it.fresh ? ' is-new' : ''), 'data-part': it.i % 2 }, row));
    });
    if (!split) {
      var add = el('button', { type: 'button', class: 'ed-add', 'data-opens-browser': '1', text: '+ Add Another Episode in This File' });
      add.addEventListener('click', function () {
        var last = st.oneEntries[st.oneEntries.length - 1];
        browse(add, { list: st.list, marked: st.oneEntries, season: last ? last.season : null, title: 'Add an episode that’s also in this file', onPick: function (x) {
          if (st.oneEntries.some(function (y) { return keyOf(y) === keyOf(x); })) return;
          st.oneEntries.push({ season: x.season, number: x.number, name: x.name, runtime: x.runtime || null, how: 'manual' });
          st.oneEntries.sort(function (p, q) { return p.season - q.season || p.number - q.number; });
          st.newKey = keyOf(x);
          drawAll();
        } });
      });
      box.appendChild(add);
    }
    // What you'll get, and whether it can be saved.
    var ok = true, warn = '';
    if (split) {
      if (st.parts.some(function (p) { return !p.entry; })) { ok = false; warn = 'Choose an episode for every part.'; }
      var seen = {};
      st.parts.forEach(function (p) { if (p.entry) { if (seen[keyOf(p.entry)]) { ok = false; warn = 'Two parts are the same episode.'; } seen[keyOf(p.entry)] = 1; } });
      if (!st.cuts.length) { ok = false; warn = 'Add a cut where the second episode starts.'; }
    } else {
      var en = st.oneEntries;
      if (!en.length) { ok = false; warn = 'Choose at least one episode.'; }
      var together = en.every(function (x, i) { return i === 0 || (x.season === en[i - 1].season && x.number === en[i - 1].number + 1); });
      if (en.length > 1 && !together) { ok = false; warn = 'These episodes aren’t next to each other, so Plex can’t show one file as all of them. Split the file instead (top right), or choose episodes in a row.'; }
    }
    $('edWarn').hidden = !warn; $('edWarn').textContent = warn;
    var names = ok ? st.o.preview(split ? 'split' : 'one', split ? st.parts.map(function (p) { return p.entry; }) : st.oneEntries) : [];
    var nb = $('edNames'); nb.textContent = '';
    names.forEach(function (n, i) { nb.appendChild(el('div', { class: 'ed-name-row', 'data-part': split ? i % 2 : 0 }, [el('span', { class: 'ed-dot' + (split ? '' : ' ok'), 'data-part': split ? i % 2 : 0, text: split ? String(i + 1) : '✓' }), el('span', { text: n })])); });
    st.newKey = null;
    $('edSave').disabled = !ok || !$('edBusy').hidden;
    $('edSaveNext').hidden = !st.o.onNext;
    $('edSaveNext').disabled = $('edSave').disabled;
    if (st.o.nextName) $('edSaveNext').title = 'Save, then open ' + st.o.nextName;
    $('edSave').textContent = split ? 'Use ' + st.parts.length + ' Files' : 'Use This Name';
    drawHead();
  }

  function save(goNext) {
    if (!st || $('edSave').disabled) return;
    var b = bounds(), r;
    if (st.mode === 'split') r = { mode: 'split', pieces: st.parts.map(function (p, i) { return { start: Math.round(b[i] * 1000) / 1000, end: Math.round(b[i + 1] * 1000) / 1000, entry: p.entry }; }) };
    else r = { mode: 'one', entries: st.oneEntries.slice() };
    var fn = st.o.onSave;
    var nextFn = goNext === true ? st.o.onNext : null;
    close(!!nextFn);
    if (fn) fn(r);
    if (nextFn) nextFn();
  }

  // ---- Wiring ----
  function wire() {
    ebWire();
    var tl = $('edTimeline');
    var drag = null; // { mode: 'scrub' | 'cut', k, x }
    function fracAt(ev) { var r = tl.getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1); }
    function tAt(ev) { return st.view.a + fracAt(ev) * (st.view.b - st.view.a); }
    // Snap a moving split point to the black gap or a title card when it's close (on screen).
    function snapCut(t) {
      var near = (st.view.b - st.view.a) * 0.012, best = t, bd = near;
      st.gaps.forEach(function (g) { if (g.kind !== 'black') return; [g.a, g.b, (g.a + g.b) / 2].forEach(function (x) { if (Math.abs(x - t) < bd) { bd = Math.abs(x - t); best = x; } }); });
      st.cards.forEach(function (c) { var x = cardStart(c) - 0.5; if (Math.abs(x - t) < bd) { bd = Math.abs(x - t); best = x; } });
      return best;
    }
    function moveTo(ev) {
      if (!drag) return;
      var t = tAt(ev);
      if (drag.mode === 'cut') {
        var k = drag.k, lo = (k ? st.cuts[k - 1] : 0) + minPart(), hi = (k < st.cuts.length - 1 ? st.cuts[k + 1] : st.secs) - minPart();
        t = clamp(snapCut(t), lo, hi);
        st.cuts[k] = t; drawTimeline(true);
      }
      seek(t, true);
    }
    // Near the left or right edge while dragging, the timeline glides along (it never jumps).
    var edgeRaf = 0;
    function edgeScroll() {
      if (!drag || !st) { edgeRaf = 0; return; }
      var f = drag.f, span = st.view.b - st.view.a, push = f < 0.04 ? (f - 0.04) / 0.04 : f > 0.96 ? (f - 0.96) / 0.04 : 0;
      if (push) {
        var a = clamp(st.view.a + push * span * 0.02, 0, Math.max(0, st.secs - span));
        if (a !== st.view.a) { st.view = { a: a, b: a + span }; drawTimeline(true); moveTo(drag.ev); }
      }
      edgeRaf = requestAnimationFrame(edgeScroll);
    }
    tl.addEventListener('pointerdown', function (ev) {
      if (!st || ev.button !== 0) return;
      if (ev.target.closest('.ed-card button')) return; // title-card flags are buttons (click to go)
      var cutEl = ev.target.closest('.ed-cut');
      ev.preventDefault();
      tl.setPointerCapture(ev.pointerId);
      st.wasPlaying = st.playable && !video.paused; video.pause();
      drag = { mode: cutEl && st.mode === 'split' ? 'cut' : 'scrub', k: cutEl ? +cutEl.dataset.cut : -1, x: ev.clientX, moved: false, ev: ev, f: fracAt(ev) };
      st.dragging = true;
      if (drag.mode === 'cut') { st.sel = drag.k; st.dragCut = drag.k; tl.classList.add('is-cutting'); seek(st.cuts[drag.k], true); drawPanel(); }
      else { tl.classList.add('is-scrubbing'); seek(tAt(ev), true); }
      $('edPeek').classList.remove('on');
      if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeScroll);
    });
    tl.addEventListener('pointermove', function (ev) {
      if (!st) return;
      if (drag) {
        drag.ev = ev; drag.f = fracAt(ev);
        if (Math.abs(ev.clientX - drag.x) > 2) drag.moved = true;
        if (drag.mode === 'scrub' || drag.moved) moveTo(ev);
        return;
      }
      // Skimming: a preview of the frame under the mouse, without moving anything.
      var t = tAt(ev), f = fracAt(ev), hov = $('edHover'), peek = $('edPeek');
      hov.style.left = (f * 100) + '%';
      if (proxy($('edPeekImg'), t)) {
        var w = tl.clientWidth, pw = 168;
        peek.style.left = clamp(f * w - pw / 2, 0, Math.max(0, w - pw)) + 'px';
        $('edPeekTime').textContent = fmt(t);
        peek.classList.add('on');
      }
    });
    tl.addEventListener('pointerleave', function () { if (!drag) { $('edHover').style.left = '-100px'; $('edPeek').classList.remove('on'); } });
    function endDrag() {
      if (!drag || !st) { drag = null; return; }
      var d = drag; drag = null; st.dragging = false;
      tl.classList.remove('is-scrubbing', 'is-cutting');
      if (d.mode === 'cut') {
        st.dragCut = null;
        if (d.moved) snapAndSet(d.k, st.cuts[d.k]); // settle on the nearest clean cutting point
        else { seek(st.cuts[d.k]); flash(); }
        drawAll();
      } else seek(st.t); // the exact frame (and the timeline follows if needed)
      if (st.wasPlaying) video.play();
    }
    tl.addEventListener('pointerup', endDrag); tl.addEventListener('pointercancel', endDrag);
    // Title-card flags on the timeline.
    tl.addEventListener('click', function (ev) {
      var b = ev.target.closest('.ed-card button');
      if (b && st) { var c = st.cards.filter(function (x) { return x.key === b.dataset.card; })[0]; if (c) goCard(c); }
    });
    // Scroll = move along. Ctrl/⌘ + scroll or a pinch = zoom around the mouse (smoothly, a step at a time).
    var zoomAcc = 0, zoomT = 0;
    tl.addEventListener('wheel', function (ev) {
      if (!st) return;
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        zoomAcc += ev.deltaY;
        if (Date.now() - zoomT > 140 && Math.abs(zoomAcc) >= 24) {
          var z = st.zoom + (zoomAcc < 0 ? 1 : -1); zoomAcc = 0; zoomT = Date.now();
          if (z >= 0 && z < ZOOMS.length) {
            // Keep the moment under the mouse where it is.
            var f = fracAt(ev), t = tAt(ev), span = Math.min(ZOOMS[z] || st.secs, st.secs);
            setZoom(z, t + (0.5 - f) * span);
          }
        }
        return;
      }
      var span2 = st.view.b - st.view.a, d = (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY) / 800 * span2;
      var a = clamp(st.view.a + d, 0, Math.max(0, st.secs - span2));
      if (a !== st.view.a) { st.view = { a: a, b: a + span2 }; drawTimeline(); }
    }, { passive: false });
    // Buttons
    $('edPlay').addEventListener('click', function () { if (!st || !st.playable) return; if (video.paused) { st.stopAt = null; video.play(); } else video.pause(); });
    document.querySelectorAll('#editorSheet [data-step]').forEach(function (b) {
      var step = function () { if (!st) return; video.pause(); var d = b.dataset.step === 'frame' ? 1 / st.fps : b.dataset.step === '-frame' ? -1 / st.fps : Number(b.dataset.step); seek(st.t + d); };
      // Hold to repeat (handy for frame-by-frame).
      var timer = 0, rep = 0;
      b.addEventListener('pointerdown', function (ev) { if (ev.button !== 0) return; step(); timer = setTimeout(function () { rep = setInterval(step, b.dataset.step.indexOf('frame') >= 0 ? 60 : 180); }, 380); });
      var stop = function () { clearTimeout(timer); clearInterval(rep); };
      b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop); b.addEventListener('pointercancel', stop);
      b.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); step(); hit(b); } });
    });
    document.querySelectorAll('#edSpeed button').forEach(function (b) {
      b.addEventListener('click', function () { if (!st) return; st.rate = Number(b.dataset.rate); video.playbackRate = st.rate; document.querySelectorAll('#edSpeed button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }); });
    });
    $('edPrevCard').addEventListener('click', function () { jumpCard(-1); });
    $('edNextCard').addEventListener('click', function () { jumpCard(1); });
    $('edCardJump').addEventListener('click', function () { if (st && st.cards.length) goCard(cardTarget().c); });
    $('edZoomSlider').addEventListener('input', function () { if (st) setZoom(Number(this.value)); });
    $('edZoomSlider').addEventListener('pointerup', function () { this.blur(); }); // so Space and arrows go back to the video
    $('edAround').addEventListener('click', function () {
      if (!st) return;
      var c = st.mode === 'split' && st.cuts.length ? st.cuts[st.sel] : st.t;
      if (st.playable) play(c - 4, c + 4); else seek(c);
    });
    $('edZoomIn').addEventListener('click', function () { if (st) setZoom(st.zoom + 1); });
    $('edZoomOut').addEventListener('click', function () { if (st) setZoom(st.zoom - 1); });
    $('edZoomFit').addEventListener('click', function () { if (st) setZoom(0); });
    $('edCutHere').addEventListener('click', setCutHere);
    $('edMarkCard').addEventListener('click', markCard);
    $('edAddCut').addEventListener('click', addCut);
    $('edRemoveCut').addEventListener('click', removeCut);
    document.querySelectorAll('#edMode button').forEach(function (b) { b.addEventListener('click', function () { if (st && st.mode !== b.dataset.mode) setMode(b.dataset.mode); }); });
    $('edCancel').addEventListener('click', close);
    $('edSave').addEventListener('click', function () { save(false); });
    $('edSaveNext').addEventListener('click', function () { save(true); });
    $('editorSheet').addEventListener('cancel', function (ev) { ev.preventDefault(); if ($('epBrowser').hidden) close(); else ebClose(); });
    // Every button: a short pressed glow.
    $('editorSheet').addEventListener('pointerdown', function (ev) { var b = ev.target.closest('button'); if (b && !b.disabled) hit(b); });
    // Keys
    document.addEventListener('keydown', function (ev) {
      if (!st || !$('editorSheet').open || !$('epBrowser').hidden) return;
      if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      var k = ev.key, press = function (id) { ev.preventDefault(); hit($(id)); };
      if (k === ' ' || k === 'k' || k === 'K') { press('edPlay'); $('edPlay').click(); }
      else if (k === 'j' || k === 'J') { ev.preventDefault(); video.pause(); seek(st.t - 5); } // like video editors: J back, K pause, L play
      else if (k === 'l' || k === 'L') { ev.preventDefault(); if (st.playable) { if (video.paused) { st.stopAt = null; video.play(); } else { var r = Math.min(4, (video.playbackRate || 1) * 2); video.playbackRate = r; } } }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        ev.preventDefault(); video.pause();
        var d = (k === 'ArrowLeft' ? -1 : 1) * (ev.shiftKey ? 1 : ev.altKey ? 5 : 1 / st.fps);
        seek(st.t + d);
        hit(document.querySelector('#editorSheet [data-step="' + (ev.shiftKey ? (d < 0 ? '-1' : '1') : ev.altKey ? (d < 0 ? '-5' : '5') : (d < 0 ? '-frame' : 'frame')) + '"]'));
      }
      else if (k === '[') { press('edPrevCard'); jumpCard(-1); }
      else if (k === ']') { press('edNextCard'); jumpCard(1); }
      else if (k === 'm' || k === 'M') { press('edMarkCard'); markCard(); }
      else if (k === 'c' || k === 'C') { if (st.mode === 'split') { press('edCutHere'); setCutHere(); } }
      else if (k === '+' || k === '=') { press('edZoomIn'); setZoom(st.zoom + 1); }
      else if (k === '-' || k === '_') { press('edZoomOut'); setZoom(st.zoom - 1); }
      else if (k === '0') { press('edZoomFit'); setZoom(0); }
      else if (k === 'Home') { ev.preventDefault(); video.pause(); seek(0); flash(); }
      else if (k === 'End') { ev.preventDefault(); video.pause(); seek(st.secs); flash(); }
    });
    window.addEventListener('resize', function () { if (st) drawTimeline(); });
  }

  root.ShelfEditor = { open: open, close: close, browse: browse, isOpen: function () { return !!st; }, _state: function () { return st; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})(this);
