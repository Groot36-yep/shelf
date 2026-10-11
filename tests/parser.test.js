// Run with: node tests/parser.test.js
const assert = require('assert');
const P = require('../app/js/parser.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('FAIL', name, '\n  ', e.message); }
}
function parses(file, expect) {
  check(file, () => {
    const r = P.parseFilename(file);
    for (const k of Object.keys(expect)) {
      assert.deepStrictEqual(r[k], expect[k], `${k}: got ${JSON.stringify(r[k])}, want ${JSON.stringify(expect[k])}`);
    }
  });
}

// Movies
parses('charade.1963.1080p.bluray.x264-GRP.mkv', { kind: 'movie', title: 'Charade', year: 1963, resolution: '1080p', ext: 'mkv' });
parses('Night.of.the.Living.Dead.1968.REMASTERED.720p.mp4', { kind: 'movie', title: 'Night of the Living Dead', year: 1968, resolution: '720p' });
parses('nosferatu_restored.avi', { kind: 'movie', title: 'Nosferatu', year: null });
parses('His Girl Friday 1940 DVDRip.m4v', { kind: 'movie', title: 'His Girl Friday', year: 1940 });
parses('Night_of_the_Living_Dead.HD.mov', { kind: 'movie', title: 'Night of the Living Dead', year: null, ext: 'mov' });
parses('2001.A.Space.Odyssey.1968.2160p.UHD.mkv', { kind: 'movie', title: '2001 A Space Odyssey', year: 1968, resolution: '2160p' });
parses('1917 (2019).mkv', { kind: 'movie', title: '1917', year: 2019 });
parses('Blade Runner 2049 (2017) [1080p].mkv', { kind: 'movie', title: 'Blade Runner 2049', year: 2017 });
parses('Spider-Man.Into.the.Spider-Verse.2018.WEB-DL.mkv', { kind: 'movie', title: 'Spider-Man Into the Spider-Verse', year: 2018 });
parses('[YTS] The Matrix (1999) [720p].mp4', { kind: 'movie', title: 'The Matrix', year: 1999 });
parses('Metropolis.mkv', { kind: 'movie', title: 'Metropolis', year: null });

// TV
parses('bonanza.s01e01.a.rose.for.lotta.mkv', { kind: 'episode', title: 'Bonanza', season: 1, episode: 1, episodeTitle: 'A Rose for Lotta' });
parses('The.Office.US.S02E03.720p.HDTV.x264.mkv', { kind: 'episode', title: 'The Office', country: 'US', season: 2, episode: 3, episodeTitle: '', resolution: '720p', source: 'HDTV' });
parses('Doctor Who (2005) - 1x01 - Rose.avi', { kind: 'episode', title: 'Doctor Who', year: 2005, season: 1, episode: 1, episodeTitle: 'Rose' });
parses('Show Name Season 2 Episode 10.mp4', { kind: 'episode', title: 'Show Name', season: 2, episode: 10 });
parses('Breaking Bad - S05E14 - Ozymandias.mkv', { kind: 'episode', title: 'Breaking Bad', season: 5, episode: 14, episodeTitle: 'Ozymandias' });

// TV: harder cases
parses('This.Is.Us.S01E01.1080p.WEB-DL.mkv', { title: 'This Is Us', country: null, source: 'WEB-DL', resolution: '1080p' });
parses('Shameless (UK) - 1x01.mkv', { title: 'Shameless', country: 'GB', season: 1, episode: 1 });
parses('The.Dark.Web.S01E01.mkv', { title: 'The Dark Web', source: null });
parses('show.s01e01e02.1080p.bluray.x264.mkv', { episode: 1, episodeEnd: 2, source: 'BluRay' });
parses('Show.S03E09-E10.mkv', { episode: 9, episodeEnd: 10 });
parses('The.Daily.Show.2024.01.15.Guest.Night.720p.WEB.h264.mkv', { kind: 'episode', title: 'The Daily Show', airdate: '2024-01-15', episodeTitle: 'Guest Night', source: 'WEB' });
function inFolder(file, folders, expect) {
  check(folders.join('/') + '/' + file, () => {
    const r = P.parsePath(file, folders);
    for (const k of Object.keys(expect)) assert.deepStrictEqual(r[k], expect[k], `${k}: got ${JSON.stringify(r[k])}`);
  });
}
inFolder('E01.mkv', ['Breaking Bad (2008)', 'Season 1'], { kind: 'episode', title: 'Breaking Bad', year: 2008, season: 1, episode: 1 });
inFolder('01 - Pilot.mkv', ['TV', 'Breaking Bad', 'Season 01'], { title: 'Breaking Bad', season: 1, episode: 1, episodeTitle: 'Pilot' });
inFolder('Episode 5.mkv', ['The Office (US)', 'Season 2'], { title: 'The Office', country: 'US', season: 2, episode: 5 });
inFolder('S01E01.mkv', ['Ghosts (2021)'], { title: 'Ghosts', year: 2021 });
inFolder('ep03.mkv', ['Lost', 'Specials'], { title: 'Lost', season: 0, episode: 3 });
inFolder('The.Office.S02E01.mkv', ['The.Office.US.S02.1080p.WEB-DL'], { title: 'The Office', country: 'US' });
inFolder('charade.1963.mkv', ['Movies'], { kind: 'movie', title: 'Charade' });

