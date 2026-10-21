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

// ---- Two episodes written with "&" (real file names) ----
const sb2 = [[23, 'Pre-Hibernation Week'], [24, 'Life of Crime'], [25, 'The Secret Box']].map(([number, name]) => ({ season: 2, number, name, runtime: 11, aired: '2001-05-05' }));
const code = (x) => x && 'S' + x.season + 'E' + x.number + (x.end ? '-E' + x.end : '') + (x.sure ? '' : ' ?');
r = P.parseFilename('SpongeBob SquarePants - 2x23 & 2x24 - Prehibernation Week & Life of Crime.mkv');
eq([r.season, r.episode, r.episodeEnd], [2, 23, 24], '"2x23 & 2x24" is two episodes');
eq([P.parseFilename('Show S02E23 & S02E24.mkv').episodeEnd, P.parseFilename('Show.S02E23-S02E24.mkv').episodeEnd, P.parseFilename('Show 2x23 + 2x24.mkv').episodeEnd], [24, 24, 24], '"S02E23 & S02E24", "S02E23-S02E24", "2x23 + 2x24"');
eq(P.parseFilename('Show 1x02 2010.mkv').episodeEnd, null, 'a number after the episode is not a second episode');
eq(code(P.resolveEpisode(Object.assign(r, { episodeEnd: null }), sb2, {})), 'S2E23-E24', '"Prehibernation" matches "Pre-Hibernation" in a title naming two episodes');

// ---- A season and no episode ("Show.S07 (3).mkv": copies Windows made of one name) ----
r = P.parseFilename('SpongeBob.SquarePants.S07 (3).mkv');
eq([r.kind, r.title, r.season, r.episode], ['episode', 'SpongeBob SquarePants', 7, null], 'season only: a TV episode, number unknown');
eq(P.parseFilename('Movie S1 (2019).mkv').kind, 'movie', 'a year in brackets is still a movie');
const sb7 = [[1, 'Tentacle-Vision'], [2, 'I Heart Dancing'], [3, 'Growth Spout'], [4, 'Stuck in the Wringer']].map(([number, name]) => ({ season: 7, number, name, runtime: 11, aired: number <= 2 ? '2009-01-01' : '2009-01-02' }));
eq(P.resolveEpisode(r, sb7, { segmented: true, file: { minutes: 23 } }), null, 'no number and no title card: no guess (never "episode 1")');
eq(code(P.resolveEpisode(r, sb7, { segmented: true, file: { minutes: 23, parts: 2, cards: [{ part: 0, texts: ['GROWTH SPOUT'] }, { part: 1, texts: ['STUCK IN THE WRINGER'] }] } })), 'S7E3-E4', 'its title cards say which episodes');

// ---- A video much longer than what it's matched to ----
const ww = [{ season: 11, number: 37, name: 'Whale Watching', runtime: 15, aired: '2018-08-06' }, { season: 11, number: 38, name: 'Krusty Kleaners', runtime: 15, aired: '2018-08-07' }];
r = P.parseFilename('SpongeBob SquarePants - S11E37 - Whale Watching 720p.mkv');
eq(code(P.resolveEpisode(r, ww, {})), 'S11E37', 'length not known: as the name says');
eq(code(P.resolveEpisode(r, ww, { file: { minutes: 15 } })), 'S11E37', 'right length: as the name says');
const doubt = P.resolveEpisode(r, ww, { file: { minutes: 23.7 } });
ok(code(doubt) === 'S11E37 ?' && /24 minutes long/.test(doubt.note), 'a 24-minute video named as one 15-minute episode is checked (' + (doubt && doubt.note) + ')');

// ---- Title cards that show only the part after a colon ("Legends of Bikini Bottom: The Main Drain") ----
const legends = ['Sponge-Cano', 'The Main Drain', 'The Curse of the Hex', 'Trenchbillies'].map((n, i) => ({ season: 8, number: 18 + i, name: 'Legends of Bikini Bottom: ' + n }))
  .concat([{ season: 7, number: 18, name: 'The Curse of Bikini Bottom' }, { season: 5, number: 34, name: 'The Battle of Bikini Bottom' }]);
