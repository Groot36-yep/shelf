// Missing Episodes: which episodes a file holds, which folders on the server are the show's, and what's missing.
//   node tests/missing.test.js
'use strict';
const assert = require('assert');
const M = require('../app/js/missing.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const codes = (h) => (h || []).map(M.code);

// A small show: two seasons, a special, one episode not out yet, one the service never dated.
const LIST = [
  { season: 0, number: 1, name: 'Christmas Special', aired: '2000-12-24' },
  { season: 0, number: 2, name: 'Behind the Scenes', aired: '2001-06-01' },
  { season: 1, number: 1, name: 'Help Wanted', aired: '1999-05-01' },
  { season: 1, number: 2, name: 'Reef Blower', aired: '1999-05-01' },
  { season: 1, number: 3, name: 'Tea at the Treedome', aired: '1999-05-01' },
  { season: 1, number: 4, name: 'Bubblestand', aired: '1999-07-17' },
  { season: 1, number: 5, name: 'Ripped Pants', aired: '' }, // never dated, but later ones aired: it's out
  { season: 1, number: 6, name: 'Jellyfishing', aired: '1999-07-31' },
  { season: 2, number: 1, name: 'Something Smells', aired: '2000-10-20' },
  { season: 2, number: 2, name: 'Bossy Boots', aired: '2000-10-20' },
  { season: 2, number: 3, name: 'Big Pink Loser', aired: '2001-01-01' },
  { season: 3, number: 1, name: 'Next Year', aired: '2027-03-01' }, // not out yet
  { season: 3, number: 2, name: 'Announced', aired: '' }, // announced, no date: not out yet
  { season: null, number: null, name: 'Unnumbered special' }
];
const TODAY = { today: '2026-11-24' };

t('a file in the list: what Shelf worked out (one episode, a run, its entries)', () => {
  assert.deepStrictEqual(codes(M.heldByItem({ episode: { season: 1, number: 4, end: null } })), ['S01E04']);
  assert.deepStrictEqual(codes(M.heldByItem({ episode: { season: 1, number: 1, end: 3 } })), ['S01E01', 'S01E02', 'S01E03']);
  // Episodes that aren't next to each other (to be split): each of them.
  assert.deepStrictEqual(codes(M.heldByItem({ episode: { season: 2, number: 1, end: null, entries: [{ season: 2, number: 1 }, { season: 2, number: 3 }] } })), ['S02E01', 'S02E03']);
  assert.strictEqual(M.heldByItem({ episode: null }), null, 'Shelf doesn’t know: not counted');
  assert.strictEqual(M.heldByItem(null), null);
});

t('a file in the list: your pick in Inspect and a split win over the guess', () => {
  const guess = { season: 1, number: 1, end: null };
  assert.deepStrictEqual(codes(M.heldByItem({ episode: guess, manualEp: { season: 1, number: 2, end: 3, entries: [{ season: 1, number: 2 }, { season: 1, number: 3 }] } })), ['S01E02', 'S01E03']);
  assert.deepStrictEqual(codes(M.heldByItem({ episode: null, manualEp: { season: 2, number: 2, end: null } })), ['S02E02']);
  const split = { pieces: [{ start: 0, end: 660, entry: { season: 1, number: 5, name: 'Ripped Pants' } }, { start: 660, end: 1320, entry: { season: 1, number: 6, name: 'Jellyfishing' } }] };
  assert.deepStrictEqual(codes(M.heldByItem({ episode: guess, split })), ['S01E05', 'S01E06']);
});

t('a file on the server: its name (runs of episodes, folders, nothing to go on)', () => {
  assert.deepStrictEqual(codes(M.heldByName('SpongeBob SquarePants S01E01-E02-E03 Help Wanted - Reef Blower-Tea The Threedome.mkv')), ['S01E01', 'S01E02', 'S01E03']);
  assert.deepStrictEqual(codes(M.heldByName('SpongeBob SquarePants S01E04E05 Bubblestand - Ripped Pants.mkv')), ['S01E04', 'S01E05']);
  assert.deepStrictEqual(codes(M.heldByName('SpongeBob SquarePants - S02E01-E02 - Something Smells & Bossy Boots.mkv', ['Season 02'])), ['S02E01', 'S02E02']);
  assert.deepStrictEqual(codes(M.heldByName('SpongeBob.SquarePants.S05E03.720p.mkv', ['Season 5'])), ['S05E03']);
  assert.deepStrictEqual(codes(M.heldByName('Show 1x07 - Name.mkv')), ['S01E07']);
  assert.deepStrictEqual(codes(M.heldByName('Good Show - S01E01 - Pilot.mkv')), ['S01E01']);
  assert.strictEqual(M.heldByName('SpongeBob.SquarePants.S07 (3).mkv', ['Season 7']), null, 'season only: Shelf can’t tell which');
  assert.strictEqual(M.heldByName('holiday video.mkv'), null);
});

t('missing ones, season by season; a file of several episodes counts for each', () => {
  const held = [
    M.heldByName('Show - S01E01-E03 - Help Wanted.mkv'),
    M.heldByItem({ episode: { season: 1, number: 4, end: 5 } }),
    M.heldByItem({ split: { pieces: [{ entry: { season: 2, number: 1 } }, { entry: { season: 2, number: 2 } }] } })
  ];
  const r = M.compare(LIST, held, TODAY);
  assert.deepStrictEqual(r.seasons.map((s) => [s.season, s.total, s.have, s.missing.map((m) => m.code + ' ' + m.name)]), [
    [1, 6, 5, ['S01E06 Jellyfishing']],
    [2, 3, 2, ['S02E03 Big Pink Loser']],
    [3, 0, 0, []]
  ]);
  assert.strictEqual(r.total, 9); assert.strictEqual(r.have, 7); assert.strictEqual(r.missing, 2);
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.seasons[2].upcoming, 2, 'season 3 hasn’t aired: not missing');
  assert.strictEqual(r.upcoming, 2);
});