// Quality / source
parses('Web.2013.1080p.WEBRip.mkv', { title: 'Web', year: 2013, source: 'WEBRip' });
parses('Cam.2018.1080p.NF.WEB-DL.mkv', { title: 'Cam', source: 'WEB-DL' });
parses('Movie.Title.2019.2160p.UHD.BluRay.REMUX.HDR.HEVC.mkv', { title: 'Movie Title', source: 'Remux', hdr: 'HDR', resolution: '2160p' });
parses('Dune.Part.Two.2024.2160p.WEB-DL.DV.mkv', { source: 'WEB-DL', hdr: 'DV' });
parses('His Girl Friday 1940 DVDRip.m4v', { source: 'DVD' });
check('quality label', () => assert.strictEqual(P.qualityLabel(P.parseFilename('charade.1963.1080p.bluray.x264-GRP.mkv')), '1080p BluRay'));

// Subtitles
parses('bonanza.s01e01.a.rose.for.lotta.en.srt', { kind: 'episode', isSubtitle: true, lang: 'en', title: 'Bonanza', episodeTitle: 'A Rose for Lotta' });
parses('Charade.1963.eng.forced.srt', { kind: 'movie', isSubtitle: true, lang: 'en', subFlags: ['forced'], title: 'Charade', year: 1963 });

// Ranking
check('rank prefers exact title + year', () => {
  const parsed = P.parseFilename('nosferatu.1922.mkv');
  const r = P.rankCandidates(parsed, [
    { title: 'Nosferatu', year: 2024, popularity: 80 },
    { title: 'Nosferatu', year: 1922, popularity: 20 },
    { title: 'Nosferatu the Vampyre', year: 1979, popularity: 15 }
  ]);
  assert.strictEqual(r[0].year, 1922);
  assert.ok(r[0].score >= 90, 'score ' + r[0].score);
  assert.strictEqual(r.ambiguous, false);
});
check('rank flags same-title remakes without a year', () => {
  const parsed = P.parseFilename('nosferatu_restored.avi');
  const r = P.rankCandidates(parsed, [
    { title: 'Nosferatu', year: 2024, popularity: 80 },
    { title: 'Nosferatu', year: 1922, popularity: 70 }
  ]);
  assert.strictEqual(r.ambiguous, true);
});

check('TV: far better-known show wins over an obscure namesake', () => {
  const r = P.rankCandidates(P.parseFilename('bonanza.s01e01.mkv'), [
    { type: 'episode', title: 'Bonanza', year: 1959, weight: 90, popularity: 100 },
    { type: 'episode', title: 'Bonanza', year: 2020, weight: 6, popularity: 16 }
  ]);
  assert.strictEqual(r[0].year, 1959); assert.strictEqual(r.ambiguous, false);
});
check('TV: close namesakes still ask', () => {
  const r = P.rankCandidates(P.parseFilename('the.office.s01e01.mkv'), [
    { type: 'episode', title: 'The Office', year: 2005, weight: 99, country: 'US' },
    { type: 'episode', title: 'The Office', year: 2001, weight: 95, country: 'GB' }
  ]);
  assert.strictEqual(r.ambiguous, true);
});
check('TV: country picks the right twin', () => {
  const r = P.rankCandidates(P.parseFilename('The.Office.UK.S01E01.mkv'), [
    { type: 'episode', title: 'The Office', year: 2005, weight: 99, country: 'US' },
    { type: 'episode', title: 'The Office', year: 2001, weight: 95, country: 'GB' }
  ]);
  assert.strictEqual(r[0].year, 2001); assert.strictEqual(r.ambiguous, false);
});