const card = (texts) => { const m = P.matchCardText(texts, legends, []); return m && m.entry.name; };
eq(card(['THE MAIN DRAIN']), 'Legends of Bikini Bottom: The Main Drain', 'the part after the colon is enough');
eq(card(['THE CURSE OF THE HEX']), 'Legends of Bikini Bottom: The Curse of the Hex', '…and isn\'t mistaken for "The Curse of Bikini Bottom"');
eq(card(['THE CURSE OF BIKINI BOTTOM']), 'The Curse of Bikini Bottom', 'a title without a colon still wins on its own words');
eq(card(['THE LEGENDS OF BIKINI BOTTOM']), null, 'the book cover all the Legends share names none of them');
// Real misreadings from the Legends book cover: "BetTo" is "Bottom" misread, not "Battle".
eq(card(['-~ OF i) 1 LH of TIRE 3) ~1 Huu 2 p ae', 'A%) Liihos [i Bor Biking ]', 'nl I! 7 i 1 re OEM i i BetTo) Jt me', '\\ i | I 0 Lebihos Biking © [: BoTrom | —']), null,
  'when titles share words, the word that tells them apart must be read cleanly');
eq(card(['The Battie of Bikini Bottom']), 'The Battle of Bikini Bottom', '…one slip in it is fine');
// A one-word title isn't found by running two words together.
const sold = [{ season: 10, number: 44, name: 'Sold!' }, { season: 2, number: 11, name: 'Wormy' }];
eq(P.matchCardText(['porters, + old'], sold, []), null, '"porters, + old" is not "Sold!"');
eq((P.matchCardText(['SOLD!'], sold, []) || {}).entry, sold[0], '"SOLD!" on its own is');
// The show's own logo isn't an episode's title card.
const spare = [{ season: 4, number: 30, name: 'SpongeBob SpareParts' }, { season: 7, number: 1, name: 'Tentacle-Vision' }];
eq(P.matchCardText(['nickelodeon', 'SpongeBob SquarePants'], spare, [], 'SpongeBob SquarePants'), null, 'the "SpongeBob SquarePants" logo is not "SpongeBob SpareParts"');
eq((P.matchCardText(['SPONGEBOB SPAREPARTS'], spare, [], 'SpongeBob SquarePants') || {}).entry, spare[0], '…the episode\'s own card still is');

// ---- The lettering on its own (desktop/scan.js) ----
{
  const S = require('../desktop/scan.js');
  const W = 200, H = 150, n = W * H, r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  const paint = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const k = y * W + x; r[k] = c[0]; g[k] = c[1]; b[k] = c[2]; } };
  paint(0, 0, W, H, [40, 40, 140]); // blue background…
  for (let x = 0; x < W; x += 30) paint(x, 0, 8, H, [200, 60, 60]); // …with red stripes running off the edges
  for (let i = 0; i < 6; i++) paint(4 + 31 * i + 12, 122, 3, 3, [240, 230, 40]); // yellow specks low down
  // Five yellow "letters" in a row (hollow, like an O: real letters never fill their box).
  for (let i = 0; i < 5; i++) { paint(30 + i * 30, 50, 14, 40, [240, 230, 40]); paint(34 + i * 30, 55, 6, 30, [40, 40, 140]); }
  paint(105, 40, 6, 6, [240, 230, 40]); // a dot among them (an "i")
  const layers = S.letteringLayers(r, g, b, W, H, 8, 2);
  const L = layers[0], at = (x, y) => L && L[y * W + x] === 0;
  ok(L && at(31, 70) && at(151, 70) && !at(37, 70), 'the letters are kept (and their holes stay open)');
  ok(L && at(107, 42), 'a small dot among the letters is kept');
  ok(L && !at(4, 75) && !at(17, 123), 'stripes off the edge and specks away from the letters are dropped');
  const tilt = new Uint8Array(n).fill(255);
  for (let i = 0; i < 6; i++) { const cx = 30 + i * 28, cy = Math.round(110 - i * 28 * Math.tan(20 * Math.PI / 180)); for (let y = cy - 14; y < cy + 14; y++) for (let x = cx - 6; x < cx + 6; x++) tilt[y * W + x] = 0; }
  ok(S.levelled(tilt, W, H) !== null, 'a row of letters on a slant is turned level');
  ok(!L || S.levelled(L, W, H) === null, 'a level row is left as it is');
}

