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

  // Subtitle languages: [ISO 639-1 (what Plex reads), ISO 639-2/B, 639-2/T, English name, other common spellings].
  // Regional tags (pt-BR, es-419, zh-Hans, …) are read too and named with the base language, which is what
  // Plex recognises. ("hi" is left out on purpose: in subtitle names it nearly always means "hearing impaired".)
  var LANG_TABLE = [
    'en eng eng english', 'es spa spa spanish espanol castellano latino', 'fr fre fra french francais', 'de ger deu german deutsch',
    'it ita ita italian italiano', 'pt por por portuguese portugues pob pb ptbr', 'nl dut nld dutch nederlands flemish',
    'ja jpn jpn japanese', 'ko kor kor korean', 'zh chi zho chinese chs cht cmn yue mandarin cantonese', 'ru rus rus russian',
    'sv swe swe swedish', 'da dan dan danish', 'no nor nor norwegian nob nno', 'fi fin fin finnish', 'pl pol pol polish',
    'ar ara ara arabic', 'he heb heb hebrew', 'tr tur tur turkish', 'el gre ell greek', 'cs cze ces czech', 'sk slo slk slovak',
    'hu hun hun hungarian', 'ro rum ron romanian', 'bg bul bul bulgarian', 'hr hrv hrv croatian', 'sr srp srp serbian',
    'sl slv slv slovenian', 'uk ukr ukr ukrainian', 'et est est estonian', 'lv lav lav latvian', 'lt lit lit lithuanian',
    'is ice isl icelandic', 'ga gle gle irish', 'cy wel cym welsh', 'ca cat cat catalan', 'eu baq eus basque', 'gl glg glg galician',
    'th tha tha thai', 'vi vie vie vietnamese', 'id ind ind indonesian', 'ms may msa malay', 'tl tgl tgl tagalog filipino fil',
    'fa per fas persian farsi', 'ur urd urd urdu', 'bn ben ben bengali', 'ta tam tam tamil', 'te tel tel telugu', 'ml mal mal malayalam',
    'kn kan kan kannada', 'mr mar mar marathi', 'pa pan pan punjabi', 'gu guj guj gujarati', 'si sin sin sinhala', 'ne nep nep nepali',
    'hy arm hye armenian', 'ka geo kat georgian', 'az aze aze azerbaijani', 'kk kaz kaz kazakh', 'uz uzb uzb uzbek',
    'mk mac mkd macedonian', 'sq alb sqi albanian', 'bs bos bos bosnian', 'be bel bel belarusian', 'af afr afr afrikaans',
    'sw swa swa swahili', 'am amh amh amharic', 'km khm khm khmer', 'lo lao lao lao', 'my bur mya burmese', 'mn mon mon mongolian',
    'la lat lat latin', 'eo epo epo esperanto'
  ];
  // Two-letter codes that are also everyday English words at the end of a title ("…What.It.Is.srt") are
  // only read in their three-letter form.
  var LANG_AMBIGUOUS = { is: 1, be: 1, am: 1, my: 1, la: 1, id: 1 };
  var LANGS = {};
  LANG_TABLE.forEach(function (row) {
    var w = row.split(' ');
    w.forEach(function (k, i) { if (!LANGS[k] && !(i === 0 && LANG_AMBIGUOUS[k])) LANGS[k] = w[0]; });
  });
  // "pt-BR", "pt_br", "zh-Hans", "es-419", "en-US": the base language, if the base is one we know.
  function langOf(token) {
    var t = String(token || '').toLowerCase().replace(/_/g, '-');
    if (LANGS[t]) return LANGS[t];
    var m = /^([a-z]{2,3})-(?:[a-z]{2}|\d{3}|[a-z]{4})$/.exec(t);
    return m && LANGS[m[1]] ? LANGS[m[1]] : null;
  }
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

  /** A subtitle's name without its extension, minus ".en", ".forced", ".eng.sdh", ".pt-BR" at the end. */
  function peelSubtitle(base) {
    var lang = null, flags = [];
    for (var k = 0; k < 3; k++) {
      var dot = base.lastIndexOf('.');
      if (dot <= 0) break;
      var tok = base.slice(dot + 1).toLowerCase();
      if (!/^[a-z0-9_-]{2,12}$/.test(tok)) break;
      var lg = langOf(tok);
      if (lg && !lang) { lang = lg; base = base.slice(0, dot); continue; }
      if (SUB_FLAGS.indexOf(tok) >= 0) { flags.unshift(tok === 'hi' ? 'sdh' : tok); base = base.slice(0, dot); continue; }
      break;
    }
    return { base: base, lang: lang, flags: flags };
  }

  // ---- Editions and split movies (Plex: "{edition-Director's Cut}", "Movie (2008) - pt1") ----
  var ED_WORDS = "director'?s cut|directors cut|final cut|extended(?: (?:edition|cut|version))?|special edition|" +
    "ultimate (?:edition|cut)|unrated(?: (?:edition|cut|version))?|uncut|theatrical(?: (?:cut|edition|version))?|" +
    "imax(?: edition)?|collector'?s edition|\\d{1,3}(?:st|nd|rd|th) anniversary edition|anniversary edition|" +
    'criterion(?: collection| edition)?';
  var ED_TAIL = new RegExp('\\b(?:the )?(' + ED_WORDS + ')\\b', 'i');
  var ED_STRONG = /\b(director'?s cut|directors cut|(?:extended|special|ultimate|unrated|collector'?s|anniversary|imax) (?:edition|cut)|theatrical cut)\b/i;
  var PART_ANY = /\b(cd|disc|disk)[ ._-]?([1-9])\b/i;
  var PART_WORD = /\b(part|pt|cd|disc|disk)[ ._-]?([1-9])\b/i;
  function editionLabel(raw) {
    var t = String(raw).toLowerCase().replace(/\s+/g, ' ').trim()
      .replace(/^directors cut$/, "director's cut").replace(/^collectors edition$/, "collector's edition")
      .replace(/^criterion(?: collection| edition)?$/, 'criterion');
    return t.split(' ').map(function (w) { return w === 'imax' ? 'IMAX' : w.charAt(0).toUpperCase() + w.slice(1); }).join(' ').slice(0, 32);
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
      var peeled = peelSubtitle(base);
      base = peeled.base; lang = peeled.lang; subFlags = peeled.flags;
    }

    // An edition already written Plex's way: "Blade Runner (1982) {edition-Final Cut}".
    var edTag = /\{edition-([^}]{1,40})\}/i.exec(base);
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
    s = s.replace(/-[A-Za-z0-9]+$/, function (m) { return /\d{3,4}p/i.test(m) || /^-(dl|rip|ray|hd|e?\d{1,3}|s\d{1,2}e\d{1,3}|\d{1,2}x\d{2,3})$/i.test(m) ? m : ''; });

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
      // S01E02, S01 E02, S01E02E03, S01E02-03, S01E02 & S01E03, and half-hours split in a/b: S03E01a, S03E01aE01b, S03E03bE03a
      /\bS(\d{1,2})\s?[-.]?\s?E(\d{1,3})(?:[ab](?=[_\s.\-]|E\d|$))?(?:\s?-?\s?E(\d{1,3})(?:[ab](?=[_\s.\-]|$))?|-(\d{1,3})\b|\s?[-&+]\s?S\d{1,2}E(\d{1,3})|\s?[&+]\s?E(\d{1,3}))?(?:\b|(?=_))/i,
      // 1x02, 1x02-03, 1x02-1x03, 1x02 & 1x03, 1x02 - 1x03
      /\b(\d{1,2})x(\d{2,3})(?:-?(?:\d{1,2}x)?(\d{2,3})|\s?[&+]\s?(?:\d{1,2}x)?(\d{2,3})|\s-\s\d{1,2}x(\d{2,3}))?\b/i,
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
        var end = parseInt(m[3] || m[4] || m[5] || m[6], 10);
        if (end > result.episode && end - result.episode < 10) result.episodeEnd = end;
        // "S03E01aE01b": the name itself says the file holds two cartoons.
        if (t === 0 && /E\d{1,3}[ab]\s?-?\s?E\d{1,3}[ab]/i.test(m[0])) result.halves = 2;
        result.episodeTitle = titleCase(cleanSpaces(epJ.text));
        result.resolution = epJ.resolution || showJ.resolution;
        return result;
      }
    }

    // A season and no episode: "Show.S07.mkv", and the copies Windows makes of one name, "Show.S07 (3).mkv".
    // Which episode it is is left to its title cards, or to you. (That "(3)" only counts copies, so it isn't
    // read as the episode.)
    var so = /\bS(\d{1,2})\b(?:\s*\(\d{1,3}\))?/i.exec(s);
    if (so && so.index > 0 && /[a-z]/i.test(s.slice(0, so.index)) && !stripJunk(cleanSpaces(s.slice(so.index + so[0].length).replace(/[()\[\]]/g, ' '))).text) {
      var sShow = showPart(s.slice(0, so.index).replace(/[\s\-–]+$/, ''));
      var sRest = s.slice(so.index + so[0].length);
      setQuality(sRest);
      result.kind = 'episode';
      result.season = parseInt(so[1], 10);
      result.resolution = stripJunk(cleanSpaces(sRest.replace(/[()\[\]]/g, ' '))).resolution || sShow.resolution;
      return result;
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

    // Anime and other shows numbered from the first episode: "[SubsPlease] One Piece - 1085 (1080p)",
    // "Frieren - Beyond Journey's End - 05 [1080p]". The number is counted from the start of the show
    // and turned into a season and episode with the show's episode list (resolveEpisode).
    var am = /^(.+?)\s[-–]\s(\d{2,4})(?:v\d)?(?=\s*$|\s*[(\[]|\s+(?:\d{3,4}p|[-–]\s))/i.exec(s);
    if (am && !(am[2].length === 4 && /^(19[2-9]\d|20[0-4]\d)$/.test(am[2])) && /[a-z]/i.test(am[1])) {
      var aShow = showPart(am[1].replace(/[\s\-–]+$/, ''));
      var aRest = s.slice(am.index + am[0].length);
      setQuality(aRest);
      result.kind = 'episode';
      result.absolute = parseInt(am[2], 10);
      result.episode = result.absolute;
      result.resolution = stripJunk(cleanSpaces(aRest.replace(/[()\[\]]/g, ' '))).resolution || aShow.resolution;
      if (!result.resolution) { var arm = base.match(/(?:^|[^0-9])(2160|1080|720|576|480)p/i); if (arm) result.resolution = arm[1] + 'p'; }
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
    // Editions ("Final Cut", "Director's Cut", "Extended Edition") and parts of a split movie ("cd1", "pt2"),
    // so two versions of a film, or its two halves, never get the same name. After the year, the usual
    // words count; before it, only unmistakable ones ("The Final Cut" is also a film's title).
    result.edition = edTag ? cleanSpaces(edTag[1]).slice(0, 32) : null;
    var tail = lastYear ? s.slice(lastYear.index + 4) : '';
    var edAfter = lastYear && ED_TAIL.exec(tail);
    var edBefore = ED_STRONG.exec(lastYear ? s.slice(0, lastYear.index) : s);
    if (!result.edition && (edAfter || edBefore)) result.edition = editionLabel((edAfter || edBefore)[1]);
    if (edBefore) s = s.slice(0, edBefore.index) + ' ' + s.slice(edBefore.index + edBefore[0].length);
    // "cd1" / "disc 2" anywhere; "part2" / "pt.2" only after the year ("Deathly Hallows Part 1 (2010)" is a title).
    var pm = PART_ANY.exec(s), pAt = pm ? pm.index : -1;
    if (!pm && lastYear) {
      var pw = PART_WORD.exec(s.slice(lastYear.index + 4));
      if (pw) { pm = pw; pAt = lastYear.index + 4 + pw.index; }
    }
    if (pm) {
      var pk = pm[1].toLowerCase();
      result.part = (pk === 'disk' ? 'disc' : pk === 'part' ? 'pt' : pk) + parseInt(pm[2], 10);
      s = s.slice(0, pAt) + ' ' + s.slice(pAt + pm[0].length);
    }
    // (Find the year again: taking words out moved it.)
    if (edBefore || pm) {
      lastYear = null; yearRe.lastIndex = 0;
      while ((ym = yearRe.exec(s)) !== null) {
        var startIdx2 = ym.index + ym[0].indexOf(ym[1]);
        if (startIdx2 === 0) continue;
        lastYear = { year: parseInt(ym[1], 10), index: startIdx2 };
      }
    }
    titlePart = s;
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
  // ---- The same episode in more than one file ----
  // (A library where some half-hours are one file and some were split by hand, or a file copied twice.)
  // files: [{ remote, name, relPath: 'TV Shows/Show/Season 1/x.mkv', size }] from Fix My Plex Library.
  // Returns the groups of videos of one show that share an episode (and the ones sharing with those):
  // [{ show, season, eps: [1, 2], files: [{ remote, name, size, eps: [1, 2] }] }].
  function findDuplicates(files) {
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[{\[](?:tmdb|tvdb|imdb)-[^}\]]*[}\]]/g, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ''); };
    var vids = [];
    (files || []).forEach(function (f) {
      var segs = String(f.relPath || f.name || '').split('/');
      if (segs[0] !== 'TV Shows' || segs.length < 2) return;
      var p = parsePath(f.name || segs[segs.length - 1], segs.slice(1, -1));
      if (!p.isVideo || p.kind !== 'episode' || p.season == null || p.episode == null) return;
      var end = p.episodeEnd && p.episodeEnd > p.episode && p.episodeEnd - p.episode < 10 ? p.episodeEnd : p.episode;
      var eps = [];
      for (var n = p.episode; n <= end; n++) eps.push(n);
      vids.push({ f: f, show: norm(p.title) || norm(segs[1]), title: p.title || segs[1], season: p.season, eps: eps });
    });
    var parent = vids.map(function (v, i) { return i; });
    var root = function (i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    var owner = {};
    vids.forEach(function (v, i) {
      v.eps.forEach(function (n) { var k = v.show + '|' + v.season + '|' + n; if (k in owner) parent[root(i)] = root(owner[k]); else owner[k] = i; });
    });
    var by = {};
    vids.forEach(function (v, i) { var r = root(i); (by[r] = by[r] || []).push(v); });
    return Object.keys(by).map(function (k) { return by[k]; }).filter(function (g) { return g.length > 1; }).map(function (g) {
      var all = {};
      g.forEach(function (v) { v.eps.forEach(function (n) { all[n] = 1; }); });
      return {
        show: g[0].title, season: g[0].season, eps: Object.keys(all).map(Number).sort(function (a, b) { return a - b; }),
        files: g.map(function (v) { return { remote: v.f.remote, name: v.f.name, size: v.f.size || 0, eps: v.eps }; })
          .sort(function (a, b) { return a.eps[0] - b.eps[0] || b.eps.length - a.eps.length || String(a.name).localeCompare(String(b.name)); })
      };
    }).sort(function (a, b) { return String(a.show).localeCompare(String(b.show)) || a.season - b.season || a.eps[0] - b.eps[0]; });
  }
  // Which files of a group to keep: every episode once, as files holding more than one ('together') or one file
  // per episode ('separate'); of two copies of the same, the bigger. Returns their `remote`s.
  function keepFor(group, pref) {
    var order = group.files.slice().sort(function (a, b) {
      return (pref === 'separate' ? a.eps.length - b.eps.length : b.eps.length - a.eps.length) || b.size - a.size;
    });
    var have = {}, keep = [];
    var take = function (f) { keep.push(f.remote); f.eps.forEach(function (n) { have[n] = 1; }); };
    // First the ones that don't overlap what's kept; then, for anything still missing, the file adding least again.
    order.forEach(function (f) { if (f.eps.every(function (n) { return !have[n]; })) take(f); });
    group.eps.forEach(function (n) {
      if (have[n]) return;
      var best = order.filter(function (f) { return keep.indexOf(f.remote) < 0 && f.eps.indexOf(n) >= 0; })
        .sort(function (a, b) { return a.eps.filter(function (x) { return have[x]; }).length - b.eps.filter(function (x) { return have[x]; }).length; })[0];
      if (best) take(best);
    });
    return keep;
  }

  function parsePath(fileName, folders) {
    folders = (folders || []).filter(function (f) { return f && !/^[a-z]:$/i.test(f); });
    var r = parseFolders(fileName, folders);
    var ids = idsFor(fileName, folders, r);
    if (ids) r.ids = ids;
    return r;
  }

  // "Lost (2004) {tvdb-73739}", "The Matrix (1999) {tmdb-603}": the name already says exactly which
  // show or movie it is (Plex's own naming, and Shelf's). Looked for in the file name, then in the
  // show's folder (for an episode) or the folder the file sits in (for a movie).
  function idsIn(s) {
    var tm = /\{tmdb-(\d{1,9})\}/i.exec(s || ''), tv = /\{tvdb-(\d{1,9})\}/i.exec(s || ''), im = /\{imdb-(tt\d{7,9})\}/i.exec(s || '');
    if (!tm && !tv && !im) return null;
    var y = /\((19\d{2}|20\d{2})\)/.exec(s);
    var ids = { tmdb: tm ? parseInt(tm[1], 10) : null, tvdb: tv ? parseInt(tv[1], 10) : null, year: y ? parseInt(y[1], 10) : null };
    if (im) ids.imdb = im[1].toLowerCase();
    return ids;
  }
  function idsFor(fileName, folders, r) {
    if (!(r.isVideo || r.isSubtitle)) return null;
    var own = idsIn(fileName);
    if (own) return own;
    var dirs = folders.slice(-3);
    if (r.kind === 'episode') {
      while (dirs.length && SEASON_DIR.test(dirs[dirs.length - 1].trim())) dirs.pop();
    }
    return dirs.length ? idsIn(dirs[dirs.length - 1]) : null;
  }

  function parseFolders(fileName, folders) {
    var r = parseFilename(fileName);
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
      if (r.isSubtitle) base = peelSubtitle(base).base;
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
    // (A hyphen inside a word joins it: "Pre-Hibernation" and "Prehibernation" are the same title.)
    return ' ' + String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ').replace(/'/g, '').replace(/([a-z0-9])-(?=[a-z0-9])/g, '$1').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
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
  // Letters cartoon lettering is often misread as each other ("HeRmbidyAn" for "MeRmaidMan"): mixing
  // these up counts as half a mistake.
  var LOOKALIKE = {};
  ['mnhr', 'aeocu', 'bhdp', 'il1tj', 'yvu', 's5z', 'gq9', 'o0', 'wv', 'kx'].forEach(function (g) {
    for (var x = 0; x < g.length; x++) for (var y = 0; y < g.length; y++) if (x !== y) LOOKALIKE[g[x] + g[y]] = 1;
  });
  function subCost(a, b) { return a === b ? 0 : LOOKALIKE[a + b] ? 0.5 : 1; }
  // The same costs as a table of character codes (no strings made in the inner loops).
  var COST = new Float32Array(128 * 128).fill(1);
  for (var ci = 0; ci < 128; ci++) COST[ci * 128 + ci] = 0;
  Object.keys(LOOKALIKE).forEach(function (k) { COST[k.charCodeAt(0) * 128 + k.charCodeAt(1)] = 0.5; });
  function codes(s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); a[i] = c < 128 ? c : 127; } return a; }
  // Fewest edits to turn `t` into some stretch of `s` (approximate substring search).
  var fbPrev = new Float32Array(64), fbCur = new Float32Array(64);
  function fuzzyFind(t, s) {
    var n = t.length;
    if (n + 1 > fbPrev.length) { fbPrev = new Float32Array(n + 1); fbCur = new Float32Array(n + 1); }
    var tc = codes(t), prev = fbPrev, cur = fbCur, best = n;
    for (var i = 0; i <= n; i++) prev[i] = i;
    for (var j = 0; j < s.length; j++) {
      var sj = s.charCodeAt(j); if (sj > 127) sj = 127;
      cur[0] = 0; // a match may start anywhere in s
      for (var k = 1; k <= n; k++) {
        var a = prev[k] + 1, b = cur[k - 1] + 1, c = prev[k - 1] + COST[tc[k - 1] * 128 + sj];
        cur[k] = a < b ? (a < c ? a : c) : (b < c ? b : c);
      }
      if (cur[n] < best) best = cur[n];
      var tmp = prev; prev = cur; cur = tmp;
    }
    return best;
  }
  // Words of a title or a reading, lower-case, without accents or apostrophes ("SpongeBob's" → "spongebobs").
  function cardWords(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/['’`]/g, '')
      .split(/[^a-z0-9]+/).filter(Boolean);
  }
  var edCache = new Map();
  function editDist(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    if (a === b) return 0;
    var key = a + '|' + b + '|' + cap, hitd = edCache.get(key);
    if (hitd !== undefined) return hitd;
    var prev = new Float32Array(b.length + 1), cur = new Float32Array(b.length + 1), out;
    for (var i = 0; i <= b.length; i++) prev[i] = i;
    for (var x = 1; x <= a.length && out === undefined; x++) {
      cur[0] = x; var low = x, ax = a.charCodeAt(x - 1); if (ax > 127) ax = 127;
      for (var y = 1; y <= b.length; y++) {
        var by = b.charCodeAt(y - 1); if (by > 127) by = 127;
        var p = prev[y] + 1, q = cur[y - 1] + 1, r = prev[y - 1] + COST[ax * 128 + by];
        cur[y] = p < q ? (p < r ? p : r) : (q < r ? q : r);
        if (cur[y] < low) low = cur[y];
      }
      if (low > cap) out = cap + 1;
      var tmp = prev; prev = cur; cur = tmp;
    }
    if (out === undefined) out = prev[b.length];
    if (edCache.size > 200000) edCache.clear();
    edCache.set(key, out);
    return out;
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
  // Read cleanly: exactly, or (5+ letters) with a single slip. Every match needs one such word.
  function cleanHit(w, tokens) {
    if (tokens.indexOf(w) >= 0) return true;
    return w.length >= 5 && tokens.some(function (t) { return Math.abs(t.length - w.length) <= 1 && editDist(w, t, 1) <= 1; });
  }
  // How much of a title's words appear in what was read. Readings of the same frame are pooled: one
  // version may catch "SPONGEBOB'S", another "LAST", another "STAND".
  function wordScore(title, tokens, blob, perReading) {
    var ws = cardWords(title).filter(function (w, i, a) { return a.indexOf(w) === i; }); // "Mine … Mine" counts once
    var hit = ws.map(function (w) { return wordHit(w, tokens, blob); });
    // A title with only one short real word ("Not Normal", "Pickles") rests on that word alone,
    // so it has to be read nearly right: at most one slip. (Long words are evidence enough.)
    var real = ws.filter(function (w) { return !CARD_STOP[w]; });
    // A one-word title must stand out: read in a short, clean reading (the title on its own), or in
    // at least two versions of the frame. Inside a jumble ("Gone a A rr RS \ - LIN — ER") it's chance.
    if (real.length === 1) {
      var w1 = real[0], j1 = ws.indexOf(w1);
      var homes = perReading.filter(function (rt) { var h = wordHit(w1, rt); return h === 1 || h === 'weak' || h >= 0.5; });
      var alone = homes.some(function (rt) { return rt.length <= 3; });
      if (!alone && homes.length < 2) hit[j1] = 0;
      // ...and even a long one-word title allows only about one slip per four letters.
      else if (w1.length >= 9 && !tokens.some(function (t) { var cap1 = Math.floor(w1.length / 4); return Math.abs(t.length - w1.length) <= cap1 && editDist(w1, t, cap1) <= cap1; })) hit[j1] = 0;
    }
    if (real.length === 1 && real[0].length <= 8) {
      var only = real[0], i0 = ws.indexOf(only);
      var close = only.length <= 5 ? hit[i0] : tokens.some(function (t) { return Math.abs(t.length - only.length) <= 1 && editDist(only, t, 1) <= 1; }) || fuzzyFind(only, blob) <= 1;
      if (!close || close === 'weak') hit[i0] = 0;
    }
    // A 4-letter word with one wrong letter only counts when another word of the title was read
    // clearly in the same reading ("ROBEO DALE" is Rodeo Daze; "wary" here and "LONE" there isn't).
    hit = hit.map(function (h, i) {
      if (h !== 'weak') return h;
      return perReading.some(function (rt) {
        return wordHit(ws[i], rt) === 'weak' && ws.some(function (o, k) { return k !== i && !CARD_STOP[o] && o.length >= 4 && cleanHit(o, rt); });
      }) ? 1 : 0;
    });
    // One word read can only stand for one word of the title ("Might" can't be both "Night" and "Light").
    var used = {};
    ws.map(function (w, i) { return i; }).sort(function (x, y) { return ws[y].length - ws[x].length; }).forEach(function (i) {
      if (!(hit[i] >= 0.5) || CARD_STOP[ws[i]]) return;
      var w = ws[i], cap = w.length <= 5 ? 1 : w.length <= 8 ? 2 : 3;
      var mine = tokens.filter(function (t) { return Math.abs(t.length - w.length) <= cap && editDist(w, t, cap) <= cap; });
      if (!mine.length) return; // found inside run-together text: nothing to share
      var free = mine.filter(function (t) { return !used[t]; });
      if (!free.length) { hit[i] = 0; return; }
      free.sort(function (x, y) { return editDist(w, x, cap) - editDist(w, y, cap); });
      used[free[0]] = 1;
    });
    var total = 0, got = 0, strong = false, words = 0, hits = 0;
    ws.forEach(function (w, i) {
      var stop = !!CARD_STOP[w], weight = stop ? 1 : w.length, credit = hit[i];
      total += weight;
      if (!stop) words++;
      if (credit >= 1 && !stop && w.length >= 4 && (cleanHit(w, tokens) || ws.length === 1 || w.length >= 9)) strong = true;
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
  // The answer never changes for the same readings and the same list, and working it out is the
  // slowest thing Shelf does on this computer's processor, so each answer is kept (by content).
  var listKeys = new WeakMap(), cardMemo = new Map();
  function listKey(arr) {
    if (!arr) return '';
    var k = listKeys.get(arr);
    if (k === undefined) { k = arr.map(function (e) { return e.season + 'x' + e.number + ':' + e.name; }).join('\u0001'); listKeys.set(arr, k); }
    return k;
  }
  // show: the show's own name, whose logo (at the end of the theme song) is no episode's title card.
  function matchCardText(texts, entries, near, show) {
    var key = JSON.stringify(texts) + '\u0002' + listKey(entries || []) + '\u0002' + (near ? listKey(near) : '-') + '\u0002' + (show || '');
    if (cardMemo.has(key)) {
      var hit = cardMemo.get(key);
      return hit && { entry: entries[hit.i], score: hit.score };
    }
    var res = matchCardTextNow(texts, entries, near);
    // "SpongeBob SquarePants" on the logo is one letter-pair away from the episode "SpongeBob SpareParts": a
    // reading that fits the show's name at least as well as the title is the logo, not that episode's card.
    if (res && show && titleSimilarity(res.entry.name, show) >= 0.6) {
      var fit = function (name) {
        var t = squash(name);
        return Math.min.apply(null, (Array.isArray(texts) ? texts : [texts]).map(function (x) { return fuzzyFind(t, squash(x)) / t.length; }).concat([1]));
      };
      if (fit(show) <= fit(res.entry.name)) res = null;
    }
    if (cardMemo.size > 5000) cardMemo.clear();
    cardMemo.set(key, res && { i: entries.indexOf(res.entry), score: res.score });
    return res;
  }
  function matchCardTextNow(texts, entries, near) {
    var all = (Array.isArray(texts) ? texts : [texts]);
    // A title card reads as a few words. A busy picture reads as a long jumble, and the more
    // jumble there is, the easier it is for a title to "appear" by chance. So long readings only
    // count for long words read exactly; the looser comparisons use the short readings.
    var noisy = function (x) { return cardWords(x).length > 14; };
    var clean = all.filter(function (x) { return !noisy(x); });
    var s = clean.map(squash).filter(function (x) { return x.length >= 3; });
    var tokens = [], seenTok = {};
    var perReading = clean.map(function (x) { return cardWords(x).filter(function (w) { return w.length >= 2; }); });
    perReading.forEach(function (ws) { ws.forEach(function (w) { if (!seenTok[w]) { seenTok[w] = 1; tokens.push(w); } }); });
    all.filter(noisy).forEach(function (x) { cardWords(x).forEach(function (w) { if (w.length >= 6 && !seenTok[w]) { seenTok[w] = 1; tokens.push(w); } }); });
    if (!s.length && !tokens.length) return null;
    var blob = s.join(' ');
    var scored = [];
    (entries || []).forEach(function (e) {
      if (e.number == null) return;
      // "Legends of Bikini Bottom: The Main Drain": the card shows only the part after the colon, so that
      // part counts on its own too (when it's specific enough to).
      var names = [e.name], ci = e.name.indexOf(': ');
      if (ci > 0 && squash(e.name.slice(ci + 2)).length >= 8) names.push(e.name.slice(ci + 2));
      var top1 = null;
      names.forEach(function (name) {
        var t = squash(name);
        if (t.length < 4) return;
        // Letters in a row, spaces ignored: only trusted when it's a near-perfect fit (long garbage can
        // otherwise look like a long title), else the word-by-word score decides.
        var sub = 0;
        // A one-word title only counts letter-for-letter in a short reading that's little more than the title
        // ("porters, + old" holds "sold" only by running two words together).
        var oneWord = cardWords(name).filter(function (w) { return !CARD_STOP[w]; }).length === 1;
        (oneWord ? clean.filter(function (x) { return cardWords(x).length <= 3; }).map(squash).filter(function (x) { return x.length <= t.length + Math.max(2, Math.round(t.length * 0.3)); }) : s).forEach(function (x) {
          var d = fuzzyFind(t, x);
          var sc = 1 - d / t.length;
          if (t.length <= 5 && d > 0) sc = 0; // short titles ("Suds", "Texas") must be exact
          if (sc > sub) sub = sc;
        });
        // Titles near where this file should be are a small, likely pool: there the letters-in-a-row
        // score counts as before. Anywhere else the words themselves have to show up.
        var nearOne = near && near.indexOf(e) >= 0;
        var ws = wordScore(name, tokens, blob, perReading);
        // Two weaker signs together: some words show up, and the whole title is close letter for
        // letter ("MeR mid WAN BaRanclEboy TV" ≈ "Mermaid Man and Barnacle Boy IV").
        var best = Math.max(sub >= 0.8 || nearOne || (ws > 0 && sub >= 0.7) ? sub : 0, ws);
        if (!top1 || best > top1.score) top1 = { entry: e, score: best, ws: ws };
      });
      if (top1) scored.push(top1);
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
    // Only a loose letter-for-letter likeness, and not one of the title's words seen: needs more
    // ("ae So ZENON ~¥) 0) TC" is not "As Seen on TV").
    if (!top.ws && isNear) need = Math.max(need, 0.6);
    if (top.score < need) return null;
    if (rival && top.score - rival.score < margin && top.score < 0.9) return null;
    // Another title shares most of the words ("The Battle of Bikini Bottom", "The Curse of Bikini Bottom"): the
    // word that tells them apart has to be read cleanly, not just guessed from a near miss ("BetTo").
    if (rival && rival.score >= 0.5) {
      var theirs = cardWords(rival.entry.name), own = cardWords(top.entry.name).filter(function (w) { return !CARD_STOP[w] && theirs.indexOf(w) < 0; });
      if (own.length && own.length < cardWords(top.entry.name).filter(function (w) { return !CARD_STOP[w]; }).length &&
        !own.some(function (w) { return cleanHit(w, tokens); })) return null;
    }
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
    return lengthDoubt(resolveFrom(parsed, list, ctx), ctx || {});
  }
  // A video much longer than what it was matched to, with no title card to back the match, is worth a
  // look: a half-hour file holding "one 11-minute cartoon", or a 45-minute file holding one 22-minute
  // episode, more likely holds another episode too, or is a different one altogether. (Only when the
  // video's length is known, after Check Lengths or Read Title Cards, and the list gives every episode's length.)
  function lengthDoubt(r, ctx) {
    var mins = ctx.file && ctx.file.minutes, es = r && r.entries;
    if (!r || !r.sure || !mins || r.how === 'card' || !es || !es.length || es.some(function (e) { return !e.runtime; })) return r;
    var listed = es.reduce(function (t, e) { return t + e.runtime; }, 0);
    var loneCartoon = es.length === 1 && listed <= 15 && mins >= 20;
    if (!loneCartoon && !(mins >= listed * 1.5 && mins - listed >= 10)) return r;
    var what = 'S' + pad2(r.season) + 'E' + pad2(r.number) + (r.end ? '-E' + pad2(r.end) : '') + ' “' + r.name + '”';
    r.sure = false;
    r.note = 'This video is ' + Math.round(mins) + ' minutes long, but ' + what + ' ' + (es.length === 1 ? 'is' : 'are') + ' listed at ' +
      listed + ' minutes. It may hold another episode too, or be a different one.';
    return r;
  }
  function resolveFrom(parsed, list, ctx) {
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
    // "Show.S07 (3).mkv": the name gives the season and no episode.
    var noNumber = parsed.episode == null && !parsed.airdate;
    var said = parsed.airdate ? parsed.airdate : noNumber ? 'season ' + season : 'S' + pad2(season) + 'E' + pad2(parsed.episode || 1) + (parsed.episodeEnd ? '-E' + pad2(parsed.episodeEnd) : '');
    function out(entries, how, sure, note) {
      var first = entries[0], last = entries[entries.length - 1];
      var r = { season: first.season, number: first.number, end: last.number > first.number ? last.number : null, name: joinNames(entries), how: how, sure: sure, note: note || '',
        // The cartoons in this file, in order (used to offer splitting it into one file each).
        entries: entries.map(function (e) { return { season: e.season, number: e.number, name: e.name, runtime: e.runtime || null, card: cardAt[e.season + 'x' + e.number] != null ? cardAt[e.season + 'x' + e.number] : null }; }) };
      var now = 'S' + pad2(r.season) + 'E' + pad2(r.number) + (r.end ? '-E' + pad2(r.end) : '');
      // A title card from another season than the name says (one the list has): a misnamed file is usually off by a
      // few episodes, not seasons, so that's likelier text on screen ("THE SAN FRANCISCO" in a 2003 Mythbusters).
      // A question, then, not an answer.
      if (how === 'card' && r.sure && !noNumber && !parsed.airdate && r.season !== season &&
        (list || []).some(function (e) { return e.season === season && e.number != null; })) {
        r.sure = false;
        r.note = 'A title card reads as ' + now + ' (' + r.name + '), but the file’s name says ' + said + '. Check which it is.';
      }
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
    // Counted from the show's first episode ("One Piece - 1085"): the Nth episode of the regular seasons.
    if (parsed.absolute && parsed.season == null) {
      var ordered = (list || []).filter(function (e) { return e.season >= 1 && e.number != null; })
        .sort(function (a, b) { return a.season - b.season || a.number - b.number; });
      var nth = ordered[parsed.absolute - 1];
      if (!nth) return null;
      var abs = out([nth], 'absolute', true);
      abs.note = nth.season === 1 && nth.number === parsed.absolute ? '' : 'Episode ' + parsed.absolute + ', counted from the start of the show.';
      return abs;
    }
    var seasonList = seasonEntries(list, season);
    var groupsAll = halfHourGroups(seasonList);
    // Where the file's number points (used to judge title cards): its cartoon or half-hour.
    function expected() {
      if (noNumber) return [];
      var n0 = parsed.episode || 1;
      if (ctx.mode === 'halfhours') return [].concat(groupsAll[n0 - 1] || [], hour ? groupsAll[n0] || [] : []);
      return seasonList.filter(function (e) { return e.number === n0; });
    }
    // 0. Title cards read from the video beat everything else.
    if (file.cards && file.cards.length) {
      var exp = expected();
      var pool = (list || []).filter(function (e) { return e.number != null; });
      var best = {};
      // Title cards you marked yourself each count on their own, and a reading near one (within two
      // minutes: two cartoons' cards are ~11 minutes apart) gives way to it.
      var marks = file.cards.filter(function (c) { return c.mark; });
      var cardsIn = file.cards.filter(function (c) { return c.mark || !marks.some(function (m) { return c.t != null && Math.abs(c.t - m.t) < 120; }); });
      // A weaker reading is enough for an episode near where this file points: its number read either way
      // (the cartoon, or the half-hour), and the cartoons next to a card read clearly or marked in the same
      // video. (Reading the video allowed the same, so a card it stopped at is never thrown away here.)
      var anchors = exp.concat(noNumber ? [] : seasonList.filter(function (e) { return e.number === (parsed.episode || 1); }));
      cardsIn.forEach(function (c) {
        var a0 = c.mark ? c.mark : (matchCardText(c.texts, pool, null, ctx.show || parsed.title) || {}).entry;
        if (a0) anchors.push(a0);
      });
      var near = seasonList.filter(function (e) { return anchors.some(function (x) { return x.season === e.season && Math.abs(x.number - e.number) <= 6; }); });
      cardsIn.forEach(function (c, ci) {
        // A title card you marked yourself: no reading needed, and it beats anything Shelf read.
        var mm = c.mark ? pool.filter(function (e) { return e.season === c.mark.season && e.number === c.mark.number; }).map(function (e) { return { entry: e, score: 2 }; })[0] || null
          : matchCardText(c.texts, pool, near, ctx.show || parsed.title);
        var slot = c.mark ? 'm' + ci : c.part;
        if (mm && (!best[slot] || mm.score > best[slot].score)) best[slot] = Object.assign({ t: c.t }, mm);
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
        var onlyFirst = found.length === 1 && Object.keys(best).join() === '0' && file.parts > 1 &&
          // ...and the file's name doesn't say there are two ("S03E01aE01b", "S01E01-E02")...
          !parsed.halves && !parsed.episodeEnd &&
          // ...unless Shelf saw another cartoon start further in (a card between two black fades,
          // or its opening credits).
          !cardsIn.some(function (c) { return c.part >= 1 && c.boundary; });
        if (onlyFirst) {
          var long1 = found[0].runtime && found[0].runtime >= 18;
          return out(found, 'card', !!long1, long1 ? '' : 'Shelf read one title card (' + found[0].name + ') and no second one further in, so this looks like one long episode. If it does hold a second cartoon, use Check Episodes to add it.');
        }
        // Only a later cartoon's card was read, and nothing listed aired with it: something comes before it in the
        // file (a first cartoon whose card couldn't be read), so it can't be the whole file.
        if (found.length === 1 && best[0] == null && !marks.length && (file.parts || 1) > 1 && !(g && g.length > 1)) {
          return out(found, 'card', false, 'Shelf read the title card of a later cartoon (' + found[0].name + ') but not the first one. Use Check Episodes to add it, or pick it in the file’s details.');
        }
        if (g && g.length > found.length && (ctx.mode === 'halfhours' || parts > 1 || !together)) {
          // Only trust that guess if the file's own number points at the same half-hour.
          var agrees = exp.length && exp.every(function (e) { return g.indexOf(e) >= 0; });
          return out(g, 'card', !!agrees, 'Read ' + found.length + ' of ' + g.length + ' title cards (' + joinNames(found) + '); the rest is what aired with ' + (found.length === 1 ? 'it' : 'them') + '.' +
            (agrees ? '' : noNumber ? ' Check the rest.' : ' The file’s number points somewhere else, so check this one.'));
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
    // 2. Numbers, read the way this show's files are numbered. (No number, and no title card read: no guess.)
    if (noNumber) return null;
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
    if (ctx.sure === false && !r.note) r.note = 'This show splits each half-hour into separate cartoons. Is this file one cartoon or a whole half-hour? Answer on the show’s shelf, at the top of its files.';
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
      // Plex's edition tag goes on the folder and the file; a split movie's part ends the name
      // ("… - pt1"), and then the quality is left out so the part stays the last thing Plex reads.
      var edition = opts.edition !== undefined ? opts.edition : parsed.edition;
      edition = edition ? safeName(String(edition).replace(/[{}\[\]]/g, '')).slice(0, 32).replace(/[. ]+$/, '') : '';
      var edTag = edition && edition !== 'Unknown' ? ' {edition-' + edition + '}' : '';
      var part = opts.part !== undefined ? opts.part : parsed.part;
      var partTag = /^(cd|disc|dvd|pt)[1-9]$/.test(part || '') ? ' - ' + part : '';
      return { folder: ['Movies', name + idTag + edTag], file: name + idTag + edTag + (partTag || qTag) + subSuffix + '.' + ext };
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
    findDuplicates: findDuplicates,
    keepFor: keepFor,
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
    subtitleStem: function (base) { return peelSubtitle(String(base || '')).base; },
    VIDEO_EXT: VIDEO_EXT,
    SUB_EXT: SUB_EXT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShelfParser = api;
})(this);
