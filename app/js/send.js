/*
 * Shelf — Send to Plex (the window side).
 * Setting up your server, the "Send to Plex?" sheet, and the progress tray.
 * All the SSH work happens in the app itself (desktop/server.js); this page never sees your password
 * once it's typed, or Shelf's key, or your Plex token.
 */
(function () {
  'use strict';
  var native = window.shelfNative;
  if (!native || !native.server) return;

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
  function bytes(b) {
    if (!(b > 0)) return '0 MB';
    if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
    if (b >= 1e9) return (b / 1e9).toFixed(b >= 1e11 ? 0 : 1) + ' GB';
    return Math.max(1, Math.round(b / 1e6)) + ' MB';
  }
  function eta(secs) {
    if (!(secs > 0) || !isFinite(secs)) return '';
    if (secs < 50) return 'a few seconds left';
    if (secs < 90) return 'about a minute left';
    if (secs < 3600) return 'about ' + Math.round(secs / 60) + ' min left';
    var h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
    return 'about ' + h + ' h' + (m ? ' ' + m + ' min' : '') + ' left';
  }
  // Problems arrive as "Error invoking remote method 'x': Error: [CODE] Plain words".
  function why(e) {
    var m = String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^\w*Error:\s*/, '');
    var c = /^\[([A-Z_]+)\]\s*/.exec(m);
    return { code: c ? c[1] : 'OTHER', text: c ? m.slice(c[0].length) : m };
  }
  function shelf() { return window.Shelf || null; }
  function toast(m) { if (shelf() && shelf().toast) shelf().toast(m); }
  function rerender() { if (shelf() && shelf().refresh) shelf().refresh(); }

  var st = null; // what the app says about your server (never secrets)

  function refresh() {
    return native.server().then(function (s) { st = s; paint(); return s; }, function () { return st; });
  }

  // ---------- Which renamed files haven't gone to Plex yet ----------
  function renamed() { return shelf() ? shelf().items().filter(function (i) { return i.status === 'done' && i.sendPaths && i.sendPaths.length; }) : []; }
  function unsent() {
    var out = [];
    renamed().forEach(function (i) { if (i.sendState !== 'sent' && i.sendState !== 'queued' && i.sendState !== 'sending') out = out.concat(i.sendPaths); });
    return out;
  }
  var pathState = {}; // local path → queued | sending | sent | failed | skipped
  function syncItems() {
    renamed().forEach(function (i) {
      var states = i.sendPaths.map(function (p) { return pathState[p] || ''; });
      var s = states.indexOf('sending') >= 0 ? 'sending' : states.indexOf('queued') >= 0 ? 'queued' : states.indexOf('failed') >= 0 ? 'failed'
        : states.every(function (x) { return x === 'sent'; }) ? 'sent' : states.indexOf('skipped') >= 0 ? 'skipped' : '';
      i.sendState = s;
    });
  }

  // ---------- Sidebar and toolbar ----------
  function paint() {
    var src = $('serverStatus');
    if (src && st) {
      var dot = src.querySelector('.dot');
      var running = st.sending && st.sending.running;
      var folders = st.movies || st.tv;
      dot.className = 'dot ' + (!st.set ? 'dot-off' : !st.hasLogin || !folders ? 'dot-warn' : running ? 'dot-busy' : 'dot-ok');
      $('serverName').textContent = st.set ? st.host : 'Not set up';
      $('serverNote').textContent = !st.set ? 'Set Up' : !st.hasLogin ? 'Log In' : !folders ? 'Pick Folders' : running ? Math.round(100 * (st.sending.bytesDone || 0) / Math.max(1, st.sending.bytesTotal)) + '%' : 'Ready';
    }
    var btn = $('sendBtn');
    if (btn) {
      var n = unsent().length;
      $('sendCount').hidden = !n;
      $('sendCount').textContent = n;
      var renameReady = !$('renameBtn').disabled;
      btn.classList.toggle('pill-primary', !!n && !renameReady);
      btn.title = !st || !st.set ? 'Set up your Plex server, then send your renamed files straight to it'
        : n ? 'Send ' + n + ' renamed file' + (n === 1 ? '' : 's') + ' to ' + st.host : 'Send files from your library to ' + st.host;
    }
    var row = $('renameSendRow');
    if (row && st) row.hidden = !st.set;
    if ($('fixLibBtn') && st) $('fixLibBtn').hidden = !(st.set && st.hasLogin && (st.movies || st.tv || (st.plex.libraries || []).length));
    if ($('dupesBtn') && st) $('dupesBtn').hidden = !(st.set && st.hasLogin && (st.tv || (st.plex.libraries || []).some(function (l) { return l.kind === 'tv'; })));
  }

  // ---------- Setting up your server ----------
  var sv = { step: 'find', back: 'find', fz: null, probe: null, browseKind: null, browsePath: '' };
  function step(name) {
    sv.step = name;
    $('svBox').dataset.step = name;
    $('svError').hidden = true;
    $('svNote').hidden = true;
    var T = {
      find: ['Connect your Plex server', 'Shelf sends your renamed files straight to your server over SSH, the same secure way FileZilla does. They never go through the internet.'],
      trust: ['Is this your server?', ''],
      login: ['Log in to ' + (sv.probe ? sv.probe.host : 'your server'), 'Use the same username and password you use in FileZilla.'],
      ready: ['Your Plex server', ''],
      browse: [sv.browseKind === 'movies' ? 'Choose the Movies folder' : 'Choose the TV Shows folder', 'Open the folder your Plex library uses, then click Use This Folder.'],
      forget: ['Forget this server?', '']
    }[name];
    $('svTitle').textContent = T[0];
    $('svLead').textContent = T[1];
    $('svLead').hidden = !T[1];
    var back = $('svBack'), next = $('svNext');
    back.hidden = false; next.hidden = false; next.disabled = false; next.classList.remove('danger-fill');
    if (name === 'find') { back.textContent = 'Cancel'; next.textContent = 'Continue'; syncFind(); }
    if (name === 'trust') { back.textContent = 'Back'; next.textContent = sv.probe && sv.probe.changed ? 'Trust the New Fingerprint' : 'Yes, This Is My Server'; if (sv.probe && sv.probe.changed) next.classList.add('danger-fill'); }
    if (name === 'login') { back.textContent = 'Back'; next.textContent = 'Connect'; }
    if (name === 'ready') { back.hidden = true; next.textContent = 'Done'; paintReady(); }
    if (name === 'browse') { back.textContent = 'Back'; next.textContent = 'Use This Folder'; }
    if (name === 'forget') { back.textContent = 'Cancel'; next.textContent = 'Forget Server'; next.classList.add('danger-fill'); $('svRemoveKeyRow').hidden = !(st && st.auth === 'key'); }
  }
  function busy(on, text) {
    $('svBusy').hidden = !on;
    $('svBusyText').textContent = text || '';
    $('svNext').disabled = !!on;
    $('svBox').classList.toggle('is-busy', !!on);
  }
  function fail(e) {
    busy(false);
    var w = typeof e === 'string' ? { code: 'OTHER', text: e } : why(e);
    $('svError').textContent = w.text;
    $('svError').hidden = false;
    return w;
  }
  function openServer(start) {
    var d = $('serverSheet');
    if (!d.open) d.showModal();
    busy(false);
    refresh().then(function (s) {
      if (sv.recheck && s && s.set) {
        // The server's fingerprint changed: look it up again and show you what's different.
        sv.recheck = false;
        $('svHost').value = s.host; $('svPort').value = s.port;
        step('find');
        return go();
      }
      if (start) return step(start);
      if (s && s.set && s.hasLogin) return step('ready');
      if (s && s.set) { $('svHost').value = s.host; $('svPort').value = s.port; }
      step('find');
      loadFileZilla();
    });
  }
  function loadFileZilla() {
    native.serverFileZilla().then(function (list) {
      var box = $('fzList');
      box.textContent = '';
      $('fzBox').hidden = !list.length;
      $('svManualLabel').textContent = list.length ? 'Or type it in' : 'Your server';
      list.forEach(function (f) {
        box.appendChild(el('button', { type: 'button', class: 'cand fz-item', 'aria-pressed': sv.fz && sv.fz.id === f.id ? 'true' : 'false', onclick: function () {
          sv.fz = f;
          $('svHost').value = f.host; $('svPort').value = f.port; $('svUser').value = f.user;
          box.querySelectorAll('.fz-item').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
          this.setAttribute('aria-pressed', 'true');
          syncFind();
          go(); // straight on to checking it: one click
        } }, [
          el('span', { class: 'radio', 'aria-hidden': 'true' }),
          el('span', { class: 'cand-text' }, [el('b', { text: f.name }), el('span', { text: f.user + '@' + f.host + (f.port !== 22 ? ':' + f.port : '') + (f.hasPassword ? ' · password saved' : f.hasKey ? ' · key file' : '') })])
        ]));
      });
    }).catch(function () { $('fzBox').hidden = true; });
  }
  function syncFind() { $('svNext').disabled = !$('svHost').value.trim(); }

  function go() {
    var s = sv.step;
    if (s === 'find') {
      var host = $('svHost').value.trim(), port = Number($('svPort').value) || 22;
      if (!host) return;
      if (sv.fz && (sv.fz.host !== host || sv.fz.port !== port)) sv.fz = null;
      busy(true, 'Looking for ' + host + '…');
      native.serverProbe(host, port).then(function (r) {
        busy(false);
        sv.probe = { host: host, port: port, fingerprint: r.fingerprint, keyType: r.keyType, changed: r.changed, was: r.was, known: r.known };
        showTrust();
        step('trust');
        if (r.known) go(); // the fingerprint you already trusted: straight on to logging in
      }, fail);
    } else if (s === 'trust') {
      if (sv.probe.changed && st && st.set && st.host === sv.probe.host && st.hasLogin) {
        busy(true, 'Saving…');
        native.serverRetrust(sv.probe.fingerprint).then(function (r) { st = r; busy(false); toast('Shelf now trusts the new fingerprint.'); step('ready'); }, fail);
        return;
      }
      if (!$('svUser').value && st && st.user && st.host === sv.probe.host) $('svUser').value = st.user;
      var fzPass = !!(sv.fz && (sv.fz.hasPassword || sv.fz.hasKey));
      $('svFzPass').hidden = !fzPass; $('svPassRow').hidden = fzPass;
      $('svFzPassText').textContent = sv.fz && sv.fz.hasKey ? 'Using the key file FileZilla uses' : 'Using the password saved in FileZilla';
      $('svPass').value = '';
      step('login');
      setTimeout(function () { ($('svUser').value ? (fzPass ? $('svNext') : $('svPass')) : $('svUser')).focus(); }, 30);
    } else if (s === 'login') {
      var useFz = sv.fz && (sv.fz.hasPassword || sv.fz.hasKey) && $('svPassRow').hidden;
      busy(true, $('svUseKey').checked ? 'Logging in and setting up a secure key…' : 'Logging in…');
      native.serverLogin({ user: $('svUser').value.trim(), password: useFz ? '' : $('svPass').value, fz: useFz ? sv.fz.id : null, trust: sv.probe.fingerprint, useKey: $('svUseKey').checked })
        .then(function (r) {
          $('svPass').value = '';
          st = r; busy(false); paint();
          step('ready');
          var note = r.note || (r.auth === 'key' ? 'Connected. Shelf set up its own secure key and forgot your password.' : 'Connected.');
          if (!r.movies || !r.tv) note += r.plex.libraries.length ? ' Shelf found your Plex libraries.' : ' Now choose where movies and TV shows go.';
          $('svNote').textContent = note; $('svNote').hidden = false;
        }, function (e) { var w = fail(e); if (w.code === 'AUTH') $('svPass').select(); });
    } else if (s === 'ready') {
      $('serverSheet').close();
    } else if (s === 'browse') {
      busy(true, 'Checking you can save files there…');
      native.serverFolder(sv.browseKind, sv.browsePath).then(function (r) { st = r; busy(false); paint(); step('ready'); }, fail);
    } else if (s === 'forget') {
      busy(true, 'Forgetting…');
      native.serverForget($('svRemoveKey').checked && st && st.auth === 'key').then(function (r) {
        st = r; busy(false); paint();
        sv.fz = null; sv.probe = null;
        $('svHost').value = ''; $('svUser').value = '';
        step('find'); loadFileZilla();
        toast(r.removed ? 'Server forgotten, and Shelf’s key was taken off it.' : 'Server forgotten.');
      }, fail);
    }
  }
  function backStep() {
    var s = sv.step;
    if (s === 'find' || s === 'ready') return $('serverSheet').close();
    if (s === 'trust') return step('find');
    if (s === 'login') return step('trust');
    if (s === 'browse' || s === 'forget') return st && st.set ? step('ready') : step('find');
  }
  function showTrust() {
    var p = sv.probe;
    $('fpValue').textContent = p.fingerprint;
    $('fpLabel').textContent = (p.keyType || 'Server') + ' fingerprint';
    $('fpCard').classList.toggle('changed', !!p.changed);
    $('fpWas').hidden = !p.changed;
    $('fpWas').textContent = p.changed ? 'Before: ' + p.was : '';
    $('fpExplain').textContent = p.changed
      ? 'This isn’t the fingerprint Shelf saw before, so Shelf stopped and sent nothing. That’s expected if you reinstalled Ubuntu or SSH on the server. If you didn’t, something else on your network may be pretending to be your server: don’t continue, and check the fingerprint on the server itself.'
      : 'Every server has its own fingerprint. Shelf will remember this one, and if it ever changes, Shelf will stop before sending your password or any file. That way no other device on your network can pretend to be your server.';
    var k = (p.keyType || 'ED25519').toLowerCase();
    $('fpCmd').textContent = 'ssh-keygen -lf /etc/ssh/ssh_host_' + (k === 'ecdsa' ? 'ecdsa' : k === 'rsa' ? 'rsa' : 'ed25519') + '_key.pub';
  }

  function paintReady() {
    if (!st) return;
    $('svWho').textContent = st.user + '@' + st.host + (st.port !== 22 ? ':' + st.port : '');
    $('svHow').textContent = !st.hasLogin ? 'Needs your password again' : st.auth === 'key' ? 'Secured with Shelf’s own key' : st.locked ? 'Using your password (encrypted on this PC)' : 'Using your password (this session only)';
    $('svDot').className = 'dot ' + (st.hasLogin ? 'dot-ok' : 'dot-warn');
    $('svMovies').textContent = st.movies || 'Choose a folder';
    $('svTv').textContent = st.tv || 'Choose a folder';
    $('svMovies').classList.toggle('need', !st.movies);
    $('svTv').classList.toggle('need', !st.tv);
    var libs = st.plex.libraries || [];
    $('svPlexText').textContent = '';
    if (st.plex.token) {
      $('svPlexText').appendChild(document.createTextNode('Connected'));
      $('svPlexText').appendChild(el('br'));
      $('svPlexText').appendChild(el('small', { class: 'muted', text: libs.length ? libs.map(function (l) { return l.title; }).join(', ') : 'No movie or TV libraries yet' }));
      $('svPlexFind').textContent = 'Disconnect';
    } else {
      $('svPlexText').appendChild(document.createTextNode('Not connected'));
      $('svPlexText').appendChild(el('br'));
      $('svPlexText').appendChild(el('small', { class: 'muted', text: 'Optional: lets Shelf find your folders and tell Plex about new files right away' }));
      $('svPlexFind').textContent = 'Connect';
    }
    $('optAutoSend').checked = st.options.autoSend;
    $('optVerify').checked = st.options.verify;
    $('optTidy').checked = st.options.tidy;
    $('optScan').checked = st.options.scan && st.plex.token;
    $('optScan').disabled = !st.plex.token;
    $('optScanHelp').textContent = st.plex.token ? 'Plex adds them right away instead of at its next scan' : 'Connect Plex above to use this. (Plex usually notices new files by itself too.)';
    if (!st.hasLogin) {
      $('svNote').textContent = 'Shelf needs your password again.';
      $('svNote').hidden = false;
    }
  }
  function browse(kind, where) {
    sv.browseKind = kind || sv.browseKind;
    step('browse');
    $('brList').textContent = '';
    busy(true, 'Opening…');
    $('svNext').disabled = true;
    native.serverList(where != null ? where : (st[sv.browseKind] || '')).then(function (r) {
      busy(false);
      sv.browsePath = r.path;
      $('brPath').value = r.path;
      $('brUp').disabled = !r.parent;
      $('brUp').onclick = function () { browse(null, r.parent); };
      $('brWritable').textContent = r.problem ? '' : r.writable ? '✓ You can save files here' : 'Your account can’t save files here';
      $('brWritable').className = r.writable ? 'ok-text' : 'warn-text';
      $('svNext').disabled = !r.writable;
      var libs = (st.plex.libraries || []).filter(function (l) { return l.kind === sv.browseKind; });
      var plexDirs = {};
      libs.forEach(function (l) { l.folders.forEach(function (f) { plexDirs[f] = l.title; }); });
      // Quick ways to the usual places (drives are usually under /mnt or /media).
      $('brPlaces').textContent = '';
      ['/'].concat(r.places || [], [r.home], Object.keys(plexDirs)).filter(function (d, k, a) { return d && a.indexOf(d) === k && d !== r.path; }).slice(0, 8).forEach(function (d) {
        $('brPlaces').appendChild(el('button', { type: 'button', class: 'pill small-pill', title: plexDirs[d] ? 'Your Plex “' + plexDirs[d] + '” folder' : d, onclick: function () { browse(null, d); },
          text: d === r.home ? '~ Home' : plexDirs[d] ? 'Plex: ' + plexDirs[d] : d }));
      });
      // Why a folder can't be opened or used, and how to fix it on the server.
      var user = r.user || st.user, help = '';
      if (r.problem === 'denied') help = 'Your account (' + user + ') isn’t allowed to open this folder. To let it, run this on the server:\n';
      else if (r.problem === 'missing') help = 'There’s no folder called ' + r.path + ' on the server.';
      else if (r.problem === 'file') help = r.path + ' is a file, not a folder.';
      else if (!r.writable) help = 'Your account (' + user + ') can open this folder but can’t save or rename files in it (Plex’s folders often belong to the “plex” account). To let it, run this on the server:\n';
      $('brHelp').textContent = help;
      if (r.problem === 'denied' || (!r.problem && !r.writable)) {
        $('brHelp').appendChild(el('code', { text: 'sudo setfacl -R -m u:' + user + ':rwX -m d:u:' + user + ':rwX ' + "'" + r.path.replace(/'/g, "'\\''") + "'" }));
        $('brHelp').appendChild(document.createTextNode('\n(Needs the “acl” package: sudo apt install acl. Plex keeps its own access. For a Windows-formatted drive (NTFS/exFAT), add uid=' + user + ' to its line in /etc/fstab instead.)'));
      }
      $('brHelp').hidden = !help;
      if (!r.dirs.length && !r.problem) $('brList').appendChild(el('div', { class: 'br-empty muted', text: 'No folders in here' }));
      r.dirs.forEach(function (d) {
        var full = (r.path === '/' ? '' : r.path) + '/' + d;
        $('brList').appendChild(el('button', { type: 'button', class: 'br-item', role: 'option', ondblclick: function () { browse(null, full); }, onclick: function () { browse(null, full); } }, [
          el('span', { class: 'br-folder', 'aria-hidden': 'true' }), el('span', { class: 'br-name', text: d }),
          plexDirs[full] ? el('span', { class: 'tag tag-ok', text: 'Plex: ' + plexDirs[full] }) : null,
          el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })
        ]));
      });
      // Shortcuts: the folders your Plex libraries use.
      Object.keys(plexDirs).forEach(function (f) {
        if (f === r.path) $('brWritable').textContent = (r.writable ? '✓ ' : '') + 'This is your Plex “' + plexDirs[f] + '” folder' + (r.writable ? '' : ', but your account can’t save files here');
      });
    }, function (e) { fail(e); $('svNext').disabled = true; });
  }

  // ---------- Before sending ----------
  var sd = { scope: 'renamed', replace: false, plan: null, paths: null, seq: 0 };
  function openSend(scope) {
    if (!st || !st.set) return openServer();
    if (!st.hasLogin) return openServer();
    sd.scope = scope || (unsent().length ? 'renamed' : 'all');
    sd.replace = false;
    var d = $('sendSheet');
    if (!d.open) d.showModal();
    plan();
  }
  function plan() {
    var seq = ++sd.seq;
    var paths = sd.scope === 'renamed' ? unsent() : null;
    sd.paths = paths;
    document.querySelectorAll('#sdScope button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.scope === sd.scope ? 'true' : 'false');
      if (b.dataset.scope === 'renamed') { b.disabled = !unsent().length; b.textContent = 'Just Renamed' + (unsent().length ? ' (' + unsent().length + ')' : ''); }
    });
    document.querySelectorAll('#sdReplace button').forEach(function (b) { b.setAttribute('aria-pressed', (b.dataset.replace === '1') === sd.replace ? 'true' : 'false'); });
    $('sdTitle').textContent = 'Send to ' + st.host + '?';
    $('sdSummary').textContent = 'Looking at what’s already on your server…';
    $('sdFacts').textContent = '';
    $('sdConflict').hidden = true; $('sdWarn').hidden = true;
    $('sdGo').disabled = true; $('sdGo').textContent = 'Send'; $('sdServer').textContent = 'Server Settings';
    native.sendPlan(paths).then(function (p) {
      if (seq !== sd.seq) return;
      sd.plan = p;
      var go = p.fresh + (sd.replace ? p.different.length : 0);
      var facts = $('sdFacts');
      function fact(k, v, cls) { facts.appendChild(el('div', { class: 'fact' + (cls ? ' ' + cls : '') }, [el('span', { text: k }), el('span', { text: v })])); }
      if (!p.files) {
        $('sdSummary').textContent = sd.scope === 'renamed' ? 'Nothing renamed to send yet.' : 'Your library folder has no movies or TV shows yet.';
        return;
      }
      $('sdSummary').textContent = go ? bytes(p.bytes) + ' to send. Each file arrives under a temporary name and only gets its real name once it’s all there' + (st.options.verify ? ' and checked.' : '.') : 'Everything here is already on your server.';
      fact('New files', String(p.fresh));
      if (p.partial) fact('Picking up where they stopped', String(p.partial));
      if (p.same) fact('Already on your server', p.same + ' (skipped)');
      if (p.free != null) fact('Free space on the server', bytes(p.free), p.room ? '' : 'warn');
      if (p.different.length) {
        $('sdConflict').hidden = false;
        $('sdConflictText').textContent = p.different.length + ' file' + (p.different.length === 1 ? ' has' : 's have') + ' the same name as a different file already on your server (for example “' + p.different[0] + '”).';
      }
      var warn = [];
      if (p.missing.length) warn.push('Choose a ' + p.missing.map(function (k) { return k === 'movies' ? 'Movies' : 'TV Shows'; }).join(' and a ') + ' folder on the server first (Server Settings). Those files are left out for now.');
      if (!p.room) warn.push('There isn’t enough free space on the server for all of this.');
      $('sdWarn').textContent = warn.join(' ');
      $('sdWarn').hidden = !warn.length;
      $('sdGo').disabled = !go || !p.room;
      $('sdGo').textContent = go ? 'Send ' + go + ' File' + (go === 1 ? '' : 's') : 'Send';
    }, function (e) {
      if (seq !== sd.seq) return;
      var w = why(e);
      if (w.code === 'HOST_CHANGED') { sv.recheck = true; $('sdServer').textContent = 'Check the Server…'; }
      $('sdSummary').textContent = '';
      $('sdWarn').textContent = w.text; $('sdWarn').hidden = false;
    });
  }
  function startSend(paths, replace, quiet) {
    if (paths) paths.forEach(function (p) { pathState[p] = 'queued'; });
    syncItems(); rerender();
    return native.send(paths, { replace: !!replace }).then(function (r) {
      if (!r.queued && !quiet) toast('Nothing to send.');
      if (!r.queued && paths) { paths.forEach(function (p) { if (pathState[p] === 'queued') delete pathState[p]; }); syncItems(); rerender(); }
      return r;
    }, function (e) {
      if (paths) paths.forEach(function (p) { if (pathState[p] === 'queued') delete pathState[p]; });
      syncItems(); rerender();
      var w = why(e);
      toast('Couldn’t send: ' + w.text);
    });
  }

  // ---------- The tray: what's being sent right now ----------
  var hideTimer = null, last = null;
  native.onSend(function (m) {
    last = m;
    if (m.code === 'HOST_CHANGED') sv.recheck = true;
    if (st) st.sending = m;
    if (m.kind === 'file' && m.result) {
      var r = m.result;
      pathState[r.local] = r.ok ? (r.skipped ? 'sent' : 'sent') : r.skipped ? 'skipped' : 'failed';
      syncItems(); rerender();
    }
    if (m.local && m.running && pathState[m.local] !== 'sent') { pathState[m.local] = 'sending'; syncItems(); }
    tray(m);
    paint();
  });
  function tray(m) {
    var t = $('sendTray');
    clearTimeout(hideTimer);
    t.hidden = false;
    var pct = m.bytesTotal ? Math.min(100, 100 * m.bytesDone / m.bytesTotal) : 0;
    $('sendFill').style.width = (m.running ? pct : 100) + '%';
    t.classList.toggle('is-done', !m.running);
    t.classList.toggle('has-problem', !m.running && (m.failed > 0 || !!m.message));
    $('sendStop').hidden = !m.running;
    $('sendClose').hidden = m.running;
    if (m.running) {
      var title = { connect: 'Connecting to ' + (st ? st.host : 'your server') + '…', check: 'Double-checking…', scan: 'Telling Plex about the new files…', retry: 'Reconnecting…' }[m.phase] || 'Sending to Plex';
      $('sendTitle').textContent = title;
      $('sendFile').textContent = m.phase === 'scan' ? '' : m.file;
      $('sendDetail').textContent = m.message || (Math.min(m.done + 1, m.total) + ' of ' + m.total + ' · ' + bytes(m.bytesDone) + ' of ' + bytes(m.bytesTotal));
      $('sendRate').textContent = m.rate > 0 && m.phase === 'send' ? Math.round(m.rate / 1e6) + ' MB/s · ' + eta((m.bytesTotal - m.bytesDone) / m.rate) : '';
      return;
    }
    // Finished.
    var parts = [];
    if (m.sent) parts.push(m.sent + ' sent');
    if (m.skipped) parts.push(m.skipped + ' already there or skipped');
    if (m.failed) parts.push(m.failed + ' not sent');
    $('sendTitle').textContent = m.stopped && !m.message ? 'Stopped' : m.message ? 'Couldn’t send' : m.sent ? 'Sent to Plex' : 'Nothing new to send';
    $('sendFile').textContent = '';
    $('sendDetail').textContent = m.message || parts.join(' · ') + (m.scanned ? ' · Plex is adding them now' : '');
    $('sendRate').textContent = m.stopped && !m.message ? 'Click Send to Plex to pick up where it stopped' : '';
    $('sendClose').textContent = m.message ? 'Fix It…' : 'Close';
    if (!m.failed && !m.message && !m.stopped) hideTimer = setTimeout(function () { t.hidden = true; }, 9000);
  }

  // ---------- Wiring ----------
  function on(id, ev, fn) { var n = $(id); if (n) n.addEventListener(ev, fn); }
  on('serverStatus', 'click', function () { openServer(); });
  on('sendBtn', 'click', function () { openSend(); });
  on('svNext', 'click', go);
  on('svBack', 'click', backStep);
  on('svHost', 'input', syncFind);
  on('svHost', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!$('svNext').disabled) go(); } });
  on('svPort', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  on('svPass', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  on('svUser', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  on('svFzPassType', 'click', function () { $('svFzPass').hidden = true; $('svPassRow').hidden = false; $('svPass').focus(); });
  on('fpCopy', 'click', function () { try { navigator.clipboard.writeText($('fpCmd').textContent); toast('Copied.'); } catch (e) { /* no clipboard */ } });
  on('svFpShow', 'click', function () { $('svNote').textContent = (st.keyType || 'Server') + ' fingerprint: ' + st.fingerprint; $('svNote').hidden = false; });
  document.querySelectorAll('[data-pick]').forEach(function (b) { b.addEventListener('click', function () { browse(b.dataset.pick, null); }); });
  function goTyped() { var v = $('brPath').value.trim(); if (v) browse(null, v.charAt(0) === '/' ? v : (sv.browsePath.replace(/\/$/, '') + '/' + v)); }
  on('brGo', 'click', goTyped);
  on('brPath', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); goTyped(); } });
  on('brNew', 'click', function () { $('brNewRow').hidden = !$('brNewRow').hidden; if (!$('brNewRow').hidden) $('brNewName').focus(); });
  function makeFolder() {
    var name = $('brNewName').value.trim();
    if (!name) return;
    busy(true, 'Making the folder…');
    native.serverMkdir(sv.browsePath, name).then(function (full) { $('brNewName').value = ''; $('brNewRow').hidden = true; browse(null, full); }, fail);
  }
  on('brNewMake', 'click', makeFolder);
  on('brNewName', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); makeFolder(); } });
  on('svPlexFind', 'click', function () {
    if (st.plex.token) { native.serverForgetPlex().then(function (r) { st = r; paintReady(); }); return; }
    busy(true, 'Looking for Plex on the server…');
    native.serverPlex('').then(function (r) { st = r; busy(false); $('svTokenRow').hidden = true; paintReady(); }, function (e) {
      var w = fail(e);
      if (w.code === 'NO_PLEX') { $('svTokenRow').hidden = false; $('svError').hidden = true; $('svToken').focus(); }
    });
  });
  on('svTokenSave', 'click', function () {
    busy(true, 'Connecting to Plex…');
    native.serverPlex($('svToken').value).then(function (r) { st = r; busy(false); $('svToken').value = ''; $('svTokenRow').hidden = true; paintReady(); }, fail);
  });
  ['AutoSend', 'Verify', 'Scan', 'Tidy'].forEach(function (k) {
    on('opt' + k, 'change', function (e) {
      var o = {}; o[k.charAt(0).toLowerCase() + k.slice(1)] = e.target.checked;
      native.serverOptions(o).then(function (r) { st = r; paint(); });
    });
  });
  on('renameSend', 'change', function (e) { native.serverOptions({ autoSend: e.target.checked }).then(function (r) { st = r; }); });
  on('svSendAll', 'click', function () { $('serverSheet').close(); openSend('all'); });
  on('svForget', 'click', function () { step('forget'); });
  $('serverSheet').addEventListener('close', function () { $('svPass').value = ''; $('svToken').value = ''; });
  $('serverSheet').addEventListener('cancel', function (e) { if ($('svBusy').hidden === false) e.preventDefault(); });

  document.querySelectorAll('#sdScope button').forEach(function (b) { b.addEventListener('click', function () { if (!b.disabled) { sd.scope = b.dataset.scope; plan(); } }); });
  document.querySelectorAll('#sdReplace button').forEach(function (b) { b.addEventListener('click', function () { sd.replace = b.dataset.replace === '1'; plan(); }); });
  on('sdServer', 'click', function () { $('sendSheet').close(); openServer('ready'); });
  on('sdGo', 'click', function () {
    var paths = sd.paths, replace = sd.replace;
    $('sendSheet').close();
    startSend(paths, replace);
  });
  on('sendStop', 'click', function () { native.sendStop(); $('sendTitle').textContent = 'Stopping…'; });
  on('sendClose', 'click', function () {
    $('sendTray').hidden = true;
    if (last && last.message) openServer();
  });

  // ---------- Fix My Plex Library: files already on your server ----------
  var fixing = false;
  function checkLibrary() {
    if (fixing || !shelf()) return;
    if (!st || !st.set || !st.hasLogin) { openServer(); return; }
    fixing = true;
    var all = $('svFixAll') && $('svFixAll').checked;
    if ($('serverSheet').open) $('serverSheet').close();
    $('fixLibBtn').disabled = true;
    // Always say what's happening, with numbers that move, and a Stop (it keeps what it found so far).
    var n = function (x) { return Number(x).toLocaleString(); };
    var job = shelf().busy ? shelf().busy('Connecting to ' + st.host + '…', false, function () { native.plexLibraryStop(); job.set('Stopping…'); }) : null;
    var unlisten = native.onFixProgress ? native.onFixProgress(function (p) {
      if (!job) return;
      var lib = p.of > 1 ? ' (' + p.lib + ', ' + (p.index + 1) + ' of ' + p.of + ')' : '';
      if (p.stage === 'plex') job.set('Asking Plex what it matched' + lib + ': ' + n(p.done) + (p.total ? ' of ' + n(p.total) : '') + '…');
      else if (p.stage === 'walk') job.set('Looking through your folders' + lib + ': ' + n(p.folders) + ' folders, ' + n(p.files) + ' files…');
      else if (p.stage === 'done') job.set('Adding ' + n(p.picked) + ' files to the list…');
    }) : null;
    var finish = function () { if (unlisten) unlisten(); if (job) job.done(); };
    native.plexLibraryScan(all ? 'all' : 'problems').then(function (r) {
      finish();
      var s = r.stats, bits = [];
      if (s.plex) {
        if (s.unmatched) bits.push(s.unmatched + ' Plex couldn’t match');
        if (s.missing) bits.push(s.missing + ' Plex hasn’t added');
      }
      var oddly = r.files.filter(function (f) { return !f.named; }).length;
      if (oddly) bits.push(oddly + ' not named the Plex way');
      if (!r.files.length) { toast(r.stopped ? 'Stopped. Nothing to fix in the ' + n(r.total) + ' files checked so far.' : 'Checked ' + n(r.total) + ' files on your server. Everything looks right' + (s.plex ? '' : ' (connect Plex to also see what it couldn’t match)') + '.'); return; }
      var said = (r.stopped ? 'Stopped after ' : 'Checked ') + n(r.total) + ' files on your server: ' + (bits.join(', ') || r.files.length + ' to look at') + (s.truncated ? ' (stopped at 50,000 files)' : '') + '.';
      var add = function (files) {
        shelf().addFiles(files.map(function (f) { return { name: f.name, relPath: f.relPath, size: f.size, remote: f.remote, plex: f.plex }; }));
        toast(said + ' Check the list, then Rename fixes them on the server.');
      };
      // Found files in more than one show: you pick which to fix now.
      var groups = fixGroups(r.files);
      if (groups.length < 2) add(r.files);
      else return pickFixes(groups, said).then(function (files) { if (files && files.length) add(files); });
    }, function (e) {
      finish();
      var w = why(e);
      toast(w.text || 'Couldn’t look through your Plex library.');
      if (/^(NO_LOGIN|NO_SERVER|HOST_|AUTH)/.test(w.code)) openServer();
    }).then(function () { fixing = false; $('fixLibBtn').disabled = false; });
  }
  // The files found, by show (the show's folder on the server), and one group for movies.
  function fixGroups(files) {
    var map = {}, order = [];
    files.forEach(function (f) {
      var segs = String(f.relPath || '').split('/'), movie = segs[0] === 'Movies';
      var key = movie ? 'movies' : segs.length > 2 ? 'tv:' + segs[1] : 'tv:';
      if (!map[key]) {
        var name = movie ? 'Movies' : segs.length > 2 ? segs[1].replace(/\s*[{\[](?:tmdb|tvdb|imdb)-[^}\]]*[}\]]/gi, '').trim() || segs[1] : 'TV files not in a show’s folder';
        map[key] = { key: key, name: name, movie: movie, files: [], unmatched: 0, missing: 0, odd: 0 };
        order.push(key);
      }
      var g = map[key];
      g.files.push(f);
      if (f.plex === 'unmatched') g.unmatched++;
      else if (f.plex === 'missing') g.missing++;
      else if (f.plex && !f.named) g.odd++;
    });
    return order.map(function (k) { return map[k]; }).sort(function (a, b) { return (a.movie - b.movie) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); });
  }
  // Which of them to fix (all ticked to start with). Resolves with the files picked, or null.
  function pickFixes(groups, said) {
    var d = $('fixPickSheet'), list = $('fpList'), find = $('fpFind');
    var picked = {};
    groups.forEach(function (g) { picked[g.key] = true; });
    var plural = function (k, one, many) { return Number(k).toLocaleString() + ' ' + (k === 1 ? one : many); };
    var count = function () { return groups.reduce(function (t, g) { return t + (picked[g.key] ? g.files.length : 0); }, 0); };
    var sync = function () {
      var c = count();
      $('fpGo').disabled = !c;
      $('fpGo').textContent = c ? 'Add ' + plural(c, 'File', 'Files') : 'Add to the List';
    };
    var shows = groups.filter(function (g) { return !g.movie; }).length;
    $('fpLead').textContent = said + ' They’re in ' + plural(shows, 'show', 'shows') + (groups.some(function (g) { return g.movie; }) ? ' and your movies' : '') + '. Pick the ones to fix now; the rest stay as they are.';
    var rows = groups.map(function (g) {
      var why = [g.unmatched ? g.unmatched + ' Plex couldn’t match' : '', g.missing ? g.missing + ' Plex hasn’t added' : '', g.odd ? g.odd + ' not named the Plex way' : ''].filter(Boolean).join(' · ');
      var box = el('input', { type: 'checkbox', class: 'switch', 'aria-label': 'Fix ' + g.name });
      box.checked = true;
      box.addEventListener('change', function () { picked[g.key] = box.checked; sync(); });
      return el('label', { class: 'row fp-row', 'data-name': g.name.toLowerCase() }, [
        el('span', { class: 'fp-text' }, [el('b', { text: g.name }), el('small', { class: 'muted', text: plural(g.files.length, 'file', 'files') + (why ? ' · ' + why : '') })]),
        box
      ]);
    });
    list.replaceChildren.apply(list, rows);
    var setAll = function (on) {
      rows.forEach(function (row, i) { if (row.hidden) return; picked[groups[i].key] = on; row.querySelector('input').checked = on; });
      sync();
    };
    $('fpAll').onclick = function () { setAll(true); };
    $('fpNone').onclick = function () { setAll(false); };
    $('fpFindBox').hidden = groups.length < 9;
    find.value = '';
    find.oninput = function () { var q = find.value.trim().toLowerCase(); rows.forEach(function (row) { row.hidden = !!q && row.dataset.name.indexOf(q) < 0; }); };
    sync();
    return new Promise(function (resolve) {
      var done = false;
      $('fpGo').onclick = function () { done = true; d.close(); resolve(groups.filter(function (g) { return picked[g.key]; }).reduce(function (a, g) { return a.concat(g.files); }, [])); };
      d.addEventListener('close', function once() { d.removeEventListener('close', once); if (!done) resolve(null); });
      d.showModal();
    });
  }
  // ---------- Duplicate episodes on your server ----------
  // Every TV file is listed (as Fix My Plex Library does with "Include files that already look right"), the ones
  // sharing an episode are grouped, and you choose which copy of each stays. The rest are set aside, not deleted.
  var P = window.ShelfParser;
  function findDupes() {
    if (fixing || !shelf()) return;
    if (!st || !st.set || !st.hasLogin) { openServer(); return; }
    fixing = true;
    var n = function (x) { return Number(x).toLocaleString(); };
    var job = shelf().busy('Connecting to ' + st.host + '…', false, function () { native.plexLibraryStop(); job.set('Stopping…'); });
    var unlisten = native.onFixProgress ? native.onFixProgress(function (p) {
      if (p.stage === 'walk') job.set('Looking for duplicate episodes: ' + n(p.folders) + ' folders, ' + n(p.files) + ' files…');
      else if (p.stage === 'plex') job.set('Asking Plex what it has: ' + n(p.done) + (p.total ? ' of ' + n(p.total) : '') + '…');
    }) : null;
    native.plexLibraryScan('all').then(function (r) {
      if (unlisten) unlisten(); job.done();
      var groups = P.findDuplicates(r.files);
      if (!groups.length) { toast((r.stopped ? 'Stopped. ' : '') + 'No episode is in more than one file (' + n(r.total) + ' files checked).'); return; }
      return pickDupes(groups, r.files);
    }, function (e) {
      if (unlisten) unlisten(); job.done();
      toast(why(e).text || 'Couldn’t look through your Plex library.');
    }).then(function () { fixing = false; });
  }
  function epRange(season, eps) { var c = function (x) { return (x < 10 ? '0' : '') + x; }; return 'S' + c(season) + 'E' + c(eps[0]) + (eps.length > 1 ? '–E' + c(eps[eps.length - 1]) : ''); }
  function mb(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB'; }
  function pickDupes(groups, all) {
    var d = $('dupesSheet'), list = $('dpList'), keep = {};
    var pref = groups.reduce(function (t, g) { return t + g.files.filter(function (f) { return f.eps.length > 1; }).length; }, 0) * 2 >= groups.length ? 'together' : 'separate';
    var setPref = function (p) {
      pref = p;
      document.querySelectorAll('#dpPref button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.pref === p ? 'true' : 'false'); });
      keep = {};
      groups.forEach(function (g) { P.keepFor(g, p).forEach(function (r) { keep[r] = true; }); });
      paint();
    };
    var shows = {}; groups.forEach(function (g) { shows[g.show] = 1; });
    var nEps = groups.reduce(function (t, g) { return t + g.eps.length; }, 0);
    $('dpLead').textContent = nEps + ' episode' + (nEps === 1 ? ' is' : 's are') + ' in more than one file on your server, in ' + Object.keys(shows).length + (Object.keys(shows).length === 1 ? ' show' : ' shows') + '. Plex then shows them twice, or mixes them up. Choose which copy of each to keep.';
    var paint = function () {
      var lost = 0, aside = 0;
      list.replaceChildren.apply(list, groups.map(function (g) {
        var have = {};
        g.files.forEach(function (f) { if (keep[f.remote]) f.eps.forEach(function (x) { have[x] = 1; }); });
        var missing = g.eps.filter(function (x) { return !have[x]; });
        if (missing.length) lost++;
        aside += g.files.filter(function (f) { return !keep[f.remote]; }).length;
        return el('div', { class: 'dp-group' + (missing.length ? ' lost' : '') }, [
          el('div', { class: 'dp-head' }, [el('b', { text: g.show }), el('span', { text: epRange(g.season, g.eps) })]),
          el('div', { class: 'group' }, g.files.map(function (f) {
            var box = el('input', { type: 'checkbox', class: 'switch', 'aria-label': 'Keep ' + f.name });
            box.checked = !!keep[f.remote];
            box.addEventListener('change', function () { keep[f.remote] = box.checked; paint(); });
            return el('label', { class: 'row dp-file' + (keep[f.remote] ? '' : ' aside') }, [
              el('span', { class: 'dp-text' }, [el('span', { class: 'dp-name', text: f.name, title: f.remote }),
                el('small', { class: 'muted', text: epRange(g.season, f.eps) + (f.eps.length > 1 ? ' (' + f.eps.length + ' episodes)' : '') + ' · ' + mb(f.size) + ' · ' + (keep[f.remote] ? 'Keep' : 'Set aside') })]),
              box
            ]);
          })),
          missing.length ? el('p', { class: 'dp-warn', text: 'Keep at least one copy of ' + missing.map(function (x) { return epRange(g.season, [x]); }).join(', ') + '.' }) : null
        ]);
      }));
      $('dpGo').disabled = !!lost || !aside;
      $('dpGo').textContent = lost ? 'Keep One Copy of Each First' : aside ? 'Set Aside ' + aside + (aside === 1 ? ' File' : ' Files') : 'Nothing to Set Aside';
    };
    document.querySelectorAll('#dpPref button').forEach(function (b) { b.onclick = function () { if (b.dataset.pref !== pref) setPref(b.dataset.pref); }; });
    setPref(pref);
    return new Promise(function (resolve) {
      $('dpGo').onclick = function () {
        var videos = [];
        groups.forEach(function (g) { g.files.forEach(function (f) { if (!keep[f.remote]) videos.push(f.remote); }); });
        // Their subtitles go with them ("Show - S01E01.en.srt" beside "Show - S01E01.mkv").
        var subs = all.filter(function (f) {
          return /\.(srt|ass|ssa|sub|idx|vtt|sup)$/i.test(f.name) && videos.some(function (v) { var stem = v.replace(/\.[^./]+$/, ''); return f.remote.indexOf(stem + '.') === 0 && f.remote.lastIndexOf('/') === v.lastIndexOf('/'); });
        }).map(function (f) { return f.remote; });
        d.close();
        var job = shelf().busy('Setting aside ' + videos.length + ' files on your server…');
        native.plexSetAside(videos.concat(subs)).then(function (res) {
          job.done();
          var ok = res.results.filter(function (x) { return x.ok; }), bad = res.results.filter(function (x) { return x.error; });
          if (ok.length && shelf().serverChanged) shelf().serverChanged(ok.map(function (x) { return x.remote; }));
          toast('Set aside ' + ok.length + ' file' + (ok.length === 1 ? '' : 's') + ' on your server' + (bad.length ? ', ' + bad.length + ' couldn’t be (' + bad[0].error + ')' : '') + '.' + (res.rescanned ? ' Plex is rescanning.' : '') + ' Undo puts them back.');
        }, function (e) { job.done(); toast(why(e).text || 'Couldn’t set them aside.'); }).then(resolve);
      };
      d.addEventListener('close', function once() { d.removeEventListener('close', once); resolve(); });
      d.showModal();
    });
  }
  on('dupesBtn', 'click', findDupes);
  on('svFixLib', 'click', checkLibrary);
  on('fixLibBtn', 'click', checkLibrary);

  // ---------- For the rest of Shelf ----------
  window.ShelfSend = {
    ready: function () { return !!(st && st.set && st.hasLogin && (st.movies || st.tv)); },
    autoSend: function () { return !!(st && st.options && st.options.autoSend); },
    // After Rename Now: send these new files (files already on the server with another size are left alone).
    afterRename: function (paths) { if (paths && paths.length) startSend(paths, false, true); },
    open: openServer,
    send: openSend,
    paint: paint,
    refresh: refresh,
    forgetPaths: function (paths) { (paths || []).forEach(function (p) { delete pathState[p]; }); },
    _state: function () { return { st: st, pathState: pathState, last: last }; }
  };
  refresh();
})();