// Two-part cartoons (real TVmaze listings in tests/fixtures/cartoons.json)
const F = require('./fixtures/cartoons.json');
const L = (k) => F[k].map(([season, number, name, aired, runtime]) => ({ season, number, name, aired, runtime }));
const SB = L('spongebob'), FOP = L('fop');
function resolves(file, list, ctx, want) {
  check('resolve ' + file, () => {
    const r = P.resolveEpisode(P.parseFilename(file), list, ctx);
    const got = r && ('S' + r.season + 'E' + r.number + (r.end ? '-E' + r.end : '') + (r.sure ? '' : ' ?'));
    assert.strictEqual(got, want, file + ' → ' + JSON.stringify(r));
  });
}
resolves('SpongeBob.SquarePants.S01E02.Bubblestand.Ripped.Pants.1080p.WEB-DL.mkv', SB, {}, 'S1E4-E5');
resolves('SpongeBob SquarePants - S01E01 - Help Wanted - Reef Blower - Tea at the Treedome.mkv', SB, {}, 'S1E1-E3');
resolves('SpongeBob.S01E06.Jellyfishing.mkv', SB, {}, 'S1E6');
resolves('SpongeBob.S01E20.Hooky.Mermaid.Man.and.Barnacle.Boy.II.mkv', SB, {}, 'S1E40-E41');
resolves('SpongeBob.S01E12.Mermaid.Man.and.Barnacle.Boy.mkv', SB, {}, 'S1E12');
resolves('SpongeBob.S01E02.mkv', SB, { mode: 'halfhours', sure: true }, 'S1E4-E5');
resolves('SpongeBob.S02E09.mkv', SB, { mode: 'halfhours', sure: true }, 'S2E17-E18');
resolves('SpongeBob.S02E10.mkv', SB, { mode: 'halfhours', sure: true }, 'S2E19-E20'); // 4 cartoons aired that day: 2 half-hours
resolves('SpongeBob.S01E02.mkv', SB, { mode: 'segments', sure: false }, 'S1E2 ?');
resolves('SpongeBob.S01E02.mkv', SB, { mode: 'segments', sure: true }, 'S1E2');
resolves('The.Fairly.OddParents.S01E01.The.Big.Problem.Power.Mad.DVDRip.mkv', FOP, {}, 'S1E1-E2');
resolves('Fairly OddParents - 1x05 - Father Time - Apartnership.avi', FOP, {}, 'S1E7-E8');
resolves('Fairly OddParents S01E07 Christmas Everyday.mkv', FOP, {}, 'S1E13');
resolves('Fairly OddParents S02E01 Hex Games.mkv', FOP, { mode: 'halfhours', sure: true }, 'S2E1-E2');
check('numbering: a full season of half-hour files', () => {
  const files = Array.from({ length: 20 }, (_, i) => P.parseFilename('SpongeBob.S01E' + String(i + 1).padStart(2, '0') + '.mkv'));
  assert.deepStrictEqual(P.detectNumbering(files, SB, 1), { mode: 'halfhours', sure: true, segmented: true });
  const all = Array.from({ length: 41 }, (_, i) => P.parseFilename('SpongeBob.S01E' + String(i + 1).padStart(2, '0') + '.mkv'));
  assert.strictEqual(P.detectNumbering(all, SB, 1).mode, 'segments');
  assert.strictEqual(P.detectNumbering(files.slice(0, 3), SB, 1).sure, false);
  const normal = [{ season: 1, number: 1, name: 'A', aired: '2020-01-01', runtime: 45 }, { season: 1, number: 2, name: 'B', aired: '2020-01-08', runtime: 45 }, { season: 1, number: 3, name: 'C', aired: '2020-01-15', runtime: 45 }, { season: 1, number: 4, name: 'D', aired: '2020-01-22', runtime: 45 }];
  assert.deepStrictEqual(P.detectNumbering(files.slice(0, 2), normal, 1), { mode: 'segments', sure: true, segmented: false });
});

