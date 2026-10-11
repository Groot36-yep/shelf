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
parses('The.Office.US.S02E03.720p.HDTV.x264.mkv', { kind: 'episode', title: 'The Office US', season: 2, episode: 3, episodeTitle: '', resolution: '720p' });
parses('Doctor Who (2005) - 1x01 - Rose.avi', { kind: 'episode', title: 'Doctor Who', year: 2005, season: 1, episode: 1, episodeTitle: 'Rose' });
parses('Show Name Season 2 Episode 10.mp4', { kind: 'episode', title: 'Show Name', season: 2, episode: 10 });
parses('Breaking Bad - S05E14 - Ozymandias.mkv', { kind: 'episode', title: 'Breaking Bad', season: 5, episode: 14, episodeTitle: 'Ozymandias' });

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
check('episode + subtitle name', () => {
  const p = P.parseFilename('bonanza.s01e01.a.rose.for.lotta.en.srt');
  const n = P.plexName(p, { type: 'episode', show: 'Bonanza', showYear: 1959, season: 1, episode: 1, episodeTitle: 'A Rose for Lotta' }, {});
  assert.deepStrictEqual(n, { folder: ['TV Shows', 'Bonanza', 'Season 01'], file: 'Bonanza - S01E01 - A Rose for Lotta.en.srt' });
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
