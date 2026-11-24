/*
 * Shelf — Missing Episodes (the window side): pick a show, see which of its episodes you don't have yet.
 * Opened from a show's shelf ("Missing Episodes") or the ⚙ menu (where the shows on your Plex server can be
 * picked too). The episodes you have are the files in Shelf's list (what Shelf worked out, your picks in Inspect,
 * splits) and the files in the show's folders on your server, by their names (desktop/showcheck.js lists them,
 * read only). The counting is in missing.js.
 */
(function () {
  'use strict';
  var native = window.shelfNative || {};
  var M = window.ShelfMissing;
  if (!M || !document.getElementById('missingSheet')) return;

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = v; else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function shelf() { return window.Shelf || null; }
  function tv() { return shelf() && shelf().tv; }
  function n(x) { return Number(x).toLocaleString(); }
  function plural(k, one, many) { return n(k) + ' ' + (k === 1 ? one : many); }
  // Problems from the app arrive as "Error invoking remote method 'x': Error: [CODE] Plain words".
  function plain(e) {
    return String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^\w*Error:\s*/, '').replace(/^\[[A-Z_]+\]\s*/, '') || 'Something went wrong.';
  }
  // "Seasons 1–3, 5 and 7"
  function seasonsText(list) {
    var runs = [];
    list.forEach(function (s) { var r = runs[runs.length - 1]; if (r && s === r[1] + 1) r[1] = s; else runs.push([s, s]); });
    var parts = [];
    runs.forEach(function (r) { if (r[1] - r[0] === 1) parts.push(String(r[0]), String(r[1])); else parts.push(r[0] === r[1] ? String(r[0]) : r[0] + '–' + r[1]); });
    return (list.length === 1 ? 'Season ' : 'Seasons ') + (parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]);
  }
  var SERVICE = { TMDB: 'The Movie Database', TheTVDB: 'TheTVDB', TVmaze: 'TVmaze' };

  var st = { folders: null, server: null, serverNote: '', run: 0, copy: '' };

  // ---- The show picker ----
  function serverReady(s) { return !!(s && s.set && s.hasLogin && (s.tv || ((s.plex && s.plex.libraries) || []).some(function (l) { return l.kind === 'tv'; }))); }
  function open(showKey) {
    if (!tv()) return;
    var d = $('missingSheet'), run = ++st.run;
    st.folders = null; st.serverNote = ''; st.copy = '';
    $('msTitle').textContent = 'Missing episodes';
    $('msLead').textContent = 'Pick a show to see which of its episodes you don’t have yet.';
    $('msShow').replaceChildren(); $('msShow').disabled = true;
    waiting('Getting your shows…');
    $('msHelp').textContent = '';
    if (!d.open) d.showModal();
    var look = native.server ? native.server().then(function (s) {
      st.server = s;
      if (!serverReady(s) || !native.showFolders) return null;
      waiting('Getting the shows on your server…');
      return native.showFolders().then(function (r) { return r.shows || []; }, function (e) { st.serverNote = 'Couldn’t look on your server: ' + plain(e); return null; });
    }, function () { return null; }) : Promise.resolve(null);
    look.then(function (folders) {
      if (run !== st.run) return;
      st.folders = folders;
      fillPicker(showKey);
    });
  }
  function fillPicker(showKey) {
    var sel = $('msShow'), mine = tv().inList(), folders = st.folders || [];
    var opts = [];
    if (mine.length) {
      opts.push(el('optgroup', { label: 'In your list' }, mine.map(function (x) {
        return el('option', { value: 'list:' + x.key, text: x.show.title + (x.show.year ? ' (' + x.show.year + ')' : '') });
      })));
    }
    // The server's show folders (those that are a show in the list already are picked through it).
    var others = folders.filter(function (f) { return !mine.some(function (x) { return M.matchFolder(f.name, x.show) === 'yes'; }); });
    if (others.length) {
      opts.push(el('optgroup', { label: 'On your Plex server' }, others.map(function (f) {
        return el('option', { value: 'server:' + f.path, text: f.name, title: f.lib + ' / ' + f.name });
      })));
    }
    var want = showKey ? 'list:' + showKey : mine.length ? 'list:' + mine[0].key : '';
    if (!want && opts.length) opts.unshift(el('option', { value: '', text: 'Pick a show…' }));
    sel.replaceChildren.apply(sel, opts);
    sel.disabled = !opts.length;
    if (!opts.length) {
      done();
      $('msSum').replaceChildren(el('div', { class: 'ms-big' }, [el('b', { text: 'No shows to check yet' })]));
      $('msHelp').textContent = 'Add a show’s files to the list' + (serverReady(st.server) ? '' : ', or set up your Plex server (Send to Plex) so Shelf can look at the shows on it') + '. ' + st.serverNote;
      return;
    }
    sel.value = want;
    if (sel.value) check(sel.value); else { done(); $('msHelp').textContent = plural(folders.length, 'show is', 'shows are') + ' on your server. ' + st.serverNote; }
  }
  $('msShow').addEventListener('change', function () { if (this.value) check(this.value); });

  // ---- A show on the server: which show it is ----
  function identify(name) {
    var info = M.folderInfo(name), ids = {};
    ['tmdb', 'tvdb', 'imdb'].forEach(function (k) { if (info.ids[k]) ids[k] = info.ids[k]; });
    var best = function (cands) {
      cands = cands || [];
      var score = function (c) { var m = M.matchFolder(name, c); return m === 'yes' ? 2 : m === 'maybe' ? 1 : 0; };
      return cands.slice().sort(function (a, b) { return score(b) - score(a); })[0] || null;
    };
    var title = info.title || name;
    var search = function (q) { return tv().search(q).then(best); };
    var byId = Object.keys(ids).length ? tv().byId(ids).then(function (c) { return c && c[0]; }, function () { return null; }) : Promise.resolve(null);
    return byId.then(function (c) {
      if (c) return c;
      // "SpongeBob SquarePants v2": if the whole name finds nothing, without its last word.
      return search(title).then(function (c2) {
        var w = title.split(' ');
        return c2 || (w.length > 1 ? search(w.slice(0, -1).join(' ')) : null);
      });
    });
  }

  // ---- The check ----
  function check(value) {
    var run = ++st.run, T = tv();
    var picked = null, who;
    if (value.indexOf('list:') === 0) {
      var x = T.inList().filter(function (s) { return s.key === value.slice(5); })[0];
      who = x ? Promise.resolve({ show: x.show, items: x.items }) : Promise.reject(new Error('That show isn’t in the list any more.'));
    } else {
      picked = (st.folders || []).filter(function (f) { return 'server:' + f.path === value; })[0];
      if (!picked) return;
      waiting('Finding ' + picked.name + ' on ' + SERVICE[T.service()] + '…');
      who = identify(picked.name).then(function (c) {
        if (!c) throw new Error(SERVICE[T.service()] + ' doesn’t know a show called “' + (M.folderInfo(picked.name).title || picked.name) + '”.');
        var x2 = T.inList().filter(function (s) { return s.key === T.key(c); })[0];
        return { show: c, items: x2 ? x2.items : [] };
      });
    }
    var w;
    who.then(function (got) {
      w = got;
      if (run !== st.run) return null;
      waiting('Getting the episode list of ' + w.show.title + '…');
      return T.episodes(w.show);
    }).then(function (list) {
      if (run !== st.run || !list) return null;
      w.list = list;
      // The show's folders on the server: named for it (or the one you picked). Ones only named a bit like it
      // count when the files in them say it.
      var folders = (st.folders || []).map(function (f) { return { f: f, how: f === picked ? 'yes' : M.matchFolder(f.name, w.show) }; }).filter(function (x) { return x.how; })
        .sort(function (a, b) { return (a.how === 'yes' ? 0 : 1) - (b.how === 'yes' ? 0 : 1); }); // (named for it first)
      if (!folders.length) return [];
      waiting('Looking in ' + (folders.length === 1 ? folders[0].f.name : folders.length + ' folders') + ' on your server…');
      return native.showFiles(folders.map(function (x) { return x.f.path; })).then(function (res) {
        return folders.map(function (x) {
          var r = (res || []).filter(function (y) { return y.path === x.f.path; })[0] || { files: [] };
          return { folder: x.f, files: r.files || [], truncated: !!r.truncated, how: x.how };
        }).filter(function (x) { return x.how === 'yes' || M.filesAgree(x.files.map(function (f) { return f.name; }), w.show); });
      }, function (e) { st.serverNote = 'Couldn’t look on your server: ' + plain(e); return []; });
    }).then(function (server) {
      if (run !== st.run || !server) return;
      w.server = server;
      paint(w);
    }, function (e) {
      if (run !== st.run) return;
      done();
      $('msSum').replaceChildren(el('div', { class: 'ms-big is-bad' }, [el('b', { text: 'Couldn’t check this show' })]));
      $('msHelp').textContent = plain(e);
    });
  }

  function waiting(text) {
    $('msList').replaceChildren();
    $('msCopy').hidden = true;
    $('msSum').replaceChildren(el('div', { class: 'ms-wait' }, [el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', { text: text })]));
    $('missingSheet').classList.add('is-busy');
  }
  function done() { $('missingSheet').classList.remove('is-busy'); }

  function paint(w) {
    done();
    var T = tv(), show = w.show, svc = SERVICE[T.service()];
    var local = w.items.map(function (i) { return M.heldByItem(i); });
    var remote = [];
    w.server.forEach(function (s) { s.files.forEach(function (f) { remote.push(M.heldByName(f.name, f.folders)); }); });
    var r = M.compare(w.list, local.concat(remote));
    var name = show.title + (show.year ? ' (' + show.year + ')' : '');
    $('msTitle').textContent = show.title;
    $('msLead').textContent = 'Which episodes you don’t have yet, season by season. Specials and episodes that haven’t aired aren’t counted.';

    // The headline: all there, or how many are missing; and a bar of how much you have.
    var bar = el('span', { class: 'ms-bar', 'aria-hidden': 'true' }, [el('i')]);
    bar.firstChild.style.width = (r.total ? Math.round(1000 * r.have / r.total) / 10 : 0) + '%';
    var big = !r.total ? el('div', { class: 'ms-big' }, [el('b', { text: svc + ' doesn’t list any aired episodes of ' + show.title + ' yet' })])
      : r.complete ? el('div', { class: 'ms-big is-done' }, [el('span', { class: 'ms-tick', 'aria-hidden': 'true', text: '✓' }), el('b', { text: 'You have all ' + plural(r.total, 'episode', 'episodes') }),
        el('small', { text: seasonsText(r.seasons.filter(function (s) { return s.total; }).map(function (s) { return s.season; })) + ', every episode that has aired' })])
      : el('div', { class: 'ms-big is-gap' }, [el('b', { text: 'Missing ' + n(r.missing) + ' of ' + plural(r.total, 'episode', 'episodes') }),
        el('small', { text: 'You have ' + n(r.have) + ' (' + Math.floor(100 * r.have / r.total) + '%)' })]);
    $('msSum').replaceChildren(big, r.total ? bar : null);

    // Season by season: the missing ones listed, the complete seasons on one line.
    var blocks = [], whole = [], copy = [show.title + ' — missing episodes'];
    r.seasons.forEach(function (s) {
      if (!s.total) return;
      if (!s.missing.length) { whole.push(s.season); return; }
      copy.push('');
      s.missing.forEach(function (e) { copy.push(e.code + (e.name ? ' ' + e.name : '')); });
      blocks.push(el('div', { class: 'dp-group ms-season', 'data-season': String(s.season) }, [
        el('div', { class: 'dp-head' }, [el('b', { text: 'Season ' + s.season }), el('span', { text: s.have ? 'missing ' + s.missing.length + ' of ' + s.total : 'none of its ' + s.total })]),
        el('div', { class: 'group' }, s.missing.map(function (e) {
          return el('div', { class: 'row ms-ep' }, [el('span', { class: 'ms-code', text: e.code }), el('span', { class: 'ms-name', text: e.name || 'Episode ' + e.number }),
            e.aired ? el('small', { class: 'muted', text: e.aired.slice(0, 4) }) : null]);
        }))
      ]));
    });
    var notes = [];
    if (whole.length && !r.complete) notes.push(el('p', { class: 'ms-note is-ok' }, [el('b', { text: '✓ Complete: ' }), seasonsText(whole)]));
    var soon = r.seasons.filter(function (s) { return s.upcoming; });
    if (r.upcoming) notes.push(el('p', { class: 'ms-note' }, ['Not out yet: ' + plural(r.upcoming, 'episode', 'episodes') + ' (' + seasonsText(soon.map(function (s) { return s.season; })) + '), not counted.']));
    if (r.specials && r.specials.total) notes.push(el('p', { class: 'ms-note' }, ['Specials aren’t counted: you have ' + n(r.specials.have) + ' of ' + n(r.specials.total) + '.']));
    if (r.extra.length) notes.push(el('p', { class: 'ms-note is-warn' }, [plural(r.extra.length, 'episode', 'episodes') + ' you have ' + (r.extra.length === 1 ? 'isn’t' : 'aren’t') + ' on ' + svc + '’s list (' +
      r.extra.slice(0, 4).map(function (e) { return e.code; }).join(', ') + (r.extra.length > 4 ? '…' : '') + '). They may be numbered in another order: Settings → TV Shows → Episode order.']));
    var localUnknown = local.filter(function (h) { return !h; }).length, remoteUnknown = remote.filter(function (h) { return !h; }).length;
    if (localUnknown) notes.push(el('p', { class: 'ms-note is-warn' }, [plural(localUnknown, 'file', 'files') + ' in the list ' + (localUnknown === 1 ? 'doesn’t' : 'don’t') + ' say which episode ' + (localUnknown === 1 ? 'it is' : 'they are') + ' yet, so ' + (localUnknown === 1 ? 'it isn’t' : 'they aren’t') + ' counted. Read Title Cards or Inspect can find out.']));
    if (remoteUnknown) notes.push(el('p', { class: 'ms-note is-warn' }, [plural(remoteUnknown, 'file', 'files') + ' on your server ' + (remoteUnknown === 1 ? 'has' : 'have') + ' no episode number in ' + (remoteUnknown === 1 ? 'its name' : 'their names') + ', so ' + (remoteUnknown === 1 ? 'it isn’t' : 'they aren’t') + ' counted. Fix My Plex Library can name them.']));
    $('msList').replaceChildren.apply($('msList'), blocks.concat(notes.length ? [el('div', { class: 'ms-notes' }, notes)] : []));
    st.copy = r.missing ? copy.join('\n') : '';
    $('msCopy').hidden = !r.missing;

    // Where Shelf looked.
    var inServer = w.server.reduce(function (t, s) { return t + s.files.length; }, 0);
    var where = [w.items.length ? plural(w.items.length, 'file', 'files') + ' in this list' : '', w.server.length ? plural(inServer, 'file', 'files') + ' on your server (' + w.server.map(function (s) { return s.folder.lib + ' / ' + s.folder.name; }).join(', ') + ')' : ''].filter(Boolean);
    var busy = T.inList().busy;
    $('msHelp').textContent = 'Compared with ' + svc + '’s episode list of ' + name + ', the order Plex uses. Counted: ' + (where.join(' and ') || 'no files') + '.' +
      (w.server.some(function (s) { return s.truncated; }) ? ' (Stopped at 20,000 files.)' : '') +
      (!serverReady(st.server) ? ' Set up your Plex server (Send to Plex) to count the episodes on it too.' : !w.server.length && !st.serverNote ? ' No folder for this show was found on your server.' : '') +
      (st.serverNote ? ' ' + st.serverNote : '') + (busy ? ' Shelf is still looking up ' + plural(busy, 'file', 'files') + ' in the list: check again when it’s done.' : '');
  }

  $('msCopy').addEventListener('click', function () {
    if (!st.copy) return;
    try { navigator.clipboard.writeText(st.copy).then(function () { if (shelf()) shelf().toast('Copied the missing episodes.'); }, function () {}); } catch (e) { /* no clipboard */ }
  });
  $('missingSheet').addEventListener('close', function () { st.run++; });
  var btn = $('missingBtn');
  if (btn) btn.addEventListener('click', function () { open(null); });

  window.ShelfMissingUI = { open: open };
})();
