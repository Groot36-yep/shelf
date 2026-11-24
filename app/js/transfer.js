/*
 * Shelf — Server Files (the window side): your Plex server on the left, this PC on the right, copy either way.
 * Like FileZilla: browse both, pick files and folders, click Copy (or drag them across), and watch the queue.
 * All the copying happens in the app itself (desktop/transfer.js), over your SSH connection; this page only
 * asks for folder lists and copies, and never sees your password.
 */
(function () {
  'use strict';
  var native = window.shelfNative;
  if (!native || !native.xferStart) return;

  var WIN = native.platform === 'win32';
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v; else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function shelf() { return window.Shelf || null; }
  function toast(m) { if (shelf() && shelf().toast) shelf().toast(m); }
  // Problems arrive as "Error invoking remote method 'x': Error: [CODE] Plain words".
  function why(e) {
    var m = String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^\w*Error:\s*/, '');
    var c = /^\[([A-Z_]+)\]\s*/.exec(m);
    return { code: c ? c[1] : 'OTHER', text: c ? m.slice(c[0].length) : m };
  }
  function size(b) {
    if (!(b > 0)) return '0 KB';
    if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
    if (b >= 1e9) return (b / 1e9).toFixed(b >= 1e11 ? 0 : 1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(b / 1e3)) + ' KB';
  }
  function when(t) {
    if (!t) return '';
    var d = new Date(t * 1000), now = new Date();
    var opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    else { opts.hour = '2-digit'; opts.minute = '2-digit'; }
    return d.toLocaleString(undefined, opts);
  }
  function eta(secs) {
    if (!(secs > 0) || !isFinite(secs)) return '';
    if (secs < 50) return 'a few seconds left';
    if (secs < 90) return 'about a minute left';
    if (secs < 3600) return 'about ' + Math.round(secs / 60) + ' min left';
    var h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
    return 'about ' + h + ' h' + (m ? ' ' + m + ' min' : '') + ' left';
  }
  function plural(n, one, many) { return n.toLocaleString() + ' ' + (n === 1 ? one : (many || one + 's')); }
  function quoteList(names, total) {
    var shown = names.slice(0, 3).map(function (n) { return '“' + n + '”'; });
    var more = total - shown.length;
    if (more > 0) return shown.join(', ') + ' and ' + plural(more, 'more', 'more');
    if (shown.length > 1) return shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1];
    return shown[0] || '';
  }

  // ---------- Icons ----------
  var I = {
    server: '<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="7" rx="2"/><rect x="4" y="13.5" width="16" height="7" rx="2"/><path d="M8 7h.01M8 17h.01"/></svg>',
    pc: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/></svg>',
    swap: '<svg viewBox="0 0 24 24"><path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
    drive: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="10" rx="2.5"/><path d="M7 12h.01M11 12h6"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13.5 3.5v4h4"/></svg>',
    video: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M10 9.5v5l4.5-2.5z"/></svg>',
    music: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    subs: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7 14.5h4M13 14.5h4M7 11h10"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8 8.5"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
    newFolder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
    rename: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 12.5h9l1-12.5"/><path d="M10 11v5M14 11v5"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    left: '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  };
  function icon(name, cls) { return el('span', { class: 'xf-ic' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', html: I[name] }); }
  var VIDEO = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpg|mpeg|flv|vob|iso)$/i, AUDIO = /\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|alac|aiff?|ape|wv|dsf)$/i;
  var SUBS = /\.(srt|ass|ssa|sub|idx|vtt|sup|lrc)$/i, IMAGE = /\.(jpe?g|png|webp|gif|bmp)$/i;
  function kindIcon(e) {
    if (e.drive) return 'drive';
    if (e.dir) return 'folder';
    return VIDEO.test(e.name) ? 'video' : AUDIO.test(e.name) ? 'music' : SUBS.test(e.name) ? 'subs' : IMAGE.test(e.name) ? 'image' : 'file';
  }

  // ---------- Paths ----------
  function join(side, dir, name) {
    if (side === 'server') return dir === '/' ? '/' + name : dir + '/' + name;
    var sep = WIN ? '\\' : '/';
    return /[\\/]$/.test(dir) ? dir + name : dir + sep + name;
  }
  function crumbs(side, p) {
    if (side === 'server') {
      var out = [{ label: '/', path: '/' }], cur = '';
      p.split('/').filter(Boolean).forEach(function (s) { cur += '/' + s; out.push({ label: s, path: cur }); });
      return out;
    }
    var list = WIN ? [{ label: 'This PC', path: '' }] : [{ label: '/', path: '/' }];
    if (!p) return list;
    if (WIN) {
      var parts = p.split('\\').filter(Boolean), acc = '';
      parts.forEach(function (s, i) { acc = i === 0 ? s + '\\' : join('pc', acc, s); list.push({ label: s, path: acc }); });
    } else {
      var c = '';
      p.split('/').filter(Boolean).forEach(function (s) { c += '/' + s; list.push({ label: s, path: c }); });
    }
    return list;
  }
  function shortPath(side, p) {
    var c = crumbs(side, p);
    return c.length > 3 ? '…' + (side === 'server' ? '/' : (WIN ? '\\' : '/')) + c.slice(-2).map(function (x) { return x.label; }).join(side === 'server' || !WIN ? '/' : '\\') : p || 'This PC';
  }

  // ---------- The two sides ----------
  var info = null; // from xferStart: host, places
  var panes = {
    server: { side: 'server', title: 'Your Plex server', path: '', parent: null, entries: [], sel: new Set(), anchor: null, focus: null, sort: { key: 'name', dir: 1 }, places: [], seq: 0 },
    pc: { side: 'pc', title: 'This PC', path: '', parent: null, entries: [], sel: new Set(), anchor: null, focus: null, sort: { key: 'name', dir: 1 }, places: [], seq: 0 }
  };
  function other(side) { return side === 'server' ? 'pc' : 'server'; }
  var sheet = null, drag = null, dropAt = null;

  function sorted(p) {
    var k = p.sort.key, d = p.sort.dir;
    return p.entries.slice().sort(function (a, b) {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      var r = k === 'size' ? a.size - b.size : k === 'mtime' ? a.mtime - b.mtime : 0;
      if (!r) r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return r * d;
    });
  }

  function build() {
    if (sheet) return;
    var paneEl = function (side) {
      var p = panes[side];
      var isServer = side === 'server';
      p.el = {};
      p.el.places = el('div', { class: 'xf-places', role: 'group', 'aria-label': isServer ? 'Places on your server' : 'Places on this PC' });
      p.el.up = el('button', { type: 'button', class: 'xf-ibtn', title: 'Up one folder  (Backspace)', 'aria-label': 'Up one folder', onclick: function () { goUp(side); } }, [icon('up')]);
      p.el.crumbs = el('nav', { class: 'xf-crumbs', 'aria-label': 'Folder' });
      p.el.refresh = el('button', { type: 'button', class: 'xf-ibtn', title: 'Refresh  (F5)', 'aria-label': 'Refresh', onclick: function () { load(side, p.path, true); } }, [icon('refresh')]);
      p.el.mkdir = el('button', { type: 'button', class: 'xf-ibtn', title: 'New folder', 'aria-label': 'New folder', onclick: function () { newFolder(side); } }, [icon('newFolder')]);
      p.el.cols = el('div', { class: 'xf-cols', role: 'presentation' }, ['name', 'size', 'mtime'].map(function (k) {
        return el('button', { type: 'button', class: 'xf-col xf-col-' + k, 'data-sort': k, onclick: function () {
          if (p.sort.key === k) p.sort.dir = -p.sort.dir; else { p.sort.key = k; p.sort.dir = k === 'name' ? 1 : -1; }
          paint(side);
        } }, [el('span', { text: k === 'name' ? 'Name' : k === 'size' ? 'Size' : 'Modified' }), el('i', { 'aria-hidden': 'true' })]);
      }));
      p.el.list = el('div', { class: 'xf-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': p.title, tabindex: '0', 'data-shelf-drop': side });
      p.el.msg = el('div', { class: 'xf-msg', hidden: true });
      p.el.selInfo = el('span', { class: 'xf-selinfo' });
      p.el.go = el('button', { type: 'button', class: 'pill pill-primary xf-go', id: isServer ? 'xfToPC' : 'xfToServer', onclick: function () { copySelected(side); } },
        isServer ? [el('span', { text: 'Copy to This PC' }), icon('right')] : [icon('left'), el('span', { text: 'Copy to Server' })]);
      var foot = [p.el.selInfo, el('span', { class: 'xf-flex' })];
      if (isServer) {
        p.el.rename = el('button', { type: 'button', class: 'pill small-pill', title: 'Rename the selected file or folder on the server  (F2)', onclick: function () { renameSelected(); } }, [icon('rename'), el('span', { text: 'Rename' })]);
        p.el.del = el('button', { type: 'button', class: 'pill small-pill xf-danger', title: 'Delete the selected files and folders from the server  (Delete)', onclick: function () { deleteSelected(); } }, [icon('trash'), el('span', { text: 'Delete' })]);
        foot.push(p.el.rename, p.el.del);
      }
      foot.push(p.el.go);
      var head = el('header', { class: 'xf-phead' }, [
        el('div', { class: 'xf-ptitle' }, [icon(isServer ? 'server' : 'pc', 'xf-pic'), el('b', { text: p.title }), p.el.hostName = el('small', { class: 'muted' })]),
        p.el.places
      ]);
      p.el.root = el('section', { class: 'xf-pane', 'data-side': side, 'aria-label': p.title }, [
        head,
        el('div', { class: 'xf-bar' }, [p.el.up, p.el.crumbs, p.el.refresh, p.el.mkdir]),
        p.el.cols,
        el('div', { class: 'xf-listwrap' }, [p.el.list, p.el.msg]),
        el('footer', { class: 'xf-pfoot' }, foot)
      ]);
      wireList(side);
      return p.el.root;
    };
    var q = {};
    q.summary = el('span', { class: 'xf-qsum muted', id: 'xfQSum' });
    q.pauseAll = el('button', { type: 'button', class: 'link-btn quiet', id: 'xfPauseAll', hidden: true, onclick: function () {
      var on = q.pauseAll.dataset.on === '1';
      native.xferPauseAll(on).then(paintQueue);
    } });
    q.clear = el('button', { type: 'button', class: 'link-btn quiet', id: 'xfClear', hidden: true, onclick: function () { native.xferClear().then(paintQueue); } }, ['Clear Finished']);
    q.list = el('div', { class: 'xf-qlist', id: 'xfQList', role: 'list', 'aria-label': 'Transfers' });
    panes.queue = q;
    sheet = el('dialog', { class: 'sheet xf-sheet', id: 'xferSheet', 'aria-labelledby': 'xfTitle', 'data-shelf-drop': 'none' }, [
      el('header', { class: 'xf-head' }, [
        el('span', { class: 'sv-art', 'aria-hidden': 'true', html: I.swap }),
        el('div', { class: 'xf-titles' }, [
          el('h2', { class: 'sheet-title', id: 'xfTitle', text: 'Server Files' }),
          el('p', { id: 'xfLead', text: 'Copy files and folders between your Plex server and this PC. Pick them and click Copy, or drag them across.' })
        ]),
        el('button', { type: 'button', class: 'pill', id: 'xfDone', onclick: function () { sheet.close(); } }, ['Done'])
      ]),
      el('div', { class: 'xf-panes' }, [paneEl('server'), paneEl('pc')]),
      el('section', { class: 'xf-queue', 'aria-labelledby': 'xfQTitle' }, [
        el('div', { class: 'xf-qhead' }, [el('h3', { id: 'xfQTitle', text: 'Transfers' }), q.summary, el('span', { class: 'xf-flex' }), q.pauseAll, q.clear]),
        q.list
      ])
    ]);
    sheet.addEventListener('close', function () { drag = null; syncBackground(); });
    sheet.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); undo(); }
    });
    sheet.addEventListener('keydown', function (e) { if (e.key === 'F5') { e.preventDefault(); var s = activeSide(); load(s, panes[s].path, true); } });
    document.body.appendChild(sheet);
    native.onXfer(function (snap) { queue = snap; paintQueue(); });
    native.onXferDrop(function (d) {
      if (!sheet.open || !d.paths || !d.paths.length) return;
      if (d.where !== 'server') { toast('Drop files from File Explorer on the server side to copy them there.'); return; }
      var dest = dropAt && dropAt.side === 'server' ? dropAt.path : panes.server.path;
      clearDrop();
      startCopy('up', d.paths, dest);
    });
  }
  var lastSide = 'server';
  function activeSide() { return lastSide; }

  // ---------- Listing ----------
  function load(side, where, keep) {
    var p = panes[side], seq = ++p.seq;
    p.loading = true; syncMsg(side);
    var call = side === 'server' ? native.xferListServer(where) : native.xferListPC(where);
    return call.then(function (r) {
      if (seq !== p.seq) return;
      var same = r.path === p.path;
      p.loading = false; p.error = ''; p.path = r.path; p.parent = r.parent; p.entries = r.entries;
      if (!(keep && same)) { p.sel = new Set(); p.anchor = null; p.focus = null; }
      else { var names = new Set(r.entries.map(function (e) { return e.name; })); p.sel.forEach(function (n) { if (!names.has(n)) p.sel.delete(n); }); }
      paint(side);
      if (!keep || !same) p.el.list.scrollTop = 0;
    }, function (e) {
      if (seq !== p.seq) return;
      p.loading = false;
      var w = why(e);
      if (w.code === 'NO_LOGIN' || w.code === 'AUTH' || /^HOST_/.test(w.code)) { sheet.close(); toast(w.text); if (window.ShelfSend) window.ShelfSend.open(); return; }
      // Stay where you were and say why the folder you asked for won't open.
      p.error = w.text || 'Couldn’t open that folder.';
      if (!p.path && side === 'server' && info) { p.error = ''; return load(side, info.server.home); }
      paint(side);
    });
  }
  function goUp(side) {
    var p = panes[side];
    if (p.parent == null || (side === 'server' && p.path === '/')) return;
    var from = p.path;
    load(side, p.parent).then(function () {
      // The folder you came out of stays picked, so you can see where you were.
      var name = side === 'server' ? from.split('/').pop() : from.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      if (from && /^[A-Za-z]:\\?$/.test(from)) name = from.slice(0, 2);
      if (p.entries.some(function (e) { return e.name === name; })) { p.sel = new Set([name]); p.anchor = p.focus = name; paint(side); scrollToFocus(side); }
    });
  }
  function openEntry(side, e) {
    var p = panes[side];
    if (e.drive) return load(side, e.path);
    if (e.dir) return load(side, join(side, p.path, e.name));
    p.sel = new Set([e.name]); paint(side);
    copySelected(side);
  }

  function syncMsg(side) {
    var p = panes[side], m = p.el.msg;
    var text = p.loading && !p.entries.length ? 'Opening…' : p.error ? p.error : !p.entries.length && !p.loading ? 'This folder is empty.' : '';
    m.hidden = !text;
    m.className = 'xf-msg' + (p.error ? ' is-error' : '');
    m.textContent = text;
    if (p.loading) m.prepend(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
    p.el.root.classList.toggle('is-loading', !!p.loading);
  }
  function paint(side) {
    var p = panes[side];
    var isServer = side === 'server';
    p.el.hostName.textContent = isServer && info ? info.host : '';
    // Places
    p.el.places.textContent = '';
    var places = (isServer ? info.server.places : info.pc.places).slice();
    if (!isServer && info.pc.drives) places.push({ label: 'This PC', path: '', kind: 'drives' });
    places.forEach(function (pl) {
      var on = pl.path === p.path;
      p.el.places.appendChild(el('button', { type: 'button', class: 'xf-place', 'aria-pressed': on ? 'true' : 'false', title: pl.path || 'Your drives', onclick: function () { load(side, pl.path); } }, [pl.label]));
    });
    // Breadcrumb
    p.el.crumbs.textContent = '';
    var cs = crumbs(side, p.path);
    cs.forEach(function (c, i) {
      if (i && cs[i - 1].label !== '/') p.el.crumbs.appendChild(el('span', { class: 'xf-sep', 'aria-hidden': 'true', text: isServer || !WIN ? '/' : '›' }));
      p.el.crumbs.appendChild(el('button', { type: 'button', class: 'xf-crumb', 'aria-current': i === cs.length - 1 ? 'location' : null, title: c.path || 'Your drives', onclick: function () { if (c.path !== p.path) load(side, c.path); } }, [c.label]));
    });
    p.el.crumbs.scrollLeft = p.el.crumbs.scrollWidth;
    p.el.crumbs.classList.toggle('is-cut', p.el.crumbs.scrollLeft > 0);
    p.el.up.disabled = p.parent == null || (isServer && p.path === '/');
    p.el.mkdir.disabled = !isServer && !p.path;
    // Columns
    p.el.cols.querySelectorAll('.xf-col').forEach(function (b) {
      var on = b.dataset.sort === p.sort.key;
      b.setAttribute('aria-sort', on ? (p.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
      b.querySelector('i').textContent = on ? (p.sort.dir > 0 ? '↑' : '↓') : '';
    });
    // Rows
    var list = p.el.list;
    list.textContent = '';
    var frag = document.createDocumentFragment();
    sorted(p).forEach(function (e) {
      var picked = p.sel.has(e.name);
      var row = el('div', { class: 'xf-row' + (e.dir ? ' is-dir' : ''), role: 'option', 'aria-selected': picked ? 'true' : 'false', draggable: e.drive ? null : 'true', 'data-name': e.name, title: e.name + (e.link ? ' (a shortcut)' : '') }, [
        icon(kindIcon(e), 'xf-kind'),
        el('span', { class: 'xf-name', text: e.name }),
        el('span', { class: 'xf-size', text: e.dir ? '' : size(e.size) }),
        el('span', { class: 'xf-date', text: when(e.mtime) })
      ]);
      if (p.focus === e.name) row.classList.add('is-focus');
      frag.appendChild(row);
    });
    list.appendChild(frag);
    syncMsg(side);
    syncFoot(side);
  }
  // Only the picked and focused rows change (redrawing a folder of thousands of files on every click or arrow key
  // made it lag).
  function paintSel(side) {
    var p = panes[side];
    p.el.list.querySelectorAll('.xf-row').forEach(function (row) {
      var n = row.dataset.name, picked = p.sel.has(n);
      if (row.getAttribute('aria-selected') !== (picked ? 'true' : 'false')) row.setAttribute('aria-selected', picked ? 'true' : 'false');
      row.classList.toggle('is-focus', p.focus === n);
    });
    syncFoot(side);
  }
  function selected(side) {
    var p = panes[side];
    return p.entries.filter(function (e) { return p.sel.has(e.name) && !e.drive; });
  }
  function syncFoot(side) {
    var p = panes[side], o = panes[other(side)], sel = selected(side);
    var files = sel.filter(function (e) { return !e.dir; }), dirs = sel.length - files.length;
    var total = files.reduce(function (n, e) { return n + e.size; }, 0);
    p.el.selInfo.textContent = sel.length
      ? [dirs ? plural(dirs, 'folder') : '', files.length ? plural(files.length, 'file') + ' · ' + size(total) : ''].filter(Boolean).join(', ') + ' selected'
      : p.entries.length ? plural(p.entries.length, 'item') : '';
    p.el.go.disabled = !sel.length || !o.path || !!o.error;
    p.el.go.title = !sel.length ? 'Pick files or folders first' : !o.path ? 'Open a folder on the other side first' : (side === 'server' ? 'Copy to ' : 'Copy to the server: ') + o.path;
    if (p.el.rename) { p.el.rename.disabled = sel.length !== 1; p.el.del.disabled = !sel.length; }
  }
  function scrollToFocus(side) {
    var p = panes[side], row = p.el.list.querySelector('.is-focus');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  // ---------- Picking, keyboard, dragging ----------
  function rowOf(t) { return t && t.closest ? t.closest('.xf-row') : null; }
  function entryOf(side, row) { var n = row && row.dataset.name; return panes[side].entries.filter(function (e) { return e.name === n; })[0] || null; }
  function pick(side, name, how) {
    var p = panes[side], order = sorted(p).map(function (e) { return e.name; });
    if (how === 'range' && p.anchor != null && order.indexOf(p.anchor) >= 0) {
      var a = order.indexOf(p.anchor), b = order.indexOf(name);
      p.sel = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (how === 'toggle') {
      if (p.sel.has(name)) p.sel.delete(name); else p.sel.add(name);
      p.anchor = name;
    } else { p.sel = new Set([name]); p.anchor = name; }
    p.focus = name;
    paintSel(side);
  }
  // Is the pointer on a row's size or date (where a selection box starts; the name column drags the files)?
  function besideName(row, e) {
    var sz = row.querySelector('.xf-size');
    return !!sz && e.clientX >= sz.getBoundingClientRect().left - 4;
  }
  // The selection box (see wireList).
  function startBox(side, e) {
    var p = panes[side], list = p.el.list;
    e.preventDefault(); // (no file drag, no text selection)
    list.focus({ preventScroll: true });
    lastSide = side;
    var toggle = e.ctrlKey || e.metaKey, base = toggle || e.shiftKey ? new Set(p.selBefore || p.sel) : new Set(); // (a plain box starts a new selection)
    var lr = list.getBoundingClientRect();
    var y0 = e.clientY - lr.top + list.scrollTop, x0 = e.clientX - lr.left + list.scrollLeft;
    var box = null, px = e.clientX, py = e.clientY, raf = 0;
    var byName = {};
    p.entries.forEach(function (en) { byName[en.name] = en; });
    function update() {
      var r = list.getBoundingClientRect();
      var y1 = Math.max(0, Math.min(list.scrollHeight, py - r.top + list.scrollTop));
      var x1 = Math.max(0, Math.min(list.clientWidth, px - r.left)) + list.scrollLeft;
      if (!box) {
        if (Math.abs(y1 - y0) < 4 && Math.abs(x1 - x0) < 4) return;
        box = el('div', { class: 'xf-box', 'aria-hidden': 'true' });
        list.appendChild(box);
        p.pendingOne = null;
      }
      var top = Math.min(y0, y1), h = Math.abs(y1 - y0), left = Math.min(x0, x1), w = Math.abs(x1 - x0);
      box.style.top = top + 'px'; box.style.left = left + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
      var sel = new Set(base), first = null, last = null;
      list.querySelectorAll('.xf-row').forEach(function (row) {
        var a = row.offsetTop, b = a + row.offsetHeight, n = row.dataset.name;
        if (!(b > top && a < top + h) || (byName[n] && byName[n].drive)) return;
        if (toggle && base.has(n)) sel.delete(n); else sel.add(n);
        if (first == null) first = n;
        last = n;
      });
      p.sel = sel;
      if (first != null) { p.anchor = y1 >= y0 ? first : last; p.focus = y1 >= y0 ? last : first; }
      paintSel(side);
    }
    // Held near the top or bottom edge: the list scrolls, and the box keeps growing.
    function tick() {
      var r = list.getBoundingClientRect(), edge = 24, d = py < r.top + edge ? py - (r.top + edge) : py > r.bottom - edge ? py - (r.bottom - edge) : 0;
      if (d && box) { list.scrollTop += Math.max(-30, Math.min(30, d / 2)); update(); }
      raf = requestAnimationFrame(tick);
    }
    function move(ev) { px = ev.clientX; py = ev.clientY; update(); }
    function up() {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      cancelAnimationFrame(raf);
      if (box) box.remove();
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    raf = requestAnimationFrame(tick);
  }
  function wireList(side) {
    var p = panes[side], list = p.el.list;
    list.addEventListener('mousedown', function (e) {
      lastSide = side;
      p.selBefore = new Set(p.sel); // (a selection box starts from what was picked before this click)
      var row = rowOf(e.target);
      if (!row) { if (e.button === 0 && !e.ctrlKey && !e.shiftKey) { p.sel = new Set(); paintSel(side); } return; }
      var name = row.dataset.name;
      if (e.shiftKey) pick(side, name, 'range');
      else if (e.ctrlKey || e.metaKey) pick(side, name, 'toggle');
      else if (!p.sel.has(name)) pick(side, name, 'one');
      else { p.focus = name; p.pendingOne = name; }
    });
    // Click and drag from an empty spot (below the files, or on a file's size or date) draws a box, and
    // every file and folder it touches is picked, as in Windows. Ctrl toggles what it touches; Shift adds to what's
    // picked. Dragging a name (or its icon) still copies the files to the other side.
    list.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var row = rowOf(e.target);
      if (row && !besideName(row, e)) return;
      startBox(side, e);
    });
    list.addEventListener('click', function (e) {
      var row = rowOf(e.target);
      // A click (not a drag) on one of several picked: just that one.
      if (row && p.pendingOne === row.dataset.name && !e.shiftKey && !e.ctrlKey && p.sel.size > 1) pick(side, row.dataset.name, 'one');
      p.pendingOne = null;
    });
    list.addEventListener('dblclick', function (e) { var en = entryOf(side, rowOf(e.target)); if (en) openEntry(side, en); });
    list.addEventListener('focus', function () { lastSide = side; });
    list.addEventListener('keydown', function (e) {
      var order = sorted(p), names = order.map(function (x) { return x.name; });
      var at = names.indexOf(p.focus);
      var move = function (to) { to = Math.max(0, Math.min(names.length - 1, to)); if (!names.length) return; pick(side, names[to], e.shiftKey ? 'range' : 'one'); scrollToFocus(side); };
      if (e.key === 'ArrowDown') { e.preventDefault(); move(at + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(at < 0 ? 0 : at - 1); }
      else if (e.key === 'Home') { e.preventDefault(); move(0); }
      else if (e.key === 'End') { e.preventDefault(); move(names.length - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); var en = order[at]; if (en) openEntry(side, en); }
      else if (e.key === 'Backspace') { e.preventDefault(); goUp(side); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); p.sel = new Set(names.filter(function (n) { return !(order[names.indexOf(n)] || {}).drive; })); paintSel(side); }
      else if (e.key === 'Delete' && side === 'server' && p.sel.size) { e.preventDefault(); deleteSelected(); }
      else if (e.key === 'F2' && side === 'server' && p.sel.size === 1) { e.preventDefault(); renameSelected(); }
    });
    // Dragging rows to the other side.
    list.addEventListener('dragstart', function (e) {
      var row = rowOf(e.target);
      if (!row) return;
      if (!p.sel.has(row.dataset.name)) pick(side, row.dataset.name, 'one');
      drag = { side: side };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-shelf-files', side);
      var n = selected(side).length;
      var ghost = el('div', { class: 'xf-ghost', text: n === 1 ? selected(side)[0].name : n + ' items' });
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      setTimeout(function () { ghost.remove(); }, 0);
    });
    list.addEventListener('dragend', function () { drag = null; clearDrop(); });
    list.addEventListener('dragover', function (e) {
      var fromExplorer = !drag && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0;
      var ok = (drag && drag.side !== side) || (fromExplorer && side === 'server');
      if (!ok || !p.path) { e.dataTransfer.dropEffect = 'none'; return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      var row = rowOf(e.target), en = entryOf(side, row);
      var target = en && en.dir ? join(side, p.path, en.name) : p.path;
      if (!dropAt || dropAt.path !== target || dropAt.side !== side) {
        clearDrop();
        dropAt = { side: side, path: target, row: en && en.dir ? row : null };
        p.el.root.classList.add('is-drop');
        if (dropAt.row) dropAt.row.classList.add('is-drop');
      }
    });
    list.addEventListener('dragleave', function (e) { if (!list.contains(e.relatedTarget)) clearDrop(); });
    list.addEventListener('drop', function (e) {
      if (!drag || drag.side === side) return; // files from File Explorer are passed on by the app (onXferDrop)
      e.preventDefault();
      var from = drag.side, dest = dropAt && dropAt.side === side ? dropAt.path : p.path;
      drag = null; clearDrop();
      copySelected(from, dest);
    });
  }
  function clearDrop() {
    ['server', 'pc'].forEach(function (s) { if (panes[s].el) panes[s].el.root.classList.remove('is-drop'); });
    if (dropAt && dropAt.row) dropAt.row.classList.remove('is-drop');
    dropAt = null;
  }

  // ---------- Copying ----------
  function copySelected(side, destOverride) {
    var p = panes[side], o = panes[other(side)];
    var sel = selected(side);
    if (!sel.length) return;
    var dest = destOverride || o.path;
    if (!dest) { toast(side === 'server' ? 'Open a folder on This PC to copy into first.' : 'Open a folder on the server to copy into first.'); return; }
    startCopy(side === 'server' ? 'down' : 'up', sel.map(function (e) { return join(side, p.path, e.name); }), dest);
  }
  function startCopy(direction, sources, dest) {
    var toSide = direction === 'down' ? 'pc' : 'server';
    var where = direction === 'down' ? 'This PC' : 'your server';
    panes[toSide === 'pc' ? 'server' : 'pc'].el.go.classList.add('is-busy');
    var done = function () { ['server', 'pc'].forEach(function (s) { panes[s].el.go.classList.remove('is-busy'); }); };
    native.xferPlan(direction, sources, dest).then(function (plan) {
      done();
      if (!plan.files && !plan.folders) { toast(plan.blocked.length ? plan.blocked[0] : 'Nothing to copy there.'); return; }
      var different = plan.conflicts - plan.same;
      var full = direction === 'up' && plan.free != null && plan.free < plan.bytes;
      if (!different && !full) return go(plan, { same: 'skip', other: 'skip' });
      return askConflicts(plan, where, dest, toSide, full).then(function (policy) { if (policy) go(plan, policy); });
    }, function (e) { done(); toast(why(e).text || 'Couldn’t start that copy.'); });
  }
  function go(plan, policy) {
    return native.xferGo(plan.id, policy).then(function (snap) {
      queue = snap; paintQueue();
      var list = panes.queue.list;
      list.scrollTop = list.scrollHeight;
    }, function (e) { toast(why(e).text); });
  }

  // ---------- Small questions (files already there, a name, deleting) ----------
  function ask(o) {
    var d = el('dialog', { class: 'sheet xf-ask' + (o.cls ? ' ' + o.cls : ''), 'aria-labelledby': 'xfAskTitle', 'data-shelf-drop': 'none' });
    var err = el('p', { class: 'xf-err', hidden: true, role: 'alert' });
    var okBtn = el('button', { type: 'submit', class: 'pill ' + (o.danger ? 'danger-fill' : 'pill-primary'), id: 'xfAskOk', value: 'ok' }, [o.ok]);
    var form = el('form', { method: 'dialog' }, [
      el('div', { class: 'sheet-head' }, [
        el('span', { class: 'sv-art' + (o.danger ? ' danger' : ''), 'aria-hidden': 'true', html: I[o.art || 'folder'] }),
        el('div', {}, [el('h2', { id: 'xfAskTitle', text: o.title }), o.lead ? el('p', { text: o.lead }) : null])
      ])
    ].concat(o.body || [], [err, el('div', { class: 'sheet-actions' }, [el('button', { type: 'submit', class: 'pill', value: 'cancel', id: 'xfAskCancel' }, ['Cancel']), okBtn])]));
    d.appendChild(form);
    document.body.appendChild(d);
    return new Promise(function (resolve) {
      var answered = false;
      form.addEventListener('submit', function (e) {
        var yes = e.submitter && e.submitter.value === 'ok';
        if (!yes) return;
        if (o.check) {
          e.preventDefault();
          okBtn.disabled = true; err.hidden = true;
          Promise.resolve(o.check()).then(function (v) { answered = true; resolve(v); d.close(); }, function (x) { okBtn.disabled = false; err.textContent = why(x).text; err.hidden = false; });
        } else { answered = true; resolve(o.value ? o.value() : true); }
      });
      d.addEventListener('close', function () { if (!answered) resolve(null); d.remove(); var p = panes[lastSide]; if (p.el) p.el.list.focus(); });
      d.showModal();
      if (o.focus) { o.focus.focus(); if (o.focus.select) o.focus.select(); }
    });
  }
  function askConflicts(plan, where, dest, toSide, full) {
    var different = plan.conflicts - plan.same;
    var choice = 'skip';
    var opts = [
      ['skip', 'Skip Them', 'Leave the files that are there as they are'],
      ['replace', 'Replace Them', 'Copy over the files that are there'],
      ['both', 'Keep Both', 'Copy them with “(2)” added to the name']
    ];
    var radios = el('div', { class: 'xf-choices', role: 'radiogroup', 'aria-label': 'Files already there' }, opts.map(function (c) {
      return el('label', { class: 'xf-choice' }, [
        el('input', { type: 'radio', name: 'xfHow', value: c[0], checked: c[0] === choice, onchange: function () { choice = c[0]; } }),
        el('span', {}, [el('b', { text: c[1] }), el('small', { text: c[2] })])
      ]);
    }));
    var same = el('input', { type: 'checkbox', id: 'xfSkipSame', checked: true });
    var body = [];
    if (full) body.push(el('p', { class: 'xf-warn', text: 'There may not be enough room on the server: ' + size(plan.free) + ' free, and this is ' + size(plan.bytes) + '.' }));
    if (different) {
      body.push(el('p', { class: 'xf-names muted', text: quoteList(plan.names, different) }));
      body.push(radios);
    }
    if (plan.same && different) body.push(el('label', { class: 'xf-check' }, [same, el('span', { text: 'Skip the ' + plural(plan.same, 'file') + ' that ' + (plan.same === 1 ? 'is' : 'are') + ' the same size and date' })]));
    return ask({
      title: different ? plural(different, 'file is', 'files are').replace(/^1 file is/, 'A file is') + ' already there' + (plan.same ? ', and different' : '') : 'Copy anyway?',
      lead: different ? 'In “' + shortPath(toSide, dest) + '” on ' + where + '. What should Shelf do with ' + (different === 1 ? 'it' : 'them') + '?' : '',
      art: 'swap', body: body, ok: 'Copy',
      value: function () { return { same: same.checked ? 'skip' : 'ask', other: different ? choice : 'skip' }; }
    });
  }
  function newFolder(side) {
    var p = panes[side];
    if (!p.path) return;
    var input = el('input', { class: 'text xf-input', type: 'text', id: 'xfName', value: 'New Folder', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Folder name' });
    ask({
      title: 'New folder', lead: 'In “' + shortPath(side, p.path) + '” on ' + (side === 'server' ? 'your server' : 'this PC') + '.', art: 'newFolder',
      body: [input], ok: 'Make Folder', focus: input,
      check: function () { return native.xferMkdir(side, p.path, input.value); }
    }).then(function (made) {
      if (!made) return;
      var name = made.split(/[\\/]/).pop();
      done({ what: 'mkdir', side: side, dir: p.path, path: made, name: name });
      load(side, p.path, true).then(function () { p.sel = new Set([name]); p.anchor = p.focus = name; paint(side); scrollToFocus(side); });
    });
  }
  function renameSelected() {
    var p = panes.server, sel = selected('server');
    if (sel.length !== 1) return;
    var from = sel[0].name;
    var input = el('input', { class: 'text xf-input', type: 'text', id: 'xfName', value: from, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'New name' });
    var q = ask({
      title: 'Rename “' + from + '”', lead: 'On your server. Plex sees the new name the next time it looks.', art: 'rename',
      body: [input], ok: 'Rename', focus: input,
      check: function () { return native.xferRename(p.path, from, input.value); }
    });
    // Just the name, not the .mkv, is picked to start with.
    var dot = sel[0].dir ? -1 : from.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot);
    var dir = p.path;
    q.then(function (to) {
      if (!to) return;
      var name = to.split('/').pop();
      if (name !== from) done({ what: 'rename', side: 'server', dir: dir, from: from, to: name });
      load('server', p.path, true).then(function () { p.sel = new Set([name]); p.anchor = p.focus = name; paint('server'); scrollToFocus('server'); });
    });
  }
  // ---------- Undo (Ctrl+Z): renames and new folders, newest first ----------
  // (Deleting on the server can't be undone: there's no recycle bin there. Copies aren't undone either.)
  var history = [];
  function done(step) { history.push(step); if (history.length > 50) history.shift(); }
  function showIn(side, dir, name) {
    var p = panes[side];
    if (p.path !== dir) return;
    load(side, dir, true).then(function () {
      if (name && p.entries.some(function (e) { return e.name === name; })) { p.sel = new Set([name]); p.anchor = p.focus = name; }
      paint(side); scrollToFocus(side);
    });
  }
  var undoing = false;
  function undo() {
    if (undoing) return;
    var step = history.pop();
    if (!step) { toast('Nothing to undo here. (Renames and new folders can be undone; deleting can’t.)'); return; }
    undoing = true;
    var where = step.side === 'server' ? ' on your server' : '';
    var call = step.what === 'rename' ? native.xferRename(step.dir, step.to, step.from) : native.xferRmdir(step.side, step.path);
    call.then(function () {
      if (step.what === 'rename') { toast('Undone: “' + step.to + '” is “' + step.from + '” again' + where + '.'); showIn(step.side, step.dir, step.from); }
      else { toast('Undone: removed the new folder “' + step.name + '”' + where + '.'); showIn(step.side, step.dir, null); }
    }, function (e) {
      toast('Couldn’t undo that: ' + (why(e).text || 'it went wrong.'));
    }).then(function () { undoing = false; });
  }
  function deleteSelected() {
    var p = panes.server, sel = selected('server');
    if (!sel.length) return;
    var dirs = sel.filter(function (e) { return e.dir; }).length;
    ask({
      title: sel.length === 1 ? 'Delete “' + sel[0].name + '” from your server?' : 'Delete ' + sel.length + ' items from your server?',
      lead: (sel.length > 1 ? quoteList(sel.map(function (e) { return e.name; }), sel.length) + '. ' : '') + (dirs ? 'Folders are deleted with everything in them. ' : ''),
      body: [el('p', { class: 'row-help flush sp-warn xf-warn', text: 'This can’t be undone: deleted files don’t go to a recycle bin on the server.' })],
      art: 'trash', danger: true, ok: 'Delete', cls: 'xf-del',
      check: function () { return native.xferDelete(sel.map(function (e) { return join('server', p.path, e.name); })); }
    }).then(function (r) {
      if (!r) return;
      toast(r.failed.length ? 'Deleted ' + r.deleted + '. ' + plural(r.failed.length, 'item') + ' couldn’t be deleted: ' + r.failed[0].why : 'Deleted ' + plural(r.deleted, 'item') + ' from your server.');
      load('server', p.path, true);
    });
  }

  // ---------- The queue ----------
  var queue = { running: false, jobs: [] }, seen = {};
  function jobText(j) {
    var pct = j.bytesTotal ? Math.floor(100 * j.bytesDone / j.bytesTotal) : 0;
    if (j.state === 'running') {
      if (j.note) return { text: j.note, tone: 'warn' };
      if (j.phase === 'check') return { text: 'Checking the copy…' };
      var bits = [size(j.bytesDone) + ' of ' + size(j.bytesTotal)];
      if (j.rate > 0) bits.push(size(j.rate) + '/s');
      if (j.eta) bits.push(eta(j.eta));
      if (j.files > 1) bits.push('file ' + Math.min(j.files, j.filesDone + j.filesSkipped + j.filesFailed + 1) + ' of ' + j.files);
      return { text: bits.join(' · '), pct: pct };
    }
    if (j.state === 'waiting') return { text: 'Waiting · ' + (j.files ? plural(j.files, 'file') + ', ' + size(j.bytesTotal) : 'an empty folder'), pct: pct };
    if (j.state === 'paused') return { text: 'Paused at ' + pct + '% · ' + size(j.bytesDone) + ' of ' + size(j.bytesTotal), pct: pct };
    if (j.state === 'failed') {
      var e = j.errors[0] || { why: '' };
      var lead = j.filesFailed === j.files ? (j.files === 1 ? 'Didn’t copy' : 'None of the ' + j.files + ' files copied') : plural(j.filesFailed, 'file') + ' didn’t copy';
      return { text: lead + ': ' + (j.files > 1 && j.filesFailed === 1 ? e.name + ': ' : '') + e.why, tone: 'bad', pct: pct };
    }
    var parts = [];
    if (j.filesDone) parts.push('Copied ' + (j.files > 1 ? plural(j.filesDone, 'file') : '') + (j.filesSkipped ? '' : (j.files > 1 ? ', ' : '') + size(j.bytesTotal)));
    if (j.filesSkipped) parts.push(plural(j.filesSkipped, 'file') + ' already there, skipped');
    if (!parts.length) parts.push(j.isDir ? 'Folder made' : 'Done');
    return { text: parts.join(' · '), tone: 'good', pct: 100 };
  }
  function qbtn(cls, ic, label, fn) {
    return el('button', { type: 'button', class: 'xf-ibtn ' + cls, title: label, 'aria-label': label, onclick: fn }, [icon(ic)]);
  }
  function act(id, what) { native.xferAction(id, what).then(function (s) { queue = s; paintQueue(); }); }
  function paintQueue() {
    if (!sheet) return;
    var q = panes.queue, jobs = queue.jobs || [];
    var running = jobs.filter(function (j) { return j.state === 'running'; }), waiting = jobs.filter(function (j) { return j.state === 'waiting'; });
    var paused = jobs.filter(function (j) { return j.state === 'paused'; }), finished = jobs.filter(function (j) { return j.state === 'done'; });
    var failed = jobs.filter(function (j) { return j.state === 'failed'; });
    var sum = [];
    if (running.length) sum.push(plural(running.length, 'copying', 'copying'));
    if (waiting.length) sum.push(waiting.length + ' waiting');
    if (paused.length) sum.push(paused.length + ' paused');
    if (failed.length) sum.push(failed.length + ' with problems');
    if (finished.length) sum.push(finished.length + ' done');
    q.summary.textContent = sum.length ? sum.join(' · ') : '';
    q.pauseAll.hidden = !(running.length + waiting.length || paused.length);
    q.pauseAll.dataset.on = running.length + waiting.length ? '1' : '0';
    q.pauseAll.textContent = running.length + waiting.length ? 'Pause All' : 'Resume All';
    q.clear.hidden = !finished.length;
    sheet.classList.toggle('has-jobs', !!jobs.length);
    q.list.textContent = '';
    if (!jobs.length) {
      q.list.appendChild(el('p', { class: 'xf-qempty muted', text: 'Nothing copying right now. Pick files on either side and click Copy, or drag them across.' }));
    }
    jobs.forEach(function (j) {
      var t = jobText(j);
      var toWhere = (j.direction === 'down' ? 'to This PC: ' : 'to Server: ') + shortPath(j.direction === 'down' ? 'pc' : 'server', j.to);
      var btns = [];
      if (j.state === 'running' || j.state === 'waiting') btns.push(qbtn('xf-pause', 'pause', 'Pause', function () { act(j.id, 'pause'); }));
      if (j.state === 'paused') btns.push(qbtn('xf-resume', 'play', 'Resume', function () { act(j.id, 'resume'); }));
      if (j.state === 'failed') btns.push(qbtn('xf-retry', 'retry', 'Try Again', function () { act(j.id, 'retry'); }));
      btns.push(qbtn('xf-cancel', 'x', j.state === 'done' || j.state === 'failed' ? 'Remove from the list' : 'Cancel (the unfinished file is removed)', function () { act(j.id, 'cancel'); }));
      var bar = el('div', { class: 'xf-jbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(t.pct || 0), 'aria-label': j.name }, [el('i')]);
      bar.firstChild.style.width = (t.pct || 0) + '%'; // (set this way: the page's rules allow no style="" attributes)
      q.list.appendChild(el('div', { class: 'xf-job', role: 'listitem', 'data-state': j.state, 'data-id': String(j.id) }, [
        el('span', { class: 'xf-jic', 'aria-hidden': 'true', html: j.state === 'done' ? I.check : j.direction === 'down' ? I.down : I.send }),
        el('div', { class: 'xf-jmain' }, [
          el('div', { class: 'xf-jtop' }, [el('b', { class: 'xf-jname', text: j.name + (j.isDir ? ' (folder)' : ''), title: j.from }), el('small', { class: 'muted xf-jto', text: toWhere, title: j.to })]),
          bar,
          el('div', { class: 'xf-jinfo' + (t.tone ? ' is-' + t.tone : ''), text: t.text, title: j.current ? 'Now: ' + j.current : '' })
        ]),
        el('div', { class: 'xf-jbtns' }, btns)
      ]));
    });
    // Finished copies: the folder they went to is shown again, with them in it.
    jobs.forEach(function (j) {
      var was = seen[j.id];
      if ((j.state === 'done' || j.state === 'failed') && was && was !== j.state && was !== 'done' && was !== 'failed') {
        var side = j.direction === 'down' ? 'pc' : 'server';
        if (sheet.open && panes[side].path === j.to) load(side, panes[side].path, true);
      }
      seen[j.id] = j.state;
    });
    syncBackground();
  }
  // Copies carry on with this window closed: Shelf's activity line shows how far along they are.
  var bgJob = null;
  function syncBackground() {
    var jobs = (queue.jobs || []).filter(function (j) { return j.state === 'running' || j.state === 'waiting'; });
    var show = jobs.length && sheet && !sheet.open && shelf() && shelf().busy;
    if (!show) { if (bgJob) { bgJob.done(); bgJob = null; } return; }
    var total = jobs.reduce(function (n, j) { return n + j.bytesTotal; }, 0), done = jobs.reduce(function (n, j) { return n + j.bytesDone; }, 0);
    var label = 'Copying ' + plural(jobs.length, 'item') + (jobs[0].direction === 'down' ? ' to this PC' : ' to your server') + '… ' + (total ? Math.floor(100 * done / total) : 0) + '%';
    if (!bgJob) bgJob = shelf().busy(label);
    else bgJob.set(label);
  }

  // ---------- Opening ----------
  function open() {
    build();
    if (!sheet.open) sheet.showModal();
    native.xferStart().then(function (r) {
      var first = !info;
      info = { host: r.host, server: r.server, pc: r.pc };
      queue = r.queue || queue;
      paintQueue();
      if (first || !panes.server.path) load('server', r.server.start); else load('server', panes.server.path, true);
      if (first || (!panes.pc.path && !info.pc.drives)) load('pc', r.pc.start); else load('pc', panes.pc.path, true);
      setTimeout(function () { panes.server.el.list.focus(); }, 0);
    }, function (e) {
      var w = why(e);
      sheet.close();
      toast(w.text || 'Couldn’t reach your server.');
      if (window.ShelfSend && /^(NO_SERVER|NO_LOGIN|AUTH|HOST_)/.test(w.code)) window.ShelfSend.open();
    });
  }
  var btn = $('filesBtn');
  if (btn) btn.addEventListener('click', open);
  window.ShelfFiles = { open: open, undo: undo, _panes: panes, _queue: function () { return queue; }, _history: function () { return history; } };
})();