// ---- File engine ----
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-fix-'));
  const lib = path.join(root, 'Plex');
  const dir = path.join(lib, 'Movies', 'The Matrix (1999)');
  fs.mkdirSync(dir, { recursive: true });

  // Only the capital letters change. On Windows and macOS both spellings already name the one file. Linux
  // tells them apart, so there a second name for the same file (a hard link) stands in, which is exactly
  // what those systems report.
  const lower = path.join(dir, 'the matrix (1999).mkv'), upper = path.join(dir, 'The Matrix (1999).mkv');
  fs.writeFileSync(lower, 'MATRIX');
  const caseBlind = fs.existsSync(upper);
  const bothNames = (a, b) => { if (!caseBlind) fs.linkSync(a, b); };
  const names = () => fs.readdirSync(dir);
  bothNames(lower, upper);
  ok(await F.sameFileOtherCase(lower, upper), 'same file under another spelling is recognised');
  ok(!(await F.sameFileOtherCase(lower, path.join(dir, 'Other.mkv'))), 'a different name is not');
  const journal = path.join(root, 'j1.json');
  let res = (await F.run([{ source: lower, folder: ['Movies', 'The Matrix (1999)'], file: 'The Matrix (1999).mkv' }],
    { library: lib, mode: 'move', allowed: new Set([lower]), journalPath: journal })).results[0];
  ok(res.ok && !res.skipped, 'case-only rename goes ahead (' + (res.skipped || res.error || 'ok') + ')');
  eq(names(), ['The Matrix (1999).mkv'], 'file now has the new capitals, and no temporary name is left behind');
  ok(fs.readFileSync(upper, 'utf8') === 'MATRIX', 'same contents');
  const j = JSON.parse(fs.readFileSync(journal, 'utf8'));
  ok(j.done[0].caseOnly === true, 'journal marks it as a capitals-only change');
  // Copy and hard link modes leave it alone: it's already there.
  bothNames(upper, lower);
  res = (await F.run([{ source: lower, folder: ['Movies', 'The Matrix (1999)'], file: 'The Matrix (1999).mkv' }],
    { library: lib, mode: 'copy', allowed: new Set([lower]), journalPath: path.join(root, 'j2.json') })).results[0];
  eq(res.skipped, 'Already in your library', 'copy of a file onto itself is skipped');
  if (!caseBlind) fs.unlinkSync(lower);
  // Undo a capitals-only change.
  bothNames(upper, lower);
  const u = await F.undo(journal);
  ok(u.undone === 1, 'undo puts the old capitals back');
  eq(names(), ['the matrix (1999).mkv'], 'only the old spelling is left');

  // A link inside the library that points outside it: nothing is written through it, not even a folder.
  // (A junction on Windows, which needs no special rights.)
  const outside = path.join(root, 'Elsewhere');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(lib, 'TV Shows'), process.platform === 'win32' ? 'junction' : 'dir');
  const src = path.join(root, 'show.s01e01.mkv');
  fs.writeFileSync(src, 'EP');
  res = (await F.run([{ source: src, folder: ['TV Shows', 'Show', 'Season 01'], file: 'Show - S01E01.mkv' }],
    { library: lib, mode: 'move', allowed: new Set([src]), journalPath: path.join(root, 'j3.json') })).results[0];
  ok(!res.ok && /outside your library/.test(res.error || ''), 'a link out of the library is refused (' + (res.error || 'ok') + ')');
  ok(fs.existsSync(src), 'file stayed where it was');
  eq(fs.readdirSync(outside), [], 'no folders were made outside the library');
  // A real folder inside the library is fine (and its new folders are made).
  res = (await F.run([{ source: src, folder: ['Movies', 'Show', 'Season 01'], file: 'Show - S01E01.mkv' }],
    { library: lib, mode: 'move', allowed: new Set([src]), journalPath: path.join(root, 'j4.json') })).results[0];
  ok(res.ok && fs.existsSync(path.join(lib, 'Movies', 'Show', 'Season 01', 'Show - S01E01.mkv')), 'a new folder inside the library is made (' + (res.error || 'ok') + ')');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