// Title cards: real OCR readings of SpongeBob title cards (tests/fixtures/spongebob-cards-ocr.json)
const OCR = require('./fixtures/spongebob-cards-ocr.json').cards;
check('title cards: right or not sure, never wrong', () => {
  let right = 0;
  for (const [title, texts] of Object.entries(OCR)) {
    const want = SB.find((e) => e.name === title);
    const season = SB.filter((e) => e.season === want.season);
    const m = P.matchCardText(texts, season, season.filter((e) => Math.abs(e.number - want.number) <= 6));
    if (m) { assert.strictEqual(m.entry.name, title, 'read ' + JSON.stringify(texts) + ' as ' + m.entry.name); right++; }
  }
  assert.ok(right >= 12, 'identified ' + right + ' of 16');
  assert.strictEqual(P.matchCardText(['00:01:09.000 828 -n. Bo# RR PEE 8'], SB), null, 'noise is not a title');
});
function withFile(file, f, want) {
  check('resolve ' + file + ' ' + JSON.stringify(Object.keys(f)), () => {
    const r = P.resolveEpisode(P.parseFilename(file), SB, { segmented: true, file: f });
    assert.strictEqual(r && ('S' + r.season + 'E' + r.number + (r.end ? '-E' + r.end : '') + (r.sure ? '' : ' ?')), want, JSON.stringify(r));
  });
}
const cards = (...names) => names.map((n, i) => ({ part: i, texts: OCR[n] }));
withFile('SpongeBob.S01E02.mkv', { minutes: 22 }, 'S1E4-E5');
withFile('SpongeBob.S01E02.mkv', { minutes: 11 }, 'S1E2');
withFile('SpongeBob.S01E02.mkv', { minutes: 44 }, 'S1E4-E7');
withFile('SpongeBob.S01E09.mkv', { minutes: 22, parts: 2, cards: cards('Jellyfishing', 'Plankton!') }, 'S1E6-E7');
withFile('SpongeBob.S01E01.mkv', { minutes: 22, parts: 2, cards: cards('Help Wanted', 'Tea at the Treedome') }, 'S1E1-E3');
withFile('SpongeBob.S01E03.mkv', { minutes: 22, parts: 2, cards: cards('Jellyfishing', 'Hall Monitor') }, 'S1E6-E7'); // second card unreadable
withFile('SpongeBob.S01E07.mkv', { minutes: 22, parts: 2, cards: cards('Pickles', 'Hall Monitor') }, 'S1E12-E13 ?');
withFile('SpongeBob.S01E05.mkv', { minutes: 22, parts: 2, cards: cards('Pizza Delivery', 'Pickles') }, 'S1E10 ?');

// Naming
check('movie name', () => {
  const p = P.parseFilename('charade.1963.1080p.mkv');
  const n = P.plexName(p, { type: 'movie', title: 'Charade', year: 1963, id: 4808 }, {});
  assert.deepStrictEqual(n, { folder: ['Movies', 'Charade (1963)'], file: 'Charade (1963).mkv' });
  const n2 = P.plexName(p, { type: 'movie', title: 'Charade', year: 1963, id: 4808 }, { movieIds: true });
  assert.strictEqual(n2.file, 'Charade (1963) {tmdb-4808}.mkv');
});
check('colon titles', () => {
  const p = P.parseFilename('star.wars.1977.mkv');
  const n = P.plexName(p, { type: 'movie', title: 'Star Wars: A New Hope', year: 1977 }, {});
  assert.strictEqual(n.file, 'Star Wars - A New Hope (1977).mkv');
});
check('quality in names', () => {
  const p = P.parseFilename('charade.1963.1080p.bluray.mkv');
  const n = P.plexName(p, { type: 'movie', title: 'Charade', year: 1963 }, { quality: '1080p BluRay' });
  assert.deepStrictEqual(n, { folder: ['Movies', 'Charade (1963)'], file: 'Charade (1963) - 1080p BluRay.mkv' });
  const e = P.plexName(P.parseFilename('x.s01e01e02.en.srt'), { type: 'episode', show: 'Lost', season: 1, episode: 1, episodeEnd: 2, episodeTitle: 'Pilot' }, { quality: '720p BluRay' });
  assert.strictEqual(e.file, 'Lost - S01E01-E02 - Pilot [720p BluRay].en.srt');
  const id = P.plexName(P.parseFilename('x.s01e01.mkv'), { type: 'episode', show: 'SpongeBob SquarePants', season: 1, episode: 1, idTag: 'tmdb-387' }, {});
  assert.deepStrictEqual(id.folder, ['TV Shows', 'SpongeBob SquarePants {tmdb-387}', 'Season 01']);
  assert.strictEqual(id.file, 'SpongeBob SquarePants - S01E01.mkv');
  const evil = P.plexName(P.parseFilename('x.s01e01.mkv'), { type: 'episode', show: 'X', season: 1, episode: 1, idTag: 'tmdb-1}/../x' }, {});
  assert.deepStrictEqual(evil.folder, ['TV Shows', 'X', 'Season 01']);
  const bad = P.plexName(p, { type: 'movie', title: 'Charade', year: 1963 }, { quality: '../x/{y}' });
  assert.ok(!/[\\/{}]/.test(bad.file), bad.file);
  assert.deepStrictEqual(P.plexName(P.parseFilename('a.s00e01.mkv'), { type: 'episode', show: 'Lost', season: 0, episode: 1 }, {}).folder, ['TV Shows', 'Lost', 'Specials']);
});
check('episode + subtitle name', () => {
  const p = P.parseFilename('bonanza.s01e01.a.rose.for.lotta.en.srt');
  const n = P.plexName(p, { type: 'episode', show: 'Bonanza', showYear: 1959, season: 1, episode: 1, episodeTitle: 'A Rose for Lotta' }, {});
  assert.deepStrictEqual(n, { folder: ['TV Shows', 'Bonanza', 'Season 01'], file: 'Bonanza - S01E01 - A Rose for Lotta.en.srt' });
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
