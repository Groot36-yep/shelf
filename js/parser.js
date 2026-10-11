/*
 * Shelf — filename parsing and Plex naming.
 * Pure functions with no network or DOM access, so they can be tested in Node.
 */
(function (root) {
  'use strict';

  var VIDEO_EXT = ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'webm', 'flv', 'divx', 'ogm'];
  var SUB_EXT = ['srt', 'ass', 'ssa', 'sub', 'idx', 'vtt', 'smi'];

  // Words that show up in release names but are never part of a title.
  var JUNK = [
    '2160p', '1080p', '1080i', '720p', '576p', '480p', '360p', '4k', 'uhd', 'hdr', 'hdr10', 'hdr10plus', 'dv', 'dovi', 'sdr',
    'bluray', 'blu-ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'webrip', 'web-dl', 'webdl', 'web', 'hdtv', 'pdtv', 'dsr', 'dvdrip',
    'dvdscr', 'dvd', 'dvd5', 'dvd9', 'hdrip', 'hd', 'sd', 'cam', 'ts', 'telesync', 'vhsrip', 'laserdisc',
    'x264', 'x265', 'h264', 'h265', 'h-264', 'h-265', 'hevc', 'avc', 'xvid', 'divx', 'av1', 'vp9', '10bit', '8bit', '12bit',
    'aac', 'aac2', 'ac3', 'eac3', 'dts', 'dts-hd', 'dtshd', 'truehd', 'atmos', 'flac', 'mp3', 'opus', 'dd', 'dd5', 'ddp', 'ddp5', 'dd2', '5.1', '7.1', '2.0',
    'proper', 'repack', 'rerip', 'internal', 'limited', 'remastered', 'restored', 'extended', 'unrated', 'uncut', 'theatrical',
    'imax', 'criterion', 'multi', 'multisubs', 'subbed', 'dubbed', 'dual', 'nf', 'amzn', 'dsnp', 'hmax', 'atvp', 'hulu', 'pcok',
    'complete', 'readnfo', 'nfo', 'sample'
  ];
  var JUNK_SET = {};
  JUNK.forEach(function (w) { JUNK_SET[w] = true; });

  var LANGS = {
    en: 'en', eng: 'en', english: 'en', es: 'es', spa: 'es', spanish: 'es', fr: 'fr', fre: 'fr', fra: 'fr', french: 'fr',
    de: 'de', ger: 'de', deu: 'de', german: 'de', it: 'it', ita: 'it', italian: 'it', pt: 'pt', por: 'pt', portuguese: 'pt',
    nl: 'nl', dut: 'nl', nld: 'nl', dutch: 'nl', ja: 'ja', jpn: 'ja', japanese: 'ja', ko: 'ko', kor: 'ko', korean: 'ko',
    zh: 'zh', chi: 'zh', zho: 'zh', chinese: 'zh', ru: 'ru', rus: 'ru', russian: 'ru', sv: 'sv', swe: 'sv', swedish: 'sv',
    da: 'da', dan: 'da', danish: 'da', no: 'no', nor: 'no', norwegian: 'no', fi: 'fi', fin: 'fi', finnish: 'fi',
    pl: 'pl', pol: 'pl', polish: 'pl', ar: 'ar', ara: 'ar', arabic: 'ar', he: 'he', heb: 'he', hebrew: 'he'
  };
  var SUB_FLAGS = ['forced', 'sdh', 'cc', 'hi'];

  function cleanSpaces(s) {
    return s.replace(/\s+/g, ' ').replace(/^[\s\-–—:,.]+|[\s\-–—:,.]+$/g, '').trim();
  }

  function titleCase(s) {
    // Only touch names that are entirely lower or upper case; keep "McCabe", "iCarly" etc. as typed.
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
    var small = { a: 1, an: 1, and: 1, as: 1, at: 1, but: 1, by: 1, for: 1, from: 1, 'in': 1, into: 1, nor: 1, of: 1, on: 1, or: 1, the: 1, to: 1, vs: 1, with: 1 };
    return s.toLowerCase().split(' ').map(function (w, i) {
      if (i > 0 && small[w]) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  // Cut a string at the first release-junk word. Returns { text, resolution }.
  function stripJunk(s) {
    var words = s.split(' ');
    var out = [];
    var resolution = null;
    for (var i = 0; i < words.length; i++) {
      var w = words[i].toLowerCase().replace(/[\[\]()]/g, '');
      if (/^(2160|1080|720|576|480|360)[pi]$/.test(w) && !resolution) resolution = w.replace('i', 'p');
      if (w === '4k' && !resolution) resolution = '2160p';
      if (JUNK_SET[w] || /^-?[a-z0-9]+$/.test(w) && /^(x|h)\.?26[45]$/.test(w)) break;
      out.push(words[i]);
    }
    // Pick up a resolution even if it appears after the cut.
    if (!resolution) {
      var m = s.match(/\b(2160|1080|720|576|480)[pi]\b/i);
      if (m) resolution = m[1] + 'p';
    }
    return { text: out.join(' '), resolution: resolution };
  }

  function splitExt(name) {
    var i = name.lastIndexOf('.');
    if (i <= 0) return { base: name, ext: '' };
    var ext = name.slice(i + 1).toLowerCase();
    if (!/^[a-z0-9]{2,6}$/.test(ext)) return { base: name, ext: '' };
    return { base: name.slice(0, i), ext: ext };
  }

  /**
   * Work out what a file probably is from its name alone.
   * Returns { kind: 'movie'|'episode'|'unknown', title, year, season, episode, episodeTitle,
   *           resolution, ext, isSubtitle, lang, subFlags }
   */
  function parseFilename(fileName) {
    var parts = splitExt(fileName);
    var ext = parts.ext;
    var base = parts.base;
    var isSubtitle = SUB_EXT.indexOf(ext) >= 0;
    var lang = null;
    var subFlags = [];

    if (isSubtitle) {
      // Peel ".en", ".forced", ".eng.sdh" off the end.
      for (var k = 0; k < 3; k++) {
        var p = splitExt(base);
        if (!p.ext) break;
        if (LANGS[p.ext] && !lang) { lang = LANGS[p.ext]; base = p.base; continue; }
        if (SUB_FLAGS.indexOf(p.ext) >= 0) { subFlags.unshift(p.ext === 'hi' ? 'sdh' : p.ext); base = p.base; continue; }
        break;
      }
    }

    // Normalise separators. Keep hyphens inside words (Spider-Man) but split "Show-S01E01".
    var s = base
      .replace(/[_]+/g, ' ')
      .replace(/\.(?!\d\b)/g, ' ')          // dots become spaces, except decimals like "5.1"
      .replace(/\[[^\]]*\]/g, function (m) {  // drop [group] tags, but keep a [1999] year
        return /^\[(19|20)\d{2}\]$/.test(m) ? ' ' + m.slice(1, -1) + ' ' : ' ';
      })
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Release group at the end: "... x264-GROUP"
    s = s.replace(/-[A-Za-z0-9]+$/, function (m) { return /\d{3,4}p/i.test(m) ? m : ''; });

    var result = {
      kind: 'unknown', title: '', year: null, season: null, episode: null, episodeTitle: '',
      resolution: null, ext: ext, isSubtitle: isSubtitle, lang: lang, subFlags: subFlags,
      isVideo: VIDEO_EXT.indexOf(ext) >= 0
    };

    // --- TV patterns -------------------------------------------------------
    var tvPatterns = [
      /\bS(\d{1,2})\s?[-.]?\s?E(\d{1,3})(?:\s?-?\s?E?\d{1,3})?\b/i, // S01E02, S01 E02, S01E02E03
      /\b(\d{1,2})x(\d{2,3})\b/i,                                   // 1x02
      /\bSeason\s?(\d{1,2})\s?[-,]?\s?Episode\s?(\d{1,3})\b/i       // Season 1 Episode 2
    ];
    for (var t = 0; t < tvPatterns.length; t++) {
      var m = s.match(tvPatterns[t]);
      if (m) {
        var before = s.slice(0, m.index).replace(/[\s\-–]+$/, '');
        var after = s.slice(m.index + m[0].length);
        var yearIn = before.match(/\(?\b(19[2-9]\d|20[0-4]\d)\b\)?\s*$/);
        if (yearIn) { result.year = parseInt(yearIn[1], 10); before = before.slice(0, yearIn.index); }
        var showJ = stripJunk(cleanSpaces(before.replace(/[()]/g, ' ')));
        var epJ = stripJunk(cleanSpaces(after.replace(/^\s*[-–]\s*/, '')));
        result.kind = 'episode';
        result.title = titleCase(cleanSpaces(showJ.text));
        result.season = parseInt(m[1], 10);
        result.episode = parseInt(m[2], 10);
        result.episodeTitle = titleCase(cleanSpaces(epJ.text));
        result.resolution = epJ.resolution || showJ.resolution;
        return result;
      }
    }

    // --- Movie -------------------------------------------------------------
    // The year is the LAST plausible 4-digit year that isn't the very first word
    // (so "2001 A Space Odyssey 1968" works, and "1917 (2019)" too).
    var yearRe = /(?:^|[\s(])((?:19[0-9]|20[0-4])\d)(?=$|[\s)])/g;
    var ym, lastYear = null;
    while ((ym = yearRe.exec(s)) !== null) {
      var startIdx = ym.index + ym[0].indexOf(ym[1]);
      if (startIdx === 0) continue;
      lastYear = { year: parseInt(ym[1], 10), index: startIdx };
    }
    var titlePart = s;
    if (lastYear) {
      result.year = lastYear.year;
      titlePart = s.slice(0, lastYear.index);
      var rest = stripJunk(s.slice(lastYear.index + 4));
      result.resolution = rest.resolution;
    }
    var tj = stripJunk(cleanSpaces(titlePart.replace(/[()]/g, ' ')));
    result.title = titleCase(cleanSpaces(tj.text));
    result.resolution = result.resolution || tj.resolution;
    if (!result.resolution) {
      var rm = s.match(/\b(2160|1080|720|576|480)p\b/i);
      if (rm) result.resolution = rm[1] + 'p';
    }
    result.kind = result.title ? 'movie' : 'unknown';
    return result;
  }

  // --- Similarity -----------------------------------------------------------
  function normalizeForCompare(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/^(the|a|an) /, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      var cur = [i];
      for (var k = 1; k <= b.length; k++) {
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // 0..1, how alike two titles are.
  function titleSimilarity(a, b) {
    var x = normalizeForCompare(a), y = normalizeForCompare(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    var lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
    var xs = x.split(' '), ys = y.split(' ');
    var common = xs.filter(function (w) { return ys.indexOf(w) >= 0; }).length;
    var jac = common / (xs.length + ys.length - common);
    return Math.max(lev, jac * 0.95);
  }

  function yearScore(wanted, actual) {
    if (!wanted) return 0.6;
    if (!actual) return 0.4;
    var d = Math.abs(wanted - actual);
    return d === 0 ? 1 : d === 1 ? 0.75 : d <= 3 ? 0.3 : 0;
  }

  /**
   * Score a list of candidates [{ title, altTitle, year, popularity }] for a parsed file.
   * Returns the same items sorted, each with `score` 0..100, plus `ambiguous` on the array.
   */
  function rankCandidates(parsed, candidates) {
    var maxPop = candidates.reduce(function (m, c) { return Math.max(m, c.popularity || 0); }, 0) || 1;
    var ranked = candidates.map(function (c) {
      var sim = Math.max(titleSimilarity(parsed.title, c.title), titleSimilarity(parsed.title, c.altTitle || ''));
      var ys = yearScore(parsed.year, c.year);
      var pop = (c.popularity || 0) / maxPop;
      var score = parsed.year ? sim * 0.68 + ys * 0.27 + pop * 0.05 : sim * 0.82 + pop * 0.12 + 0.03;
      return Object.assign({}, c, { score: Math.round(Math.min(1, score) * 100), _sim: sim });
    }).sort(function (a, b) { return b.score - a.score; });
    var ambiguous = ranked.length > 1 && ranked[0].score - ranked[1].score < 6 && ranked[1].score >= 60;
    // Same title, different years (remakes) and the file doesn't say which: always ask.
    if (!parsed.year) {
      var years = {};
      ranked.forEach(function (c) { if (c._sim >= 0.95) years[c.year || '?'] = 1; });
      if (Object.keys(years).length > 1) ambiguous = true;
    }
    ranked.ambiguous = ambiguous;
    return ranked;
  }

  // --- Plex names ------------------------------------------------------------
  var WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

  // Make a string safe to use as ONE file or folder name on macOS, Windows and Linux.
  // Titles come from online databases, so treat them as untrusted.
  function safeName(s) {
    var out = String(s || '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '') // control + bidi tricks
      .replace(/\s*:\s*/g, ' - ')
      .replace(/[\/\\]/g, '-')
      .replace(/[*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+/, '')        // no hidden files, no "..": nothing that climbs folders
      .replace(/[. ]+$/, '')        // Windows drops trailing dots/spaces
      .trim();
    if (out.length > 150) out = out.slice(0, 150).replace(/[. ]+$/, '');
    if (!out) out = 'Unknown';
    if (WIN_RESERVED.test(out)) out = out + '_';
    return out;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * Build the Plex path for a matched file.
   * match: movie { title, year, id } or episode { show, showYear, season, episode, episodeTitle, id }
   * opts: { movieIds: bool, showYear: bool }
   * Returns { folder: [..segments], file }
   */
  function plexName(parsed, match, opts) {
    opts = opts || {};
    var ext = parsed.ext;
    var subSuffix = '';
    if (parsed.isSubtitle) {
      subSuffix = (parsed.lang ? '.' + parsed.lang : '') + (parsed.subFlags.length ? '.' + parsed.subFlags.join('.') : '');
    }
    if (match.type === 'movie') {
      var year = parseInt(match.year, 10);
      var name = safeName(match.title) + (year > 1800 ? ' (' + year + ')' : '');
      var tmdbId = parseInt(match.id, 10);
      var idTag = opts.movieIds && tmdbId > 0 ? ' {tmdb-' + tmdbId + '}' : '';
      return { folder: ['Movies', name + idTag], file: name + idTag + subSuffix + '.' + ext };
    }
    var showYear = parseInt(match.showYear, 10);
    var season = Math.max(0, parseInt(match.season, 10) || 0);
    var episode = Math.max(0, parseInt(match.episode, 10) || 0);
    var show = safeName(match.show) + (opts.showYear && showYear > 1800 ? ' (' + showYear + ')' : '');
    var se = 'S' + pad2(season) + 'E' + pad2(episode);
    var ep = match.episodeTitle ? ' - ' + safeName(match.episodeTitle) : '';
    return {
      folder: ['TV Shows', show, 'Season ' + pad2(season)],
      file: show + ' - ' + se + ep + subSuffix + '.' + ext
    };
  }

  // --- Rename scripts ---------------------------------------------------------
  // Every name that goes into a script is quoted so the shell treats it as plain text,
  // never as a command. Filenames and titles are untrusted input.

  function oneLine(s) { return String(s).replace(/[\u0000-\u001f\u007f]/g, ' '); }

  // bash: single quotes, with ' written as '\''
  function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  // PowerShell: single quotes; PowerShell also treats ‘ ’ ‚ ‛ as quotes, so double all of them
  function psq(s) { return "'" + String(s).replace(/['‘’‚‛]/g, function (q) { return q + q; }) + "'"; }

  var PAST = { move: 'moved', copy: 'copied', link: 'linked' };

  function buildBash(items, opts) {
    var mode = PAST[opts.mode] ? opts.mode : 'move';
    var lib = String(opts.library || '~/Media').trim().replace(/\/+$/, '') || '~';
    var libExpr = lib.indexOf('~/') === 0 ? '"$HOME"/' + shq(lib.slice(2)) : lib === '~' ? '"$HOME"' : shq(lib);
    var cmd = mode === 'copy' ? 'cp -p' : mode === 'link' ? 'ln' : 'mv -n';
    var head = function (what) {
      return [
        '#!/bin/bash',
        '# Made by Shelf — ' + what,
        '# HOW TO RUN: keep this file in the same folder as your videos. Open Terminal,',
        '# type "bash " (with a space), drag this file into the window, and press Return.',
        '# It never overwrites a file that already exists.',
        '',
        'cd "$(dirname "$0")" || exit 1',
        'LIB=' + libExpr,
        'ok=0; skipped=0',
        'note() { printf \'%s %s\\n\' "$1" "$2"; }',
        ''
      ];
    };
    var lines = head('renames your videos for Plex.');
    var undo = head('puts your files back the way they were.');
    items.forEach(function (it) {
      var src = shq(it.source);
      var dir = '"$LIB"/' + it.folder.map(shq).join('/');
      var dest = dir + '/' + shq(it.file);
      lines.push('# ' + oneLine(it.source));
      lines.push('if [ ! -e ' + src + ' ]; then note "Not found, skipped:" ' + src + '; skipped=$((skipped+1))');
      lines.push('elif [ -e ' + dest + ' ]; then note "Already exists, skipped:" ' + shq(it.file) + '; skipped=$((skipped+1))');
      lines.push('else mkdir -p ' + dir + ' && ' + cmd + ' ' + src + ' ' + dest + ' && ok=$((ok+1)); fi');
      lines.push('');
      undo.push('# ' + oneLine(it.file));
      if (mode === 'move') {
        // Only move back if the file is in the library and nothing has taken its old place.
        undo.push('if [ -e ' + dest + ' ] && [ ! -e ' + src + ' ]; then mkdir -p "$(dirname ' + src + ')" && mv -n ' + dest + ' ' + src + ' && ok=$((ok+1)); fi');
      } else if (mode === 'link') {
        // Only remove the library entry if it is still the very same file as the original.
        undo.push('if [ -e ' + dest + ' ] && [ ' + dest + ' -ef ' + src + ' ]; then rm -- ' + dest + ' && ok=$((ok+1)); fi');
      } else {
        // Only remove the copy if the original is still there and identical.
        undo.push('if [ -e ' + dest + ' ] && [ -e ' + src + ' ] && cmp -s ' + src + ' ' + dest + '; then rm -- ' + dest + ' && ok=$((ok+1)); fi');
      }
    });
    lines.push('echo "Shelf: ' + PAST[mode] + ' $ok file(s), skipped $skipped."');
    undo.push('echo "Shelf: undid $ok file(s)."');
    return { script: lines.join('\n') + '\n', undo: undo.join('\n') + '\n', ext: 'sh' };
  }

  function buildPowerShell(items, opts) {
    var mode = PAST[opts.mode] ? opts.mode : 'move';
    var lib = String(opts.library || '~\\Videos').trim().replace(/[\\/]+$/, '') || '~';
    var libExpr = /^~([\\/]|$)/.test(lib) ? '[System.IO.Path]::Combine($HOME, ' + psq(lib.replace(/^~[\\/]?/, '')) + ')' : psq(lib);
    var head = function (what) {
      var h = [
        '# Made by Shelf — ' + what,
        '# HOW TO RUN: keep this file in the same folder as your videos,',
        '# then right-click it and choose "Run with PowerShell".',
        '# It never overwrites a file that already exists.',
        '',
        '$ErrorActionPreference = \'Stop\'',
        '$Here = $PSScriptRoot',
        '$Lib = ' + libExpr,
        '$script:ok = 0; $script:skipped = 0',
        'function Get-LibPath([string[]]$Parts) { $p = $Lib; foreach ($x in $Parts) { $p = [System.IO.Path]::Combine($p, $x) }; return $p }',
        ''
      ];
      if (mode === 'link') {
        h.push('Add-Type -Namespace Shelf -Name Native -MemberDefinition \'[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CreateHardLink(string newFile, string existingFile, IntPtr security);\'');
        h.push('');
      }
      return h;
    };
    var op = mode === 'copy' ? '[System.IO.File]::Copy($from, $to, $false)'
      : mode === 'link' ? 'if (-not [Shelf.Native]::CreateHardLink($to, $from, [IntPtr]::Zero)) { throw "Hard link failed (are both folders on the same drive?)" }'
      : '[System.IO.File]::Move($from, $to)';
    var lines = head('renames your videos for Plex.');
    lines.push(
      'function Invoke-ShelfItem([string]$Src, [string[]]$Dir, [string]$File) {',
      '  $from = [System.IO.Path]::Combine($Here, $Src)',
      '  if (-not [System.IO.File]::Exists($from)) { Write-Host "Not found, skipped: $Src"; $script:skipped++; return }',
      '  $toDir = Get-LibPath $Dir',
      '  $to = [System.IO.Path]::Combine($toDir, $File)',
      '  if ([System.IO.File]::Exists($to)) { Write-Host "Already exists, skipped: $File"; $script:skipped++; return }',
      '  try { [void][System.IO.Directory]::CreateDirectory($toDir); ' + op + '; $script:ok++ }',
      '  catch { Write-Host "Could not do $Src : $($_.Exception.Message)"; $script:skipped++ }',
      '}',
      ''
    );
    var undo = head('puts your files back the way they were.');
    var check = mode === 'move'
      ? 'if ([System.IO.File]::Exists($to) -and -not [System.IO.File]::Exists($from)) { [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($from)); [System.IO.File]::Move($to, $from); $script:ok++ }'
      : 'if ([System.IO.File]::Exists($to) -and [System.IO.File]::Exists($from)) { $a = Get-Item -LiteralPath $from; $b = Get-Item -LiteralPath $to; if ($a.Length -eq $b.Length -and $a.LastWriteTimeUtc -eq $b.LastWriteTimeUtc) { [System.IO.File]::Delete($to); $script:ok++ } }';
    undo.push(
      'function Undo-ShelfItem([string]$Src, [string[]]$Dir, [string]$File) {',
      '  $from = [System.IO.Path]::Combine($Here, $Src)',
      '  $to = [System.IO.Path]::Combine((Get-LibPath $Dir), $File)',
      '  try { ' + check + ' }',
      '  catch { Write-Host "Could not undo $File : $($_.Exception.Message)" }',
      '}',
      ''
    );
    items.forEach(function (it) {
      var args = ' ' + psq(it.source) + ' @(' + it.folder.map(psq).join(', ') + ') ' + psq(it.file);
      lines.push('# ' + oneLine(it.source));
      lines.push('Invoke-ShelfItem' + args);
      undo.push('Undo-ShelfItem' + args);
    });
    lines.push('', 'Write-Host "Shelf: ' + PAST[mode] + ' $($script:ok) file(s), skipped $($script:skipped)."', 'Read-Host "Press Enter to close" | Out-Null');
    undo.push('', 'Write-Host "Shelf: undid $($script:ok) file(s)."', 'Read-Host "Press Enter to close" | Out-Null');
    // Windows PowerShell 5 needs a byte-order mark to read accented letters correctly.
    return { script: '﻿' + lines.join('\r\n') + '\r\n', undo: '﻿' + undo.join('\r\n') + '\r\n', ext: 'ps1' };
  }

  /**
   * items: [{ source: 'relative/path.mkv', folder: [...], file }]
   * opts: { library, mode: 'move'|'copy'|'link', platform: 'mac'|'windows' }
   */
  function buildScript(items, opts) {
    opts = opts || {};
    return opts.platform === 'windows' ? buildPowerShell(items, opts) : buildBash(items, opts);
  }

  var api = {
    parseFilename: parseFilename,
    titleSimilarity: titleSimilarity,
    rankCandidates: rankCandidates,
    plexName: plexName,
    buildScript: buildScript,
    safeName: safeName,
    VIDEO_EXT: VIDEO_EXT,
    SUB_EXT: SUB_EXT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShelfParser = api;
})(this);