t('everything there: complete, and specials don’t spoil it', () => {
  const held = [[1, 2, 3, 4, 5, 6].map((e) => ({ season: 1, number: e })), [1, 2, 3].map((e) => ({ season: 2, number: e }))];
  const r = M.compare(LIST, held, TODAY);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.missing, 0);
  assert.strictEqual(r.have, 9);
  assert.deepStrictEqual([r.specials.total, r.specials.have, r.specials.missing.length], [2, 0, 2], 'specials kept apart');
  assert.ok(!r.seasons.some((s) => s.season === 0));
});

t('the same episode twice counts once; episodes not on the list and files Shelf can’t place are told apart', () => {
  const held = [[{ season: 1, number: 1 }], [{ season: 1, number: 1 }], [{ season: 1, number: 40 }], null, []];
  const r = M.compare(LIST, held, TODAY);
  assert.strictEqual(r.seasons[0].have, 1);
  assert.deepStrictEqual(r.extra.map((x) => x.code), ['S01E40']);
  assert.strictEqual(r.unknown, 2);
});

t('nothing on the list (or an empty list): not “complete”', () => {
  assert.strictEqual(M.compare([], [[{ season: 1, number: 1 }]], TODAY).complete, false);
  assert.strictEqual(M.compare(null, null, TODAY).total, 0);
});

t('which server folders are the show’s', () => {
  const sb = { source: 'TMDB', id: 387, title: 'SpongeBob SquarePants', altTitle: '', year: 1999 };
  assert.strictEqual(M.matchFolder('SpongeBob SquarePants {tmdb-387}', sb), 'yes');
  assert.strictEqual(M.matchFolder('SpongeBob SquarePants (1999)', sb), 'yes');
  assert.strictEqual(M.matchFolder('Spongebob Squarepants', sb), 'yes');
  assert.strictEqual(M.matchFolder('Spongebob', sb), 'maybe', 'only part of the name: its files have to say');
  assert.strictEqual(M.matchFolder('SpongeBob SquarePants v2', sb), 'maybe');
  assert.strictEqual(M.matchFolder('SpongeBob SquarePants {tmdb-999}', sb), null, 'another show’s id');
  assert.strictEqual(M.matchFolder('SpongeBob SquarePants (2024)', sb), null, 'another year');
  assert.strictEqual(M.matchFolder('Kamp Koral', sb), null);
  assert.strictEqual(M.matchFolder('Sp', sb), null);
  // TVmaze shows carry TheTVDB's id; TheTVDB shows their own.
  assert.strictEqual(M.matchFolder('Whatever {tvdb-75886}', { source: 'TVmaze', id: 713, tvdbId: 75886, title: 'SpongeBob SquarePants' }), 'yes');
  assert.strictEqual(M.matchFolder('SpongeBob SquarePants {tvdb-1}', { source: 'TheTVDB', id: 75886, title: 'SpongeBob SquarePants' }), null);
  assert.strictEqual(M.matchFolder('The Office (2005)', { source: 'TVmaze', id: 526, title: 'The Office', year: 2005 }), 'yes');
  assert.strictEqual(M.matchFolder('Office', { source: 'TVmaze', id: 526, title: 'The Office' }), 'yes', '“The” doesn’t matter');
  assert.strictEqual(M.folderInfo('Lost (2004) {tvdb-73739}').title, 'Lost');
});

