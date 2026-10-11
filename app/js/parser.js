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

  // "The Office US" / "Shameless (UK)" → title + country. Lower-case "us" is left alone,
  // so "This Is Us" stays "This Is Us".
  var COUNTRY = { US: 'US', UK: 'GB', GB: 'GB', AU: 'AU', NZ: 'NZ', CA: 'CA', IE: 'IE' };
  function splitCountry(title) {
    var m = title.match(/^(.+?)\s+\(?(US|UK|GB|AU|NZ|CA|IE|uk|au|nz)\)?$/);
    if (!m || !/\S/.test(m[1])) return { title: title, country: null };
    return { title: cleanSpaces(m[1]), country: COUNTRY[m[2].toUpperCase()] };
  }

  // Cut a string at the first release-junk word. Returns { text, resolution }.
  function stripJunk(s, keepFirst) {
    var words = s.split(' ');
    var out = [];
    var resolution = null;
    for (var i = 0; i < words.length; i++) {
      var w = words[i].toLowerCase().replace(/[\[\]()]/g, '');
      if (/^(2160|1080|720|576|480|360)[pi]$/.test(w) && !resolution) resolution = w.replace('i', 'p');
      if (w === '4k' && !resolution) resolution = '2160p';
      // (Never the first word: a film can be called "Web" or "Cam".)
      var junk = JUNK_SET[w] || /^(x|h)\.?26[45]$/.test(w);
      if (junk && (i > 0 || !keepFirst || /^(\d{3,4}[pi]|4k)$/.test(w))) break;
      out.push(words[i]);
    }
    // Pick up a resolution even if it appears after the cut.
    if (!resolution) {
      var m = s.match(/\b(2160|1080|720|576|480)[pi]\b/i);
      if (m) resolution = m[1] + 'p';
    }
    return { text: out.join(' '), resolution: resolution };
  }

  // Where the video came from, read from release words like "BluRay", "WEB-DL", "HDTV".
  // Checked in order: the first that fits wins.
  var SOURCES = [
    [/\b(?:bd|blu-?ray|br)?\s?remux\b/i, 'Remux'],
    [/\b(?:blu-?ray|blu ray|bdrip|brrip|bd25|bd50|bluray)\b/i, 'BluRay'],
    [/\b(?:web-?dl|web dl)\b/i, 'WEB-DL'],
    [/\b(?:web-?rip|web rip)\b/i, 'WEBRip'],
    [/\b(?:hdtv|pdtv|sdtv|dsr|tvrip)\b/i, 'HDTV'],
    [/\b(?:dvd-?rip|dvdr|dvd5|dvd9|dvd)\b/i, 'DVD'],
    [/\bhd-?rip\b/i, 'HDRip'],
    [/\bweb\b/i, 'WEB'],
    [/\bvhs(?:rip)?\b/i, 'VHS']
  ];
  function detectSource(tail) {
    for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i][0].test(tail)) return SOURCES[i][1];
    return null;
  }
  function detectHdr(tail) {
    if (/\b(?:dv|dovi|dolby vision)\b/i.test(tail)) return 'DV';
    if (/\bhdr(?:10\+?|10plus)?\b/i.test(tail)) return 'HDR';
    return null;
  }

  /** "1080p BluRay", "2160p WEB-DL HDR", or '' if the name doesn't say. */
  function qualityLabel(parsed) {
    if (!parsed) return '';
    return [parsed.resolution, parsed.source, parsed.hdr].filter(Boolean).join(' ');
  }

  // For a show name (before S01E01) junk is rare and only ever at the end: "Show 1080p S01E01".
  // So "The Dark Web" keeps its last word.
  function stripTrailingJunk(s) {
    var words = s.split(' ');
    var resolution = null;
    while (words.length > 1) {
      var w = words[words.length - 1].toLowerCase().replace(/[\[\]()]/g, '');
      if (!/^((2160|1080|720|576|480|360)[pi]|4k|uhd|[xh]\.?26[45]|hevc|avc|xvid|10bit|hdr|bluray|web-dl|webrip|hdtv)$/.test(w)) break;
      if (/^(2160|1080|720|576|480|360)[pi]$/.test(w)) resolution = w.replace('i', 'p');
      words.pop();
    }
    return { text: words.join(' '), resolution: resolution };
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
    s = s.replace(/-[A-Za-z0-9]+$/, function (m) { return /\d{3,4}p/i.test(m) || /^-(dl|rip|ray|hd|e?\d{1,3})$/i.test(m) ? m : ''; });

    var result = {
      kind: 'unknown', title: '', year: null, season: null, episode: null, episodeEnd: null, episodeTitle: '',
      airdate: null, country: null, resolution: null, source: null, hdr: null,
      ext: ext, isSubtitle: isSubtitle, lang: lang, subFlags: subFlags,
      isVideo: VIDEO_EXT.indexOf(ext) >= 0
    };
    // Quality words are only read from the part AFTER the title, so a film called "Web" stays a title.
    function setQuality(tail) {
      result.source = result.source || detectSource(tail);
      result.hdr = result.hdr || detectHdr(tail);
    }
    function showPart(before) {
      var yearIn = before.match(/\(?\b(19[2-9]\d|20[0-4]\d)\b\)?\s*$/);
      if (yearIn) { result.year = parseInt(yearIn[1], 10); before = before.slice(0, yearIn.index); }
      var showJ = stripTrailingJunk(cleanSpaces(before.replace(/[()]/g, ' ')));
      setQuality(cleanSpaces(before.replace(/[()]/g, ' ')).slice(showJ.text.length));
      var c = splitCountry(cleanSpaces(showJ.text));
      result.country = c.country;
      result.title = titleCase(c.title);
      return showJ;
    }

    // --- TV patterns -------------------------------------------------------
    var tvPatterns = [
      /\bS(\d{1,2})\s?[-.]?\s?E(\d{1,3})(?:\s?-?\s?E(\d{1,3})|-(\d{1,3})\b)?\b/i, // S01E02, S01 E02, S01E02E03, S01E02-03
      /\b(\d{1,2})x(\d{2,3})(?:-?(?:\d{1,2}x)?(\d{2,3}))?\b/i,                   // 1x02, 1x02-03
      /\bSeason\s?(\d{1,2})\s?[-,]?\s?Episode\s?(\d{1,3})\b/i                    // Season 1 Episode 2
    ];
    for (var t = 0; t < tvPatterns.length; t++) {
      var m = s.match(tvPatterns[t]);
      if (m) {
        var before = s.slice(0, m.index).replace(/[\s\-–]+$/, '');
        var after = s.slice(m.index + m[0].length);
        var showJ = showPart(before);
        var epText = cleanSpaces(after.replace(/^\s*[-–]\s*/, ''));
        var epJ = stripJunk(epText);
        setQuality(epText.slice(epJ.text.length));
        result.kind = 'episode';
        result.season = parseInt(m[1], 10);
        result.episode = parseInt(m[2], 10);
        var end = parseInt(m[3] || m[4], 10);
        if (end > result.episode && end - result.episode < 10) result.episodeEnd = end;
        result.episodeTitle = titleCase(cleanSpaces(epJ.text));
        result.resolution = epJ.resolution || showJ.resolution;
        return result;
      }
    }

    // Daily shows: "The Daily Show 2024.01.15"
    var dm = s.match(/\b((?:19|20)\d{2})[ .-](0[1-9]|1[0-2])[ .-](0[1-9]|[12]\d|3[01])\b/);
    if (dm && dm.index > 0) {
      var dShow = showPart(s.slice(0, dm.index).replace(/[\s\-–]+$/, ''));
      var dRest = cleanSpaces(s.slice(dm.index + dm[0].length).replace(/^\s*[-–]\s*/, ''));
      var dJ = stripJunk(dRest);
      setQuality(dRest.slice(dJ.text.length));
      result.kind = 'episode';
      result.airdate = dm[1] + '-' + dm[2] + '-' + dm[3];
      result.episodeTitle = titleCase(cleanSpaces(dJ.text));
      result.resolution = dJ.resolution || dShow.resolution;
      return result;
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
      setQuality(s.slice(lastYear.index + 4));
    }
    var cleanTitlePart = cleanSpaces(titlePart.replace(/[()]/g, ' '));
    var tj = stripJunk(cleanTitlePart, true);
    setQuality(cleanTitlePart.slice(tj.text.length));
    result.title = titleCase(cleanSpaces(tj.text));
    result.resolution = result.resolution || tj.resolution;
    if (!result.resolution) {
      var rm = s.match(/\b(2160|1080|720|576|480)p\b/i);
      if (rm) result.resolution = rm[1] + 'p';
    }
    result.kind = result.title ? 'movie' : 'unknown';
    // "Show - Episode Title" with no episode number: could be a TV episode. Shelf checks that
    // show's episode list for that title before treating it as one (so "Mission: Impossible -
    // Fallout" stays a movie).
    var dash = cleanTitlePart.split(/\s[-–—]\s/);
    if (dash.length >= 2) {
      var left = cleanSpaces(dash[0]), right = stripJunk(cleanSpaces(dash.slice(1).join(' - '))).text;
      if (left.length >= 2 && cleanSpaces(right).length >= 2) {
        var lc = splitCountry(left);
        result.altTv = { show: titleCase(lc.title), country: lc.country, episodeTitle: titleCase(cleanSpaces(right)) };
      }
    }
    return result;
  }

  /**
   * Like parseFilename, but also looks at the folders the file sits in (nearest last), for
   * libraries like "Breaking Bad (2008)/Season 1/01 - Pilot.mkv".
   */
  var SEASON_DIR = /^(?:season|series|saison|staffel|temporada)[\s._-]*(\d{1,3})\b|^s(\d{1,2})$|^(specials?|extras)$/i;
  function parsePath(fileName, folders) {
    var r = parseFilename(fileName);
    folders = (folders || []).filter(function (f) { return f && !/^[a-z]:$/i.test(f); });
    if (!folders.length || !(r.isVideo || r.isSubtitle)) return r;

    var seasonAt = -1, folderSeason = null;
    for (var i = folders.length - 1; i >= 0 && i >= folders.length - 2; i--) {
      var sm = folders[i].trim().match(SEASON_DIR);
      if (sm) { seasonAt = i; folderSeason = sm[3] ? 0 : parseInt(sm[1] || sm[2], 10); break; }
    }
    var showDir = seasonAt > 0 ? folders[seasonAt - 1] : seasonAt === -1 ? folders[folders.length - 1] : null;

    // "Season 2/E05.mkv", "Season 2/05 - Title.mkv", "Season 2/Episode 5.mkv"
    if (r.kind !== 'episode' && seasonAt >= 0) {
      var base = splitExt(fileName).base;
      if (r.isSubtitle) for (var k = 0; k < 3; k++) base = base.replace(/\.(?:[a-z]{2,3}|forced|sdh|cc|hi)$/i, '');
      base = base.replace(/[._]+/g, ' ').trim();
      var em = base.match(/^(?:e|ep|episode)\s*(\d{1,3})\b/i) || base.match(/\b(?:e|ep|episode)\s*(\d{1,3})\b/i) || base.match(/^(\d{1,3})(?=$|\s|-)/);
      if (em) {
        var restEp = cleanSpaces(base.slice(em.index + em[0].length).replace(/^\s*[-–]\s*/, ''));
        var rj = stripJunk(restEp);
        r.kind = 'episode';
        r.title = '';
        r.year = null;
        r.season = folderSeason;
        r.episode = parseInt(em[1], 10);
        r.episodeTitle = titleCase(cleanSpaces(rj.text));
        r.resolution = r.resolution || rj.resolution;
      }
    }
    if (r.kind !== 'episode' || !showDir) return r;

    // The show folder fills in what the file name doesn't say: the title, year or country.
    // Release folders like "The.Office.US.S02.1080p.WEB-DL" → "The.Office.US"
    var dirName = showDir.replace(/[\s._-]+(?:S\d{1,2}(?:E\d+)?|Season[\s._]?\d{1,2})(?:[\s._-].*)?$/i, '');
    var sp = parseFilename(dirName + '.mkv');
    if (!sp.title) return r;
    var c = splitCountry(cleanSpaces(sp.title));
    if (!c.country) c = splitCountry(cleanSpaces(dirName.replace(/[._]+/g, ' ').replace(/\s*\(?(?:19|20)\d{2}\)?\s*$/, '')));
    var showTitle = c.country ? titleCase(c.title) : sp.title;
    if (!r.title) {
      r.title = showTitle;
      r.titleFromFolder = true;
      r.year = r.year || sp.year;
      r.country = r.country || c.country;
    } else if (titleSimilarity(r.title, showTitle) >= 0.9 || titleSimilarity(r.title, sp.title) >= 0.9) {
      r.year = r.year || sp.year;
      r.country = r.country || c.country;
    }
    if (r.season === null && folderSeason !== null) r.season = folderSeason;
    if (!r.source) r.source = sp.source;
    if (!r.resolution) r.resolution = sp.resolution;
    return r;
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
    // A short name that starts the full one: "SpongeBob" → "SpongeBob SquarePants".
    var shorter = xs.length <= ys.length ? xs : ys, longer = xs.length <= ys.length ? ys : xs;
    var prefix = shorter.join(' ').length >= 5 && shorter.every(function (w, i) { return longer[i] === w; }) ? 0.84 : 0;
    return Math.max(lev, jac * 0.95, prefix);
  }

  function yearScore(wanted, actual) {
    if (!wanted) return 0.6;
    if (!actual) return 0.4;
    var d = Math.abs(wanted - actual);
    return d === 0 ? 1 : d === 1 ? 0.75 : d <= 3 ? 0.3 : 0;
  }

  // How well known a show/movie is (TVmaze "weight" 0-100, else the popularity number).
  function fame(c) { return c.weight != null ? c.weight : (c.popularity || 0); }

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
      // "The Office US": the US show wins, the UK one drops back.
      if (parsed.country && c.country) score += c.country === parsed.country ? 0.06 : -0.2;
      return Object.assign({}, c, { score: Math.round(Math.max(0, Math.min(1, score)) * 100), _sim: sim });
    }).sort(function (a, b) { return b.score - a.score || (b.popularity || 0) - (a.popularity || 0); });
    var ambiguous = ranked.length > 1 && ranked[0].score - ranked[1].score < 6 && ranked[1].score >= 60;
    // Same title, different years (remakes) and the file doesn't say which.
    if (!parsed.year) {
      var twins = ranked.filter(function (c) { return c._sim >= 0.95 && (!parsed.country || c.country === parsed.country); });
      var years = {};
      twins.forEach(function (c) { years[c.year || '?'] = 1; });
      if (Object.keys(years).length > 1) {
        ambiguous = true;
        // TV only: if one show is far better known than every other show with that name,
        // that's the one (e.g. "Bonanza" 1959 vs an obscure namesake). Movies always ask.
        var tv = twins[0].type === 'episode';
        var byPop = twins.slice().sort(function (a, b) { return fame(b) - fame(a); });
        if (tv && fame(byPop[0]) >= 3 * Math.max(1, fame(byPop[1]))) {
          var fav = byPop[0];
          ranked.splice(ranked.indexOf(fav), 1);
          ranked.unshift(fav);
          fav.score = Math.max(fav.score, 80);
          ambiguous = false;
        }
      }
    } else if (ranked.length > 1 && ranked[0]._sim >= 0.95 && ranked[1]._sim >= 0.95 && ranked[0].year === ranked[1].year &&
               ranked[0].type === 'episode' && fame(ranked[0]) >= 3 * Math.max(1, fame(ranked[1]))) {
      ambiguous = false; // same name, same year, but one is far better known
    }
    ranked.ambiguous = ambiguous;
    return ranked;
  }

  // --- Episodes: two-part cartoons, DVD vs aired order ------------------------
  // Shows like SpongeBob list each 11-minute cartoon as its own episode, but most files hold a
  // whole half-hour (two or three cartoons), and DVDs number things differently again.
  // Shelf trusts episode TITLES first, and only then the numbers.

  function normEp(s) {
    return ' ' + String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ').replace(/'/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  }

  function seasonEntries(list, season) {
    return (list || []).filter(function (e) { return e.season === season && e.number != null; })
      .sort(function (a, b) { return a.number - b.number; });
  }

  /** Which listed cartoons aired together as one half-hour: same air date, about 22 minutes. */
  function halfHourGroups(entries) {
    var groups = [], cur = [], mins = 0;
    entries.forEach(function (e) {
      var full = cur.length && (e.aired !== cur[0].aired || (mins >= 19) || (!e.runtime && cur.length >= 2));
      if (full) { groups.push(cur); cur = []; mins = 0; }
      cur.push(e); mins += e.runtime || 11;
    });
    if (cur.length) groups.push(cur);
    return groups;
  }
  function isSegmented(entries) {
    if (entries.length < 4) return false;
    var short = entries.filter(function (e) { return e.runtime && e.runtime <= 15; }).length;
    var groups = halfHourGroups(entries);
    return groups.length <= entries.length * 0.75 && (short >= entries.length * 0.5 || !entries.some(function (e) { return e.runtime; }));
  }

  /** Find the listed episode(s) whose titles appear in the file's title. */
  function matchByTitle(fileTitle, list, preferSeason) {
    var ft = normEp(fileTitle);
    var ftLen = ft.trim().length;
    if (ftLen < 3) return null;
    var hits = [];
    (list || []).forEach(function (e) {
      if (e.number == null) return;
      var n = normEp(e.name), nt = n.trim();
      if (nt.length < 3 || /^(episode|pilot|part|chapter) ?\d*$/.test(nt) && nt !== ft.trim()) return;
      var words = nt.split(' ').length;
      if (ft.indexOf(n) >= 0 && (nt.length >= 5 || words >= 2 || nt === ft.trim())) hits.push({ e: e, len: nt.length });
    });
    if (!hits.length) {
      // One title with a typo or different punctuation: "Plankton" vs "Plankton!", "Sponge Bob" vs "SpongeBob"
      var best = null;
      (list || []).forEach(function (e) {
        if (e.number == null || !e.name) return;
        var sim = titleSimilarity(fileTitle, e.name);
        if (sim >= 0.86 && (!best || sim > best.sim || sim === best.sim && e.season === preferSeason)) best = { e: e, len: ftLen, sim: sim };
      });
      if (best) hits.push(best);
    }
    if (!hits.length) return null;
    // "Mermaid Man and Barnacle Boy" is inside "Mermaid Man and Barnacle Boy II": keep the longer one.
    hits = hits.filter(function (h) {
      var hn = normEp(h.e.name);
      return !hits.some(function (o) { return o !== h && o.len > h.len && normEp(o.e.name).indexOf(hn) >= 0; });
    });
    var seasons = {};
    hits.forEach(function (h) { seasons[h.e.season] = (seasons[h.e.season] || 0) + h.len; });
    var season = seasons[preferSeason] ? preferSeason : +Object.keys(seasons).sort(function (a, b) { return seasons[b] - seasons[a]; })[0];
    var inSeason = hits.filter(function (h) { return h.e.season === season; }).sort(function (a, b) { return a.e.number - b.e.number; });
    var covered = inSeason.reduce(function (t, h) { return t + h.len; }, 0);
    var coverage = Math.min(1, covered / ftLen);
    // A jump to another season needs a strong, specific match.
    if (season !== preferSeason && preferSeason != null && !(coverage >= 0.85 && covered >= 8)) return null;
    if (coverage < 0.5) return null;
    var nums = inSeason.map(function (h) { return h.e.number; });
    var contiguous = nums.every(function (n, i) { return i === 0 || n === nums[i - 1] + 1; });
    return { season: season, entries: inSeason.map(function (h) { return h.e; }), contiguous: contiguous, coverage: coverage };
  }

  // --- Title cards read from the video (on this computer) ----------------------
  // OCR on cartoon lettering is messy ("JeliFistNg", "RipPap Pants"), but Shelf only has to
  // pick from the show's own episode titles, so a close-enough match is enough.
  function squash(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  }
  // Fewest edits to turn `t` into some stretch of `s` (approximate substring search).
  function fuzzyFind(t, s) {
    var prev = new Array(t.length + 1), cur = new Array(t.length + 1), best = t.length;
    for (var i = 0; i <= t.length; i++) prev[i] = i;
    for (var j = 1; j <= s.length; j++) {
      cur[0] = 0; // a match may start anywhere in s
      for (var k = 1; k <= t.length; k++) {
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (t[k - 1] === s[j - 1] ? 0 : 1));
      }
      if (cur[t.length] < best) best = cur[t.length];
      var tmp = prev; prev = cur; cur = tmp;
    }
    return best;
  }
  // Words of a title or a reading, lower-case, without accents or apostrophes ("SpongeBob's" → "spongebobs").
  function cardWords(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/['’`]/g, '')
      .split(/[^a-z0-9]+/).filter(Boolean);
  }
  function editDist(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    var prev = [], cur = [];
    for (var i = 0; i <= b.length; i++) prev[i] = i;
    for (var x = 1; x <= a.length; x++) {
      cur = [x]; var low = x;
      for (var y = 1; y <= b.length; y++) {
        cur[y] = Math.min(prev[y] + 1, cur[y - 1] + 1, prev[y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1));
        if (cur[y] < low) low = cur[y];
      }
      if (low > cap) return cap + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  var CARD_STOP = { the: 1, a: 1, an: 1, of: 1, and: 1, in: 1, to: 1, for: 1, on: 1, at: 1, or: 1, not: 1 };
  // How much of a title's words appear in what was read (each word allowed a few OCR slips, more for long words).
  // Readings of the same frame are pooled: one version may catch "SPONGEBOB'S", another "LAST", another "STAND".
  // How a word of a title shows up in a set of words read: 1 = clearly, 0 < x < 1 = a near miss
  // of a long word, 'weak' = a 4-letter word with one wrong letter (only trusted next to another word).
  function wordHit(w, tokens, blob) {
    if (tokens.indexOf(w) >= 0) return 1;
    if (w.length <= 5) {
      // Short words: exact, or (5 letters) one wrong letter in the same place. Anything looser is
      // too easy to fake by chance in a busy picture ("ine" isn't "Mine", "wary" isn't "Gary").
      var one = function (t) { return t.length === w.length && editDist(w, t, 1) <= 1; };
      if (w.length === 5 && tokens.some(one)) return 1;
      if (w.length === 4 && tokens.some(one)) return 'weak';
      return 0;
    }
    var cap = w.length <= 8 ? 2 : 3, bestD = 99;
    tokens.forEach(function (t) { if (Math.abs(t.length - w.length) <= cap + 1) bestD = Math.min(bestD, editDist(w, t, cap + 1)); });
    // Words the reader ran together ("garyinlove"): look inside the joined text too.
    if (blob) bestD = Math.min(bestD, fuzzyFind(w, blob) + 1);
    // Long words: a near miss earns part of the credit ("ShONGERDE'S" ≈ "SpongeBob's").
    return bestD <= cap ? 1 : bestD <= Math.floor(w.length * 0.45) ? 1 - bestD / w.length : 0;
  }
  // How much of a title's words appear in what was read. Readings of the same frame are pooled: one
  // version may catch "SPONGEBOB'S", another "LAST", another "STAND".
  function wordScore(title, tokens, blob, perReading) {
    var ws = cardWords(title).filter(function (w, i, a) { return a.indexOf(w) === i; }); // "Mine … Mine" counts once
    var hit = ws.map(function (w) { return wordHit(w, tokens, blob); });
    // A 4-letter word with one wrong letter only counts when another word of the title was read
    // clearly in the same reading ("ROBEO DALE" is Rodeo Daze; "wary" here and "LONE" there isn't).
    hit = hit.map(function (h, i) {
      if (h !== 'weak') return h;
      return perReading.some(function (rt) {
        return wordHit(ws[i], rt) === 'weak' && ws.some(function (o, k) { return k !== i && !CARD_STOP[o] && o.length >= 4 && wordHit(o, rt) === 1; });
      }) ? 1 : 0;
    });
    var total = 0, got = 0, strong = false, words = 0, hits = 0;
    ws.forEach(function (w, i) {
      var stop = !!CARD_STOP[w], weight = stop ? 1 : w.length, credit = hit[i];
      total += weight;
      if (!stop) words++;
      if (credit >= 1 && !stop && w.length >= 4) strong = true;
      if (credit >= 0.5 && !stop) hits++;
      got += credit * weight;
    });
    // A title with two or more real words needs at least two of them; and one of them read cleanly.
    if (!total || !strong || hits < Math.min(2, words)) return 0;
    return got / total;
  }
  /**
   * Which listed episode a title card's text shows. texts: OCR readings of one card (several
   * versions of the frame). Returns { entry, score } or null if nothing is clearly it.
   */
  function matchCardText(texts, entries, near) {
    var all = (Array.isArray(texts) ? texts : [texts]);
    var s = all.map(squash).filter(function (x) { return x.length >= 3; });
    if (!s.length) return null;
    var tokens = [], seenTok = {};
    var perReading = all.map(function (x) { return cardWords(x).filter(function (w) { return w.length >= 2; }); });
    perReading.forEach(function (ws) { ws.forEach(function (w) { if (!seenTok[w]) { seenTok[w] = 1; tokens.push(w); } }); });
    var blob = s.join(' ');
    var scored = [];
    (entries || []).forEach(function (e) {
      if (e.number == null) return;
      var t = squash(e.name);
      if (t.length < 4) return;
      // Letters in a row, spaces ignored: only trusted when it's a near-perfect fit (long garbage can
      // otherwise look like a long title), else the word-by-word score decides.
      var sub = 0;
      s.forEach(function (x) {
        var d = fuzzyFind(t, x);
        var sc = 1 - d / t.length;
        if (t.length <= 5 && d > 0) sc = 0; // short titles ("Suds", "Texas") must be exact
        if (sc > sub) sub = sc;
      });
      // Titles near where this file should be are a small, likely pool: there the letters-in-a-row
      // score counts as before. Anywhere else the words themselves have to show up.
      var nearOne = near && near.indexOf(e) >= 0;
      var best = Math.max(sub >= 0.8 || nearOne ? sub : 0, wordScore(e.name, tokens, blob, perReading));
      scored.push({ entry: e, score: best });
    });
    scored.sort(function (a, b) { return b.score - a.score || squash(b.entry.name).length - squash(a.entry.name).length; });
    var top = scored[0], next = scored[1];
    if (!top) return null;
    // "Mermaid Man and Barnacle Boy" vs "... II": same words; prefer the one the text fits best,
    // but don't call it a win if a different title is about as good.
    var rival = next && squash(top.entry.name).indexOf(squash(next.entry.name)) < 0 && squash(next.entry.name).indexOf(squash(top.entry.name)) < 0 ? next : scored.filter(function (o) {
      return o !== top && squash(top.entry.name).indexOf(squash(o.entry.name)) < 0 && squash(o.entry.name).indexOf(squash(top.entry.name)) < 0;
    })[0];
    // Titles near where this file should be (by its number) need less; anywhere else, more.
    var isNear = near && near.indexOf(top.entry) >= 0;
    var long = squash(top.entry.name).length >= 10;
    var need = isNear ? (long ? 0.5 : 0.62) : (long ? 0.6 : 0.7);
    var margin = isNear ? 0.08 : 0.15;
    if (top.score < need) return null;
    if (rival && top.score - rival.score < margin && top.score < 0.9) return null;
    return { entry: top.entry, score: Math.round(top.score * 100) / 100 };
  }

  /**
   * Decide how files of one show+season are numbered: one number per cartoon ("segments"),
   * or one per half-hour ("halfhours", as on DVDs and streaming services).
   * files: parsed names of that season's files. Returns { mode, sure, segmented }.
   */
  function detectNumbering(files, list, season) {
    var entries = seasonEntries(list, season);
    if (!isSegmented(entries)) return { mode: 'segments', sure: true, segmented: false };
    var groups = halfHourGroups(entries);
    var half = 0, seg = 0, maxEp = 0;
    var eps = {};
    files.forEach(function (p) {
      if (p.numberFromTitle) return;
      if (p.episode) { maxEp = Math.max(maxEp, p.episodeEnd || p.episode); eps[p.episode] = 1; }
      if (!p.episodeTitle || !p.episode) return;
      var m = matchByTitle(p.episodeTitle, list, season);
      if (!m || m.season !== season) return;
      var first = m.entries[0];
      if (m.entries.length === 1 && first.number === p.episode && !p.episodeEnd) seg++;
      else if (groups[p.episode - 1] && groups[p.episode - 1].indexOf(first) >= 0) half++;
      else if (m.entries.length > 1 && first.number !== p.episode) half++;
    });
    if (half > seg) return { mode: 'halfhours', sure: true, segmented: true };
    if (seg > half) return { mode: 'segments', sure: true, segmented: true };
    if (maxEp > groups.length) return { mode: 'segments', sure: true, segmented: true };
    var count = Object.keys(eps).length;
    if (count >= Math.max(3, groups.length * 0.6)) return { mode: 'halfhours', sure: true, segmented: true };
    return { mode: 'segments', sure: false, segmented: true };
  }

  function joinNames(entries) {
    var names = entries.map(function (e) { return e.name; }).filter(Boolean);
    // "Pilot (1)" + "Pilot (2)" → "Pilot"
    var bases = names.map(function (n) { return n.replace(/\s*\(\d+\)$|,?\s*\(?Part\s*(\d+|One|Two|Three|I+)\)?$/i, '').trim(); });
    if (names.length > 1 && bases.every(function (b) { return b && b === bases[0]; })) return bases[0];
    return names.join(' & ');
  }

  /**
   * Which listed episode(s) this file is. ctx: { mode: 'segments'|'halfhours', sure }.
   * Returns { season, number, end, name, how: 'title'|'number'|'halfhour'|'date', sure, note } or null.
   */
  function resolveEpisode(parsed, list, ctx) {
    ctx = Object.assign({}, ctx || {});
    var cardAt = {}; // "1x6" → seconds into the video where that cartoon's title card shows
    var season = parsed.season != null ? parsed.season : 1;
    var file = ctx.file || {};
    // The video's own length settles "one cartoon or a half-hour" for this file.
    var hour = false;
    if (ctx.segmented && file.minutes) {
      ctx.mode = file.minutes <= 15 ? 'segments' : 'halfhours';
      hour = file.minutes > 36;
      ctx.sure = true;
    }
    var said = parsed.airdate ? parsed.airdate : 'S' + pad2(season) + 'E' + pad2(parsed.episode || 1) + (parsed.episodeEnd ? '-E' + pad2(parsed.episodeEnd) : '');
    function out(entries, how, sure, note) {
      var first = entries[0], last = entries[entries.length - 1];
      var r = { season: first.season, number: first.number, end: last.number > first.number ? last.number : null, name: joinNames(entries), how: how, sure: sure, note: note || '',
        // The cartoons in this file, in order (used to offer splitting it into one file each).
        entries: entries.map(function (e) { return { season: e.season, number: e.number, name: e.name, runtime: e.runtime || null, card: cardAt[e.season + 'x' + e.number] != null ? cardAt[e.season + 'x' + e.number] : null }; }) };
      var now = 'S' + pad2(r.season) + 'E' + pad2(r.number) + (r.end ? '-E' + pad2(r.end) : '');
      if (!r.note && now !== said && how !== 'date') r.note = 'The file said ' + said + '; it is really ' + now + (how === 'title' ? ' (matched by episode title)' : how === 'card' ? ' (read from its title cards)' : how === 'halfhour' ? ' (' + (hour ? 'an hour' : 'a half-hour') + ' holding ' + entries.length + ' cartoons)' : '') + '.';
      return r;
    }
    if (parsed.airdate) {
      var onDay = (list || []).filter(function (e) { return e.aired === parsed.airdate && e.number != null; });
      if (onDay.length) {
        var t = parsed.episodeTitle && matchByTitle(parsed.episodeTitle, onDay, onDay[0].season);
        return out(t ? t.entries : [onDay[0]], 'date', true);
      }
      return null;
    }
    var seasonList = seasonEntries(list, season);
    var groupsAll = halfHourGroups(seasonList);
    // Where the file's number points (used to judge title cards): its cartoon or half-hour.
    function expected() {
      var n0 = parsed.episode || 1;
      if (ctx.mode === 'halfhours') return [].concat(groupsAll[n0 - 1] || [], hour ? groupsAll[n0] || [] : []);
      return seasonList.filter(function (e) { return e.number === n0; });
    }
    // 0. Title cards read from the video beat everything else.
    if (file.cards && file.cards.length) {
      var exp = expected();
      var pool = (list || []).filter(function (e) { return e.number != null; });
      var near = seasonList.filter(function (e) { return exp.some(function (x) { return Math.abs(x.number - e.number) <= 6; }); });
      var best = {};
      file.cards.forEach(function (c) {
        var mm = matchCardText(c.texts, pool, near);
        if (mm && (!best[c.part] || mm.score > best[c.part].score)) best[c.part] = Object.assign({ t: c.t }, mm);
      });
      Object.keys(best).forEach(function (k) { if (best[k].t != null) cardAt[best[k].entry.season + 'x' + best[k].entry.number] = best[k].t; });
      var found = Object.keys(best).sort(function (a, b) { return a - b; }).map(function (k) { return best[k].entry; })
        .filter(function (e, i, arr) { return arr.indexOf(e) === i; })
        .sort(function (a, b) { return a.season - b.season || a.number - b.number; });
      if (found.length) {
        var parts = file.parts || found.length;
        var cnums = found.map(function (e) { return e.number; });
        var together = found.every(function (e) { return e.season === found[0].season; }) && cnums.every(function (x, i) { return i === 0 || x === cnums[i - 1] + 1; });
        // The half-hour these cartoons originally aired in, if they all belong to one.
        var g = halfHourGroups(seasonEntries(list, found[0].season)).filter(function (gg) { return found.every(function (e) { return gg.indexOf(e) >= 0; }); })[0];
        // One title card at the start, and none further in although Shelf looked there: one long
        // episode (a special like "SpongeBob's Last Stand"), not a half-hour with a second cartoon.
        var onlyFirst = found.length === 1 && Object.keys(best).join() === '0' && parts > 1 && file.cards.some(function (c) { return c.part >= 1; });
        if (onlyFirst) {
          var long1 = found[0].runtime && found[0].runtime >= 18;
          return out(found, 'card', !!long1, long1 ? '' : 'Shelf read one title card (' + found[0].name + ') and no second one further in, so this looks like one long episode. If it does hold a second cartoon, use Check Episodes to add it.');
        }
        if (g && g.length > found.length && (ctx.mode === 'halfhours' || parts > 1 || !together)) {
          // Only trust that guess if the file's own number points at the same half-hour.
          var agrees = exp.length && exp.every(function (e) { return g.indexOf(e) >= 0; });
          return out(g, 'card', !!agrees, 'Read ' + found.length + ' of ' + g.length + ' title cards (' + joinNames(found) + '); the rest is what aired with ' + (found.length === 1 ? 'it' : 'them') + '.' +
            (agrees ? '' : ' The file’s number points somewhere else, so check this one.'));
        }
        if (together) return out(found, 'card', true);
        var apart = out([found[0]], 'card', false, 'The title cards show episodes that aren’t next to each other (' + found.map(function (e) { return 'S' + pad2(e.season) + 'E' + pad2(e.number) + ' ' + e.name; }).join(', ') + '). Plex can only name a file as a run of episodes in a row, so split it into one file per cartoon below.');
        // In the order they play in the video.
        apart.entries = found.slice().sort(function (a, b) { return (cardAt[a.season + 'x' + a.number] || 0) - (cardAt[b.season + 'x' + b.number] || 0); })
          .map(function (e) { return { season: e.season, number: e.number, name: e.name, runtime: e.runtime || null, card: cardAt[e.season + 'x' + e.number] }; });
        apart.needsSplit = true;
        return apart;
      }
    }
    // 1. Titles beat numbers.
    if (parsed.episodeTitle) {
      var m = matchByTitle(parsed.episodeTitle, list, season);
      if (m && m.contiguous && ctx.mode === 'halfhours' && m.season === season && !parsed.numberFromTitle) {
        // Files here are half-hours: a title naming one cartoon means the whole half-hour it's in.
        var hg = halfHourGroups(seasonEntries(list, season)).filter(function (g) { return g.indexOf(m.entries[0]) >= 0; })[0];
        if (hg && m.entries.every(function (e) { return hg.indexOf(e) >= 0; })) return out(hg, 'title', true);
      }
      if (m && m.contiguous) return out(m.entries, 'title', true);
      if (m) return out([m.entries[0]], 'title', false, 'This file’s title matches episodes that aren’t next to each other (' + m.entries.map(function (e) { return 'E' + pad2(e.number); }).join(', ') + '). Check it.');
    }
    // 2. Numbers, read the way this show's files are numbered.
    var entries = seasonEntries(list, season);
    var n = parsed.episode || 1, end = parsed.episodeEnd || (hour ? n + 1 : n);
    if (ctx.mode === 'halfhours') {
      var groups = halfHourGroups(entries);
      var g1 = groups[n - 1], g2 = groups[end - 1] || g1;
      if (!g1) return null;
      return out(g1.concat(g2 === g1 ? [] : groups.slice(n, end).reduce(function (a, g) { return a.concat(g); }, [])), 'halfhour', ctx.sure !== false);
    }
    var a = entries.filter(function (e) { return e.number === n; })[0];
    if (!a) return null;
    var b = entries.filter(function (e) { return e.number === end; })[0] || a;
    var picked = entries.filter(function (e) { return e.number >= a.number && e.number <= b.number; });
    var r = out(picked, 'number', ctx.sure !== false);
    if (ctx.sure === false && !r.note) r.note = 'This show splits each half-hour into separate cartoons. Is this file one cartoon or a whole half-hour? Choose below.';
    return r;
  }


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
   * opts: { movieIds: bool, showYear: bool, quality: '1080p BluRay' (added to the file name only) }
   * Returns { folder: [..segments], file }
   */
  function plexName(parsed, match, opts) {
    opts = opts || {};
    var ext = parsed.ext;
    var subSuffix = '';
    if (parsed.isSubtitle) {
      subSuffix = (parsed.lang ? '.' + parsed.lang : '') + (parsed.subFlags.length ? '.' + parsed.subFlags.join('.') : '');
    }
    // Plex ignores text after " - " (e.g. "Pulp Fiction (1994) - 1080p.mkv"), so quality goes there.
    var q = opts.quality ? safeName(String(opts.quality).replace(/[{}\[\]()]/g, '')).slice(0, 40) : '';
    var qTag = q && q !== 'Unknown' ? ' - ' + q : '';
    if (match.type === 'movie') {
      var year = parseInt(match.year, 10);
      var name = safeName(match.title) + (year > 1800 ? ' (' + year + ')' : '');
      var tmdbId = parseInt(match.id, 10);
      var idTag = opts.movieIds && tmdbId > 0 ? ' {tmdb-' + tmdbId + '}' : '';
      return { folder: ['Movies', name + idTag], file: name + idTag + qTag + subSuffix + '.' + ext };
    }
    var showYear = parseInt(match.showYear, 10);
    var season = Math.max(0, parseInt(match.season, 10) || 0);
    var episode = Math.max(0, parseInt(match.episode, 10) || 0);
    var show = safeName(match.show) + (opts.showYear && showYear > 1800 ? ' (' + showYear + ')' : '');
    // {tmdb-387} / {tvdb-75886} in the show folder tells Plex exactly which show this is.
    var idTag = /^(tmdb|tvdb)-\d{1,9}$/.test(match.idTag || '') ? ' {' + match.idTag + '}' : '';
    var end = parseInt(match.episodeEnd, 10);
    var se = 'S' + pad2(season) + 'E' + pad2(episode) + (end > episode ? '-E' + pad2(end) : '');
    var ep = match.episodeTitle ? ' - ' + safeName(match.episodeTitle) : '';
    // For TV, Plex reads text after the episode number as a matching hint, unless it's in brackets.
    var tvQ = q && q !== 'Unknown' ? ' [' + q + ']' : '';
    return {
      folder: ['TV Shows', show + idTag, season === 0 ? 'Specials' : 'Season ' + pad2(season)],
      file: show + ' - ' + se + ep + tvQ + subSuffix + '.' + ext
    };
  }

  var api = {
    parseFilename: parseFilename,
    parsePath: parsePath,
    resolveEpisode: resolveEpisode,
    matchByTitle: matchByTitle,
    matchCardText: matchCardText,
    joinNames: joinNames,
    detectNumbering: detectNumbering,
    halfHourGroups: halfHourGroups,
    qualityLabel: qualityLabel,
    titleSimilarity: titleSimilarity,
    rankCandidates: rankCandidates,
    plexName: plexName,
    safeName: safeName,
    VIDEO_EXT: VIDEO_EXT,
    SUB_EXT: SUB_EXT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShelfParser = api;
})(this);
