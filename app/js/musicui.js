/*
 * Shelf — music in the main window: reading each song's tags, grouping songs into albums, looking each album
 * up on MusicBrainz, and everything the list and the details panel show about them.
 * The matching itself is in music.js (pure, tested); this file is the glue to the window.
 */
(function (root) {
  'use strict';

  var M = root.ShelfMusic, P = root.ShelfParser;

  /**
   * ctx: { native, el, $, items() , itemById(id), settings, scheduleRender(), render(), toast(msg), select(id) }
   */
  function create(ctx) {
    var native = ctx.native, el = ctx.el, $ = ctx.$;
    var albums = {};          // key → album (see newAlbum)
    var covers = {};          // release id → Promise<blob url | null> (the small picture for the list)
    var queue = [], running = 0, PARALLEL = 3;

    function isTrack(i) { return i.kind === 'track'; }
    // Could its tags be read? (A damaged file can't be looked up, so Try Again won't help it.)
    function readable(i) { var s = audioOf(i) || i; return !(s.music && s.music.tags && !s.music.tags.ok); }
    function audioOf(i) { return i.parsed.isLyrics && i.linkTo ? ctx.itemById(i.linkTo) : i; }
    function albumOf(i) { var a = audioOf(i); return a && a.music && albums[a.music.album] || null; }

    // ---------- Adding songs: tags first, then albums, then lookups ----------
    function add(list) {
      var songs = list.filter(function (i) { return i.parsed.isAudio && i.status === 'pending'; });
      linkLyrics();
      if (!songs.length) return;
      songs.forEach(function (i) { i.status = 'matching'; i.music = { album: null }; });
      ctx.scheduleRender();
      // Tags are read 200 at a time (on Shelf's background threads), so the first albums appear quickly.
      var chunks = [];
      for (var k = 0; k < songs.length; k += 200) chunks.push(songs.slice(k, k + 200));
      return chunks.reduce(function (p, chunk) {
        return p.then(function () {
          return native.musicTags(chunk.map(function (i) { return i.fullPath; })).then(function (res) {
            chunk.forEach(function (i, n) {
              var t = res[n] || { ok: false, error: 'Couldn’t read this file.' };
              i.music.tags = t; i.music.duration = t.ok ? t.duration : 0;
              if (!t.ok) { i.status = 'error'; i.error = t.error; }
            });
            group(chunk.filter(function (i) { return i.music.tags.ok; }));
          });
        });
      }, Promise.resolve()).catch(function (e) {
        songs.forEach(function (i) { if (i.status === 'matching' && !i.music.album) { i.status = 'error'; i.error = 'Couldn’t read this file’s tags (' + (e.message || e) + ').'; } });
        ctx.scheduleRender();
      });
    }
    function fileOf(i) {
      var folders = i.relPath.split('/').slice(0, -1);
      return { id: i.id, name: i.name, folders: folders, tags: i.music.tags, duration: i.music.duration };
    }
    function group(songs) {
      if (!songs.length) return;
      M.groupAlbums(songs.map(fileOf)).forEach(function (g) {
        var a = albums[g.key];
        if (a) { // more songs of an album already on the list: it's looked at again, with all of them
          g.ids.forEach(function (id) { if (a.ids.indexOf(id) < 0) a.ids.push(id); });
          Object.keys(g.votes).forEach(function (r) { a.guess.votes[r] = (a.guess.votes[r] || 0) + g.votes[r]; });
        } else a = albums[g.key] = newAlbum(g);
        a.ids.forEach(function (id) { var i = ctx.itemById(id); if (i) i.music.album = a.key; });
        if (queue.indexOf(a) < 0) queue.push(a);
      });
      ctx.scheduleRender();
      pump();
    }
    function newAlbum(g) {
      return { key: g.key, ids: g.ids.slice(), single: !!g.single, status: 'looking', release: null, ranked: [], sure: false, error: '', how: '', coverUrl: null, picked: false,
        guess: { album: g.album, artist: g.artist, year: g.year, votes: Object.assign({}, g.votes) } };
    }
    function pump() {
      while (running < PARALLEL && queue.length) {
        var a = queue.shift();
        running++;
        look(a).catch(function (e) { a.status = 'error'; a.error = (e && e.message) || 'Lookup failed'; })
          .then(function (aa) { return function () { running--; settle(aa); pump(); }; }(a));
      }
    }
    function songsOf(a) { return a.ids.map(ctx.itemById).filter(function (i) { return i && i.status !== 'done' && i.music && i.music.tags && i.music.tags.ok; }); }
    // What the files say about the album, for comparing with an edition you picked.
    function guessOf(a, files) {
      var tg = files.map(function (f) { return f.tags; });
      return Object.assign({}, a.guess, {
        count: files.length, maxTrack: Math.max.apply(null, [0].concat(tg.map(function (t) { return t.track || 0; }))),
        trackTotal: (tg.filter(function (t) { return t.trackTotal; })[0] || {}).trackTotal || 0
      });
    }

    // ---------- Looking an album up (the plan itself is M.lookAlbum, in music.js) ----------
    var api = { release: native.mbRelease, search: native.mbSearch, recordings: native.mbRecordings, groups: native.mbGroups, groupReleases: native.mbGroup,
      // By their sound (only with your AcoustID key): files → what each one sounds like.
      sound: function (files) {
        if (!ctx.settings.acoustKey) return Promise.resolve(null);
        return native.musicSound(files.map(function (f) { var i = ctx.itemById(f.id); return i ? i.fullPath : ''; }));
      } };
    function look(a) {
      a.status = 'looking'; a.error = '';
      return M.lookAlbum(api, a, songsOf(a).map(fileOf), prefs()).then(function (r) {
        if (r.none) nothing(a, r.none); else use(a, r, r.how);
      });
    }
    function nothing(a, why) {
      a.status = 'nomatch'; a.release = null; a.ranked = []; a.result = null;
      a.error = why + (ctx.settings.acoustKey ? '' : ' With a free AcoustID key (Settings → Music), Shelf can recognise it by its sound.');
    }
    function use(a, r, how) {
      a.ranked = r.ranked; a.release = r.best.release; a.result = r.best.result; a.sure = r.sure && how !== 'song'; a.how = how;
      a.status = a.sure ? 'matched' : 'review';
      a.mixed = Object.keys(a.guess.votes).length > 1;
      loadCover(a.release);
    }
    function prefs() { return { country: ctx.settings.musicCountry || '', format: ctx.settings.musicFormat || '' }; }

    // The album's answer goes to each of its songs (and their lyrics).
    function settle(a) {
      var songs = a.ids.map(ctx.itemById).filter(function (i) { return i && i.status !== 'done'; });
      var pairs = {};
      ((a.result && a.result.pairs) || []).forEach(function (p) { pairs[p.id] = p; });
      songs.forEach(function (i) {
        if (!i.music.tags || !i.music.tags.ok) return;
        var p = pairs[i.id];
        i.music.track = p ? p.track : null; i.music.cost = p ? p.cost : 1;
        i.confirmed = a.picked;
        if (a.status === 'error' || a.status === 'nomatch') { i.status = a.status; i.error = a.error; return; }
        if (!p) { i.status = 'review'; i.error = 'Isn’t on this edition of the album. Pick another edition, or take it off the list.'; return; }
        i.status = a.sure && p.cost < 0.25 ? 'matched' : 'review';
        i.error = '';
      });
      linkLyrics();
      ctx.scheduleRender();
    }
    // "01 Song.lrc" goes with "01 Song.mp3" (same folder, same name): renamed along with it.
    function linkLyrics() {
      var byStem = {};
      ctx.items().forEach(function (i) { if (i.parsed.isAudio) byStem[stem(i)] = i; });
      ctx.items().forEach(function (i) {
        if (!i.parsed.isLyrics || i.status === 'done') return;
        var s = byStem[stem(i)];
        i.kind = 'track';
        if (!s) { i.status = 'skipped'; i.error = 'Lyrics with no song of the same name next to them.'; return; }
        i.linkTo = s.id;
        i.status = s.status === 'pending' ? 'matching' : s.status; i.error = s.error; i.confirmed = s.confirmed;
      });
    }
    function stem(i) { return i.relPath.replace(/\.[^./]+$/, '').toLowerCase(); }

    // ---------- Choosing for yourself ----------
    function useRelease(a, rel) {
      if (!rel) return;
      var files = songsOf(a).map(fileOf);
      var r = M.rankReleases(guessOf(a, files), files, [rel], prefs());
      a.picked = true;
      use(a, r, 'manual');
      a.sure = true; a.status = 'matched';
      settle(a);
    }
    function pickEdition(a, id) {
      ctx.toast('Loading that edition…');
      return native.mbRelease(id).then(function (rel) { useRelease(a, rel); }, function (e) { ctx.toast(e.message || 'Couldn’t load that edition.'); });
    }
    function confirm(a) {
      a.picked = true;
      a.ids.map(ctx.itemById).forEach(function (i) { if (i && i.status === 'review' && i.music.track) i.confirmed = true; });
      linkLyrics();
      ctx.render();
    }
    function relook(a, query) {
      if (query) { a.guess.album = query.album || a.guess.album; a.guess.artist = query.artist != null ? query.artist : a.guess.artist; a.guess.votes = {}; a.single = false; }
      a.picked = false;
      a.ids.map(ctx.itemById).forEach(function (i) { if (i && i.status !== 'done' && i.music.tags && i.music.tags.ok) { i.status = 'matching'; i.error = ''; } });
      queue.push(a); ctx.scheduleRender(); pump();
    }

    // ---------- Covers (the list's small picture) ----------
    function loadCover(rel) {
      if (!rel || covers[rel.id]) return covers[rel && rel.id];
      covers[rel.id] = native.mbCover(rel.id, rel.group && rel.group.id, 250).then(function (c) {
        if (!c) return null;
        var bytes = Uint8Array.from(atob(c.data), function (ch) { return ch.charCodeAt(0); });
        return URL.createObjectURL(new Blob([bytes], { type: c.mime }));
      }).catch(function () { return null; });
      covers[rel.id].then(function (u) { if (u) ctx.scheduleRender(); });
      return covers[rel.id];
    }
    function coverNode(a, cls) {
      var box = el('div', { class: cls + ' album-cover', 'aria-hidden': 'true' });
      var title = a && a.release ? a.release.title : a ? a.guess.album : '';
      box.style.background = tint(title);
      box.textContent = initials(title);
      if (a && a.release && covers[a.release.id]) covers[a.release.id].then(function (u) { if (u) { box.textContent = ''; box.style.background = ''; box.appendChild(el('img', { src: u, alt: '' })); } });
      return box;
    }
    var TINTS = ['#F2D16B', '#F4B183', '#B5D99C', '#9CC9E5', '#D8B4E2', '#F2A7A7', '#A8DCD1'];
    function tint(s) { var h = 0; for (var i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return TINTS[Math.abs(h) % TINTS.length]; }
    function initials(s) { return String(s || '♪').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return Array.from(w)[0]; }).join('').toUpperCase() || '♪'; }

    // ---------- What the list shows ----------
    function shelfKey(i) {
      var a = albumOf(i), s = audioOf(i) || i;
      return 'album:' + (a ? a.key : s.music && s.music.tags && !s.music.tags.ok ? '?unreadable' : '?reading');
    }
    function sortKey(i) {
      var s = audioOf(i) || i, t = s.music && s.music.track, tg = s.music && s.music.tags && s.music.tags.ok ? s.music.tags : {};
      var pad = function (x) { return ('00000000' + x).slice(-8); };
      return [t ? t.disc : tg.disc || 1, t ? t.position : tg.track || 999, s.name.replace(/\d+/g, pad), i.parsed.isLyrics ? 1 : 0];
    }
    function code(t) { return (t.discTotal > 1 ? t.disc + '-' : '') + (t.position < 10 ? '0' : '') + t.position; }
    function rowParts(i) {
      var s = audioOf(i) || i, t = s.music && s.music.track, tg = s.music && s.music.tags && s.music.tags.ok ? s.music.tags : null;
      if (i.parsed.isLyrics) return { code: '↳ Lyrics', name: t ? t.title : (tg && tg.title) || s.name, sub: true };
      if (t) return { code: code(t), name: t.title + (t.artist && a1(s) && M.norm(t.artist) !== M.norm(a1(s).release.artist) ? ' · ' + t.artist : '') };
      return { code: tg && tg.track ? String(tg.track) : '♪', name: (tg && tg.title) || i.name, quiet: true };
    }
    function a1(i) { var a = albumOf(i); return a && a.release ? a : null; }
    function reasonFor(i) {
      var s = audioOf(i) || i, a = albumOf(s);
      if (i.status === 'error' || i.status === 'nomatch') return i.error || 'Couldn’t find it.';
      if (!a || i.status !== 'review' || i.confirmed) return '';
      if (!s.music.track) return 'Isn’t on this edition of the album.';
      if (a.how === 'song') return 'Found by its title. Is this the right album?';
      return a.mixed ? 'Its songs were tagged as different editions. Check which.' : 'Shelf isn’t sure which edition this is.';
    }
    function known(i) {
      var s = audioOf(i) || i, a = albumOf(s);
      if (!a || !s.music || !s.music.track) return '';
      if (a.how === 'manual') return 'You chose';
      if (s.music.tags.mb.recording && s.music.tags.mb.recording === s.music.track.recording) return 'MusicBrainz id';
      return a.how === 'song' ? 'Song title' : a.how === 'sound' ? 'Sound' : 'Tags';
    }
    function hay(i) {
      var s = audioOf(i) || i, a = albumOf(s), t = s.music && s.music.track, tg = s.music && s.music.tags && s.music.tags.ok ? s.music.tags : {};
      return [t && t.title, t && t.artist, a && a.release && a.release.title, a && a.release && a.release.artist, tg.title, tg.album, (tg.artists || []).join(' ')].filter(Boolean).join(' ');
    }
    function shelfTitle(key) {
      var a = albums[key.replace(/^album:/, '')];
      return a ? (a.release ? a.release.title : a.guess.album || 'Songs') : key === 'album:?unreadable' ? 'Couldn’t be read' : 'Reading your music…';
    }
    function shelfSub(key) { var a = albums[key.replace(/^album:/, '')]; return a ? (a.release ? a.release.artist : a.guess.artist || '') : ''; }
    function shelfCover(key, cls) { return coverNode(albums[key.replace(/^album:/, '')], cls); }
    /** The album heading's details line and its buttons. */
    function shelfHead(key, its) {
      var a = albums[key.replace(/^album:/, '')];
      var n = function (k) { return k + (k === 1 ? ' song' : ' songs'); };
      if (!a) return { bits: key === 'album:?unreadable' ? [n(its.length) + ' Shelf couldn’t open (damaged, or not really audio)'] : [n(its.length), 'reading tags…'], actions: [] };
      var songs = its.filter(function (i) { return i.parsed.isAudio; });
      var bits = [a.release ? a.release.artist : a.guess.artist];
      if (a.release) {
        var r = a.release, y = r.group && /^\d{4}/.test(r.group.firstDate || '') ? r.group.firstDate.slice(0, 4) : r.year;
        if (y) bits.push(y);
        bits.push(songs.length + (r.trackCount ? ' of ' + r.trackCount : '') + (r.trackCount === 1 ? ' song' : ' songs'));
        bits.push(edition(r));
      } else bits.push(n(songs.length));
      if (a.status === 'looking') bits.push('looking up…');
      var acts = [];
      if (a.release && a.release.group && a.release.group.id) acts.push({ label: 'Other Editions…', title: 'Every edition of this album (years, countries, CD or digital, bonus tracks): pick the one your files are', run: function () { openEditions(a); } });
      if (a.status === 'review' && a.release) acts.push({ label: 'Looks Right', primary: true, title: 'Use this edition for these songs', run: function () { confirm(a); } });
      acts.push({ label: 'Search…', title: 'Not this album? Search MusicBrainz by album and artist', run: function () { openSearch(a); } });
      return { bits: bits.filter(Boolean), actions: acts };
    }
    function edition(r) {
      var f = (r.formats || [])[0] || '';
      return [r.country === 'XW' ? 'worldwide' : r.country === 'XE' ? 'Europe' : r.country, f === 'Digital Media' ? 'digital' : f, r.disambiguation].filter(Boolean).join(' ');
    }

    // ---------- Making lossless songs smaller (in Rename Now; desktop/convert.js does it) ----------
    var LOSSLESS = ['flac', 'wav', 'aif', 'aiff', 'ape', 'wv', 'dsf'], SHRINK = { vorbis: { ext: 'ogg', kbps: 192 }, opus: { ext: 'opus', kbps: 160 } };
    function lossless(i) {
      var tg = i.music && i.music.tags && i.music.tags.ok ? i.music.tags : null, ext = String(i.parsed.ext).toLowerCase();
      return LOSSLESS.indexOf(ext) >= 0 || (ext === 'm4a' && !!tg && tg.bitrate > 500); // (ALAC hides in .m4a)
    }
    function shrinkTo(i) { return ctx.settings.musicShrink && i.parsed.isAudio && lossless(i) ? ctx.settings.musicShrinkFormat === 'opus' ? 'opus' : 'vorbis' : null; }
    /** Of these songs, the lossless ones: how many, their size now, and about how big they'd be. */
    function shrinkable(list) {
      var out = { count: 0, before: 0, after: 0 }, kb = SHRINK[ctx.settings.musicShrinkFormat === 'opus' ? 'opus' : 'vorbis'].kbps;
      list.forEach(function (i) { if (i.kind === 'track' && i.parsed.isAudio && lossless(i)) { out.count++; out.before += i.size || 0; out.after += Math.round((i.music.duration || 0) * kb * 125); } });
      return out;
    }

    // ---------- New names and tags ----------
    function plexName(i) {
      var s = audioOf(i) || i, a = albumOf(s), t = s.music && s.music.track;
      if (!a || !a.release || !t) return null;
      var to = shrinkTo(s);
      var n = M.plexName(a.release, t, to ? SHRINK[to].ext : s.parsed.ext, { year: ctx.settings.musicYear !== false, safeName: P.safeName });
      if (i.parsed.isLyrics) n = { folder: n.folder, file: n.file.replace(/\.[^.]+$/, '.' + i.parsed.ext) };
      return n;
    }
    /** What goes with a song in Rename Now: its new tags, and where its cover comes from. */
    function renameExtra(i) {
      if (!i.parsed.isAudio) return null;
      var a = albumOf(i), t = i.music && i.music.track;
      if (!a || !a.release || !t) return null;
      var c = ctx.settings.musicCover || 'both';
      return { tags: M.tagsFor(a.release, t, { genres: !!ctx.settings.musicGenres }), convert: shrinkTo(i) || undefined,
        cover: c === 'none' ? null : { release: a.release.id, group: (a.release.group && a.release.group.id) || '', embed: c !== 'folder', folder: c !== 'embed' } };
    }

    // ---------- Details panel ----------
    function inspector(i, box) {
      var s = audioOf(i) || i, a = albumOf(s), t = s.music && s.music.track, tg = s.music && s.music.tags;
      box.textContent = '';
      if (!a) { box.appendChild(el('p', { class: 'muted', text: s.status === 'error' ? s.error : 'Reading this song’s tags…' })); return; }
      // The edition, and ways to change it.
      var r = a.release;
      var card = el('section', { class: 'insp-card music-edition' }, [
        el('div', { class: 'insp-card-head' }, [el('span', { class: 'section-label', text: 'Album' }), el('span', { class: 'ep-badge ' + (a.status === 'matched' || a.picked ? 'ok' : a.status === 'review' ? 'maybe' : 'warn'), text: a.picked ? 'You chose' : a.status === 'matched' ? 'Sure' : a.status === 'review' ? 'Probably' : a.status === 'looking' ? 'Looking…' : 'Not found' })]),
        r ? el('div', { class: 'edition-row' }, [coverNode(a, 'edition-cover'), el('div', { class: 'edition-txt' }, [
          el('b', { text: r.title }), el('span', { text: r.artist }),
          el('span', { class: 'muted', text: [r.date, edition(r), r.trackCount + ' tracks', r.label + (r.catno ? ' ' + r.catno : '')].filter(Boolean).join(' · ') })
        ])]) : el('p', { class: 'muted', text: a.error || 'Looking it up on MusicBrainz…' }),
        el('p', { class: 'ep-why' + (a.status === 'matched' || a.picked ? ' is-sure' : ''), text: why(a) }),
        el('div', { class: 'insp-card-foot' }, [
          r && r.group.id ? el('button', { type: 'button', class: 'pill small-pill', text: 'Other Editions…', onclick: function () { openEditions(a); } }) : null,
          el('button', { type: 'button', class: 'pill small-pill', text: 'Search…', onclick: function () { openSearch(a); } }),
          el('span', { class: 'foot-flex' }),
          a.status === 'review' && r ? el('button', { type: 'button', class: 'pill small-pill pill-primary', text: 'Looks Right', onclick: function () { confirm(a); } }) : null
        ])
      ]);
      box.appendChild(card);
      // Before → after, so nothing changes by surprise.
      if (t && tg && tg.ok && i.parsed.isAudio) {
        var next = M.tagsFor(r, t, { genres: !!ctx.settings.musicGenres });
        var rows = M.tagDiff(tg, next);
        var changed = rows.filter(function (x) { return x.changed; }).length;
        var tbl = el('div', { class: 'tag-diff', role: 'table', 'aria-label': 'Tags now and after' }, [
          el('div', { class: 'td-row td-head', role: 'row' }, [el('span', { role: 'columnheader', text: '' }), el('span', { role: 'columnheader', text: 'Now' }), el('span', { role: 'columnheader', text: 'After' })])
        ].concat(rows.map(function (x) {
          return el('div', { class: 'td-row' + (x.changed ? ' is-changed' : ''), role: 'row' }, [
            el('span', { class: 'td-k', role: 'rowheader', text: x.label }),
            el('span', { class: 'td-before', role: 'cell', text: x.before || '—', title: x.before }),
            el('span', { class: 'td-after', role: 'cell', text: x.after || '—', title: x.after })
          ]);
        })));
        box.appendChild(el('section', { class: 'insp-section' }, [
          el('span', { class: 'section-label', text: changed ? 'Tags: ' + changed + (changed === 1 ? ' change' : ' changes') : 'Tags: already right' }), tbl,
          el('p', { class: 'row-help', text: tg.cover ? 'Has a cover picture' + (ctx.settings.musicCover === 'none' ? ' (left as it is).' : '; it gets the album’s cover from the Cover Art Archive.') : (ctx.settings.musicCover === 'none' ? 'No cover picture.' : 'No cover picture yet; it gets the album’s.') })
        ]));
      }
    }
    function why(a) {
      if (a.status === 'looking') return 'Looking it up on MusicBrainz…';
      if (a.picked) return '✓ You chose this edition.';
      if (a.status === 'nomatch' || a.status === 'error') return a.error;
      var miss = a.result ? a.result.missing.length : 0, extra = a.result ? a.result.extra.length : 0;
      var base = a.how === 'ids' ? '✓ Your files name this edition (MusicBrainz ids in their tags).' : a.how === 'song' ? 'Found by the song’s title and artist; it’s placed on its first official album.' : a.how === 'sound' ? 'Recognised by the songs’ sound (AcoustID).' : a.sure ? '✓ Every song fits a track on this edition (titles and lengths).' : 'The closest edition Shelf found by name.';
      return base + (miss ? ' ' + miss + ' of its tracks aren’t in your files (that’s fine).' : '') + (extra ? ' ' + extra + ' of your songs aren’t on it.' : '') + (a.mixed ? ' Your songs were tagged as more than one edition; they’ll all be set to this one.' : '');
    }

    // ---------- Other editions ----------
    function openEditions(a) {
      if (!a.release || !a.release.group.id) return;
      var sheet = $('editionSheet'), list = $('mxEditions');
      $('mxAlbum').textContent = a.release.title + ' · ' + a.release.artist;
      list.textContent = ''; list.appendChild(el('p', { class: 'muted', text: 'Loading every edition…' }));
      $('mxHelp').textContent = 'Your files: ' + a.ids.length + (a.ids.length === 1 ? ' song' : ' songs') + '. The track count, year, country and format tell editions apart.';
      if (!sheet.open) sheet.showModal();
      native.mbGroup(a.release.group.id).then(function (rels) {
        var files = songsOf(a).length;
        rels.sort(function (x, y) { return (x.date || '9999').localeCompare(y.date || '9999'); });
        list.textContent = '';
        rels.forEach(function (r) {
          var on = r.id === a.release.id, tagged = !!a.guess.votes[r.id];
          var fits = r.trackCount >= files;
          list.appendChild(el('button', { type: 'button', class: 'mx-option' + (on ? ' is-on' : ''), role: 'radio', 'aria-checked': on ? 'true' : 'false',
            onclick: function () { sheet.close(); if (!on) pickEdition(a, r.id); } }, [
            el('span', { class: 'radio', 'aria-hidden': 'true' }),
            el('span', { class: 'mx-date', text: r.date || '—' }),
            el('span', { class: 'mx-main' }, [el('b', { text: [edition(r) || 'Edition', r.status && r.status !== 'Official' ? r.status.toLowerCase() : ''].filter(Boolean).join(' · ') }),
              el('span', { text: [r.label + (r.catno ? ' ' + r.catno : ''), r.barcode ? 'barcode ' + r.barcode : ''].filter(Boolean).join(' · ') || ' ' })]),
            el('span', { class: 'mx-tracks' + (fits ? '' : ' short'), text: r.trackCount + (r.media.length > 1 ? ' on ' + r.media.length + ' discs' : ' tracks'), title: fits ? '' : 'Fewer tracks than you have songs' }),
            tagged ? el('span', { class: 'mx-flag', text: 'In your tags' }) : on ? el('span', { class: 'mx-flag now', text: 'Shelf’s pick' }) : el('span')
          ]));
        });
      }, function (e) { list.textContent = ''; list.appendChild(el('p', { class: 'insp-error', text: e.message || 'Couldn’t load the editions.' })); });
    }

    // ---------- Search ----------
    var searching = null;
    function openSearch(a) {
      searching = a;
      $('albumQuery').value = a.release ? a.release.title : a.guess.album || '';
      $('artistQuery').value = a.release ? a.release.artist : a.guess.artist || '';
      $('albumResults').textContent = '';
      $('albumSearchSheet').showModal();
      $('albumQuery').focus(); $('albumQuery').select();
    }
    function runSearch() {
      var a = searching, out = $('albumResults');
      if (!a) return;
      var q = { album: $('albumQuery').value.trim(), artist: $('artistQuery').value.trim() };
      if (!q.album) return;
      out.textContent = ''; out.appendChild(el('p', { class: 'muted', text: 'Searching MusicBrainz…' }));
      native.mbSearch(q).then(function (rels) {
        out.textContent = '';
        if (!rels.length) { out.appendChild(el('p', { class: 'muted', text: 'Nothing found. Try fewer words, or the artist’s name as MusicBrainz writes it.' })); return; }
        rels.slice(0, 15).forEach(function (r) {
          out.appendChild(el('button', { type: 'button', class: 'mx-option', onclick: function () { $('albumSearchSheet').close(); pickEdition(a, r.id); } }, [
            el('span', { class: 'mx-date', text: r.date || '—' }),
            el('span', { class: 'mx-main' }, [el('b', { text: r.title }), el('span', { text: [r.artist, edition(r)].filter(Boolean).join(' · ') })]),
            el('span', { class: 'mx-tracks', text: r.trackCount + ' tracks' }), el('span')
          ]));
        });
      }, function (e) { out.textContent = ''; out.appendChild(el('p', { class: 'insp-error', text: e.message || 'Search failed.' })); });
    }

    function wire() {
      var f = $('albumSearchForm');
      if (f) f.addEventListener('submit', function (e) { e.preventDefault(); runSearch(); });
      var c = $('asCancel');
      if (c) c.addEventListener('click', function () { $('albumSearchSheet').close(); });
    }
    wire();

    // ---------- For the details panel and the Needs-you card ----------
    function facts(s) {
      var a = albumOf(s), t = s.music && s.music.track, tg = s.music && s.music.tags && s.music.tags.ok ? s.music.tags : null;
      var r = a && a.release;
      var title = t ? t.title : (tg && tg.title) || s.name;
      var meta = [t ? t.artist || (r && r.artist) : tg && (tg.artists[0] || tg.albumArtists[0]), r ? r.title : tg && tg.album].filter(Boolean).join(' · ');
      var f = [['Type', s.parsed.ext.toUpperCase() + ' song' + (tg && tg.bitrate ? ' · ' + tg.bitrate + ' kbps' : '')]];
      if (s.music && s.music.duration) f.push(['Length', fmtLen(s.music.duration) + (t && t.length ? ' (MusicBrainz: ' + fmtLen(t.length) + ')' : '')]);
      if (r) f.push(['Source', el('span', {}, [el('a', { href: 'https://musicbrainz.org/release/' + r.id, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer', text: 'MusicBrainz' })])]);
      return { title: title, meta: meta, facts: f };
    }
    function fmtLen(s) { s = Math.round(s); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
    function coverUrl(i) { var a = albumOf(i); return a && a.release ? loadCover(a.release) : null; }
    function question(i) {
      var s = audioOf(i) || i, a = albumOf(s), name = (s.music && s.music.tags && s.music.tags.ok && s.music.tags.title) || s.name;
      var open = function () { ctx.select(s.id); };
      if (i.status === 'error') return { title: 'Couldn’t read “' + s.name + '”', text: i.error || 'Something went wrong reading this file.', actions: s.music && s.music.tags && s.music.tags.ok ? [{ label: 'Try Again', run: retry }] : [{ label: 'Take It Off the List', run: function () { ctx.select(s.id); ctx.$('removeBtn').click(); } }] };
      if (!a || i.status === 'nomatch') return { title: 'Which album is “' + (a ? a.guess.album || name : name) + '”?', text: (i.error || 'Shelf couldn’t find it on MusicBrainz.') + ' Search by album and artist.', actions: [{ label: 'Search…', run: function () { if (a) openSearch(a); } }] };
      var r = a.release;
      if (!s.music.track) return { title: '“' + name + '” isn’t on this edition', text: 'The album ' + r.title + ' (' + edition(r) + ') doesn’t have this song. Another edition may (a deluxe one, say), or it belongs to another album.', actions: [{ label: 'Other Editions…', run: function () { openEditions(a); } }, { label: 'Search…', run: function () { openSearch(a); } }, { label: 'Details', link: true, run: open }] };
      return { title: 'Is this ' + r.title + ' by ' + r.artist + '?', text: why(a) + ' ' + r.trackCount + ' tracks · ' + [r.date, edition(r)].filter(Boolean).join(' · ') + '.',
        actions: [{ label: 'Looks Right', run: function () { confirm(a); } }, { label: 'Other Editions…', run: function () { openEditions(a); } }, { label: 'Search…', run: function () { openSearch(a); } }, { label: 'Details', link: true, run: open }] };
    }
    function retry() {
      Object.keys(albums).forEach(function (k) { var a = albums[k]; if (a.status === 'error' && queue.indexOf(a) < 0) { relook(a); } });
    }

    function forget(ids) {
      Object.keys(albums).forEach(function (k) { var a = albums[k]; a.ids = a.ids.filter(function (id) { return ids.indexOf(id) < 0; }); if (!a.ids.length) delete albums[k]; });
    }
    function clear() { albums = {}; queue = []; }

    return {
      add: add, isTrack: isTrack, shelfKey: shelfKey, sortKey: sortKey, rowParts: rowParts, reasonFor: reasonFor, known: known, hay: hay,
      shelfTitle: shelfTitle, shelfSub: shelfSub, shelfCover: shelfCover, shelfHead: shelfHead, plexName: plexName, renameExtra: renameExtra,
      inspector: inspector, forget: forget, clear: clear, linkLyrics: linkLyrics, albumOf: albumOf,
      facts: facts, coverUrl: coverUrl, question: question, retry: retry, readable: readable, shrinkable: shrinkable,
      _albums: function () { return albums; }
    };
  }

  root.ShelfMusicUI = { create: create };
})(this);