t('a “maybe” folder counts only when its files say the show', () => {
  const sb = { title: 'SpongeBob SquarePants' };
  assert.strictEqual(M.filesAgree(['SpongeBob.SquarePants.S05E03.720p.mkv', 'S05E04.mkv'], sb), true);
  assert.strictEqual(M.filesAgree(['Lost.S01E01.mkv', 'Lost.S01E02.mkv'], { title: 'Lost Girl' }), false);
  assert.strictEqual(M.filesAgree([], sb), false);
});

// The server side (desktop/showcheck.js): only show folders right inside your TV library folders are read.
const C = require('../desktop/showcheck.js');
t('server: the TV library folders, and which folders may be listed', () => {
  const roots = C.tvRoots({ tv: '/mnt/old', libraries: [{ kind: 'movies', folders: ['/mnt/media/Movies'] }, { kind: 'tv', title: 'TV Shows', folders: ['/mnt/media/TV/', '/mnt/media/TV'] }, { kind: 'tv', title: 'Kids', folders: ['/srv/kids'] }] });
  assert.deepStrictEqual(roots, [{ root: '/mnt/media/TV', lib: 'TV Shows' }, { root: '/srv/kids', lib: 'Kids' }], 'Plex’s TV libraries win; no doubles');
  assert.deepStrictEqual(C.tvRoots({ tv: '/mnt/tv' }), [{ root: '/mnt/tv', lib: 'TV Shows' }], 'else the TV folder picked for Send to Plex');
  assert.deepStrictEqual(C.tvRoots({}), []);
  assert.ok(C.rootOf('/mnt/media/TV/SpongeBob SquarePants', roots));
  assert.strictEqual(C.rootOf('/mnt/media/TV', roots), null, 'not the library folder itself');
  assert.strictEqual(C.rootOf('/mnt/media/TV/Show/Season 01', roots), null, 'only a show’s own folder');
  assert.strictEqual(C.rootOf('/mnt/media/TV/../Movies', roots), null, 'no climbing out');
  assert.strictEqual(C.rootOf('/etc', roots), null);
  assert.strictEqual(C.rootOf('relative/Show', roots), null);
});
(async () => {
  const tree = {
    '/tv/Show': [['Season 01', 'd'], ['Specials', 'd'], ['.hidden', 'd'], ['poster.jpg', 'f'], ['Show - S00E01.mkv', 'f']],
    '/tv/Show/Season 01': [['Show - S01E02.mkv', 'f'], ['Show - S01E01-E02.mkv', 'f'], ['Show - S01E01.en.srt', 'f']],
    '/tv/Show/Specials': [['Extra.mp4', 'f']]
  };
  const s = { entries: async (d) => (tree[d] || []).map(([name, k]) => ({ name, dir: k === 'd', file: k === 'f', size: 5 })) };
  const r = await C.videosIn(s, '/tv/Show');
  assert.deepStrictEqual(r.files.map((f) => f.folders.concat(f.name).join('/')), ['Season 01/Show - S01E01-E02.mkv', 'Season 01/Show - S01E02.mkv', 'Show - S00E01.mkv', 'Specials/Extra.mp4']);
  assert.strictEqual(r.truncated, false);
  n++; console.log('  ✓ server: the videos in a show’s folder and its season folders (names only; no subtitles, pictures or hidden folders)');
  console.log('missing: all ' + n + ' passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
