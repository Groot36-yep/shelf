// Tests for the 2.2 fixes: editions and split movies, subtitle languages, anime numbering, IMDb ids,
// renames that only change capital letters, links out of the library, and undo of those.
// Run with: node tests/fixes.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../app/js/parser.js');
const F = require('../desktop/fileops.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('FAIL', m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

// ---- Editions ----
const movie = (title, year, id) => ({ type: 'movie', title, year, id });
let r = P.parseFilename('Blade.Runner.1982.The.Final.Cut.2160p.UHD.BluRay.mkv');
eq([r.title, r.year, r.edition], ['Blade Runner', 1982, 'Final Cut'], 'edition after the year');
eq(P.plexName(r, movie('Blade Runner', 1982, 78), {}).file, 'Blade Runner (1982) {edition-Final Cut}.mkv', 'edition in the file name');
eq(P.plexName(r, movie('Blade Runner', 1982, 78), {}).folder, ['Movies', 'Blade Runner (1982) {edition-Final Cut}'], 'edition in the folder');
eq(P.plexName(P.parseFilename('Blade.Runner.1982.2160p.mkv'), movie('Blade Runner', 1982, 78), {}).file, 'Blade Runner (1982).mkv', 'no edition: plain name (the two versions no longer collide)');
r = P.parseFilename('Aliens.Directors.Cut.1986.1080p.mkv');
eq([r.title, r.year, r.edition], ['Aliens', 1986, "Director's Cut"], 'edition before the year');
eq(P.parseFilename('Blade Runner (1982) {edition-Final Cut}.mkv').edition, 'Final Cut', 'edition already in Plex form');
eq(P.parseFilename('The.Lord.of.the.Rings.2001.Extended.Edition.1080p.mkv').edition, 'Extended Edition', 'extended edition');
eq([P.parseFilename('The.Final.Cut.2004.mkv').title, P.parseFilename('The.Final.Cut.2004.mkv').edition], ['The Final Cut', null], '"The Final Cut" (2004) is a title, not an edition');
eq([P.parseFilename('Uncut.Gems.2019.mkv').title, P.parseFilename('Uncut.Gems.2019.mkv').edition], ['Uncut Gems', null], '"Uncut Gems" is a title');
eq(P.parseFilename('Heat.1995.REMASTERED.1080p.mkv').edition, null, 'remastered is not an edition');
r = P.parseFilename('Blade.Runner.1982.The.Final.Cut.en.forced.srt');
eq(P.plexName(r, movie('Blade Runner', 1982, 78), {}).file, 'Blade Runner (1982) {edition-Final Cut}.en.forced.srt', 'subtitle follows the edition');

// ---- Split movies ----
r = P.parseFilename('Kill.Bill.Vol.1.2003.cd2.avi');
eq([r.year, r.part], [2003, 'cd2'], 'cd2');
eq(P.plexName(r, movie('Kill Bill: Vol. 1', 2003, 24), { quality: '1080p' }).file, 'Kill Bill - Vol. 1 (2003) - cd2.avi', 'part ends the name (quality left out)');
eq(P.parseFilename('Movie.Name.2010.part2.mkv').part, 'pt2', 'part2 after the year');
r = P.parseFilename('Harry.Potter.and.the.Deathly.Hallows.Part.1.2010.mkv');
ok(!r.part && /Part/.test(r.title), '"Part 1" before the year stays in the title (' + r.title + ')');

// ---- Subtitle languages ----
r = P.parseFilename('Show.S01E01.pt-BR.srt');
eq([r.lang, r.episodeTitle], ['pt', ''], 'pt-BR is Portuguese and no longer becomes the episode title');
eq(P.parseFilename('Show.S01E01.chs.ass').lang, 'zh', 'chs is Chinese');
eq(P.parseFilename('Movie.2019.zh-Hans.forced.srt').lang, 'zh', 'zh-Hans + forced');
eq(P.parseFilename('Movie.2019.pt_br.srt').lang, 'pt', 'pt_br');
eq(P.parseFilename('Movie.2019.tur.srt').lang, 'tr', 'Turkish');
eq(P.parseFilename('Movie.2019.en.hi.srt').subFlags, ['sdh'], '"hi" still means hearing impaired');
eq(P.parseFilename('Movie.What.It.Is.srt').lang, null, '"Is" at the end of a title is not Icelandic');
eq(P.subtitleStem('Film.2019.pt-BR.forced'), 'Film.2019', 'subtitle stem (links it to its video)');
eq(P.plexName(P.parseFilename('Show.S01E01.pt-BR.srt'), { type: 'episode', show: 'Show', season: 1, episode: 1, episodeTitle: 'Pilot' }, {}).file, 'Show - S01E01 - Pilot.pt.srt', 'subtitle named with the language Plex reads');

// ---- Anime: numbered from the first episode ----
r = P.parseFilename('[SubsPlease] One Piece - 1085 (1080p) [ABCD1234].mkv');
eq([r.kind, r.title, r.absolute, r.resolution], ['episode', 'One Piece', 1085, '1080p'], 'fansub absolute number');
r = P.parseFilename("Frieren - Beyond Journey's End - 05 [1080p].mkv");
eq([r.kind, r.absolute], ['episode', 5], '"Title - 05"');
eq(P.parseFilename('Mission.Impossible.-.Fallout.2018.mkv').kind, 'movie', 'a movie with a dash stays a movie');
eq(P.parseFilename('Show - 2019 [1080p].mkv').absolute, undefined, 'a year is never an episode number');
const list = [];
for (let s = 0; s <= 3; s++) for (let e = 1; e <= 10; e++) list.push({ season: s, number: e, name: 'E' + s + '.' + e });
const abs = P.resolveEpisode(P.parseFilename('[Grp] Show - 25 [1080p].mkv'), list, {});
eq([abs.season, abs.number, abs.how], [3, 5, 'absolute'], 'episode 25 = S03E05 (specials not counted)');
eq(P.resolveEpisode(P.parseFilename('[Grp] Show - 99 [1080p].mkv'), list, {}), null, 'past the end: no guess');

// ---- IMDb ids ----
eq(P.parsePath('The Matrix (1999) {imdb-tt0133093}.mkv', []).ids, { tmdb: null, tvdb: null, year: 1999, imdb: 'tt0133093' }, 'imdb id in the name');
eq(P.parsePath('x.mkv', ['Movies', 'The Matrix (1999) {imdb-tt0133093}']).ids.imdb, 'tt0133093', 'imdb id in the folder');

// ---- File engine ----
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-fix-'));
  const lib = path.join(root, 'Plex');
  const dir = path.join(lib, 'Movies', 'The Matrix (1999)');
  fs.mkdirSync(dir, { recursive: true });

  // Only the capital letters change. Linux tells the two names apart, so stand in for Windows/macOS
  // with a second name for the same file (a hard link), which is exactly what those systems report.
  const lower = path.join(dir, 'the matrix (1999).mkv'), upper = path.join(dir, 'The Matrix (1999).mkv');
  fs.writeFileSync(lower, 'MATRIX');
  fs.linkSync(lower, upper);
  ok(await F.sameFileOtherCase(lower, upper), 'same file under another spelling is recognised');
  ok(!(await F.sameFileOtherCase(lower, path.join(dir, 'Other.mkv'))), 'a different name is not');
  const journal = path.join(root, 'j1.json');
  let res = (await F.run([{ source: lower, folder: ['Movies', 'The Matrix (1999)'], file: 'The Matrix (1999).mkv' }],
    { library: lib, mode: 'move', allowed: new Set([lower]), journalPath: journal })).results[0];
  ok(res.ok && !res.skipped, 'case-only rename goes ahead (' + (res.skipped || res.error || 'ok') + ')');
  ok(fs.existsSync(upper) && !fs.existsSync(lower) && fs.readFileSync(upper, 'utf8') === 'MATRIX', 'file now has the new capitals');
  ok(!fs.readdirSync(dir).some((n) => n.startsWith('.shelf-case-')), 'no temporary name left behind');
  const j = JSON.parse(fs.readFileSync(journal, 'utf8'));
  ok(j.done[0].caseOnly === true, 'journal marks it as a capitals-only change');
  // Copy and hard link modes leave it alone: it's already there.
  fs.linkSync(upper, lower);
  res = (await F.run([{ source: lower, folder: ['Movies', 'The Matrix (1999)'], file: 'The Matrix (1999).mkv' }],
    { library: lib, mode: 'copy', allowed: new Set([lower]), journalPath: path.join(root, 'j2.json') })).results[0];
  eq(res.skipped, 'Already in your library', 'copy of a file onto itself is skipped');
  fs.unlinkSync(lower);
  // Undo a capitals-only change (on Linux, after undo the old spelling is back and the new one gone).
  fs.linkSync(upper, lower); // stand-in again: both spellings name one file
  const u = await F.undo(journal);
  ok(u.undone === 1 && fs.existsSync(lower), 'undo puts the old capitals back');

  // A link inside the library that points outside it: nothing is written through it.
  const outside = path.join(root, 'Elsewhere');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(lib, 'TV Shows'), 'dir');
  const src = path.join(root, 'show.s01e01.mkv');
  fs.writeFileSync(src, 'EP');
  res = (await F.run([{ source: src, folder: ['TV Shows', 'Show', 'Season 01'], file: 'Show - S01E01.mkv' }],
    { library: lib, mode: 'move', allowed: new Set([src]), journalPath: path.join(root, 'j3.json') })).results[0];
  ok(!res.ok && /outside your library/.test(res.error || ''), 'a link out of the library is refused (' + (res.error || 'ok') + ')');
  ok(fs.existsSync(src) && !fs.existsSync(path.join(outside, 'Show', 'Season 01', 'Show - S01E01.mkv')), 'file stayed where it was');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
