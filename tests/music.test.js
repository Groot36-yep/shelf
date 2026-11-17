// Music matching: names, albums, lining files up with tracks, choosing the edition, Plex names and tags.
// Run with: node tests/music.test.js
'use strict';
const assert = require('assert');
const M = require('../app/js/music.js');
const P = require('../app/js/parser.js');

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const tg = (o) => Object.assign({ ok: true, title: '', artists: [], albumArtists: [], album: '', genres: [], track: 0, trackTotal: 0, disc: 0, discTotal: 0, year: 0, mb: {}, duration: 0 }, o, { mb: Object.assign({ release: '', recording: '' }, o.mb) });
const rel = (id, title, artist, discs, o) => Object.assign({
  id, title, artist, artistIds: ['a-' + artist], artistSort: artist, year: 2014, date: '2014', country: 'XW', status: 'Official', trackCount: discs.reduce((n, d) => n + d.length, 0), formats: ['Digital Media'],
  group: { id: 'g-' + title, primaryType: 'Album', secondaryTypes: [], firstDate: '1992-09-21' }, genres: ['pop'],
  media: discs.map((d, i) => ({ position: i + 1, format: 'Digital Media', trackCount: d.length, tracks: d.map((t, j) => ({ id: id + '-t' + i + j, recording: t[2] || 'rec-' + t[0], position: j + 1, number: String(j + 1), title: t[0], length: t[1], artist: t[3] || artist, artistIds: ['a-' + (t[3] || artist)] })) }))
}, o || {});

// 1. Names
assert.deepStrictEqual(M.parseTrackName('01 Dancing Queen.ogg'), { track: 1, disc: 0, title: 'Dancing Queen', artist: '' });
assert.deepStrictEqual(M.parseTrackName('1-11 Wake up!.mp3'), { track: 11, disc: 1, title: 'Wake up!', artist: '' });
assert.deepStrictEqual(M.parseTrackName('01 AAAMYYY - Elsewhere.mp3'), { track: 1, disc: 0, title: 'Elsewhere', artist: 'AAAMYYY' });
assert.deepStrictEqual(M.parseTrackName('Hus - BANANA SHAKE (SPED UP).ogg'), { track: 0, disc: 0, title: 'BANANA SHAKE (SPED UP)', artist: 'Hus' });
assert.deepStrictEqual(M.parseTrackName('03. Backlight.mp3', ['Ado', 'Album', 'CD2']), { track: 3, disc: 2, title: 'Backlight', artist: '' });
assert.strictEqual(M.sim('Welcome トゥ 混沌', 'welcome トゥ 混沌'), 1, 'any script, any case');
assert.ok(M.sim('Gimme! Gimme! Gimme! (A Man After Midnight)', 'Gimme Gimme Gimme (a man after midnight)') === 1);
assert.ok(M.sim('Song (feat. Someone)', 'Song') === 1, '"feat." doesn’t make another song');
assert.ok(M.sim('Dancing Queen', 'Chiquitita') < 0.4);
assert.ok(M.artistSim('Royal & the Serpent, Arcane & League of Legends', 'Royal & the Serpent') >= 0.99, 'one of several credited artists');
assert.ok(M.artistSim('Royal & the Serpent, Arcane & League of Legends', 'Ghost Funk Orchestra') < 0.5);
assert.ok(M.artistSim('Kendrick Lamar feat. Jay Rock', 'Kendrick Lamar') >= 0.99);
ok('track numbers, discs, artists and titles from names; titles compared in any script');

// 2. Albums: by tags, else by folder; disc folders join; a folder of unrelated songs is singles.
const files = [
  { id: 1, name: '01 Dancing Queen.ogg', folders: ['ABBA', 'Gold_ Greatest Hits'], tags: tg({ title: 'Dancing Queen', album: 'Gold: Greatest Hits', albumArtists: ['ABBA'], artists: ['ABBA'], mb: { release: 'R1' } }) },
  { id: 2, name: '03 Take a Chance on Me.mp3', folders: ['ABBA', 'Gold'], tags: tg({ title: 'Take a Chance on Me', album: 'Gold: Greatest Hits', albumArtists: ['ABBA'], artists: ['ABBA'], mb: { release: 'R2' } }) },
  { id: 3, name: '01 Intro.flac', folders: ['X', 'Live', 'CD1'], tags: { ok: false } },
  { id: 4, name: '01 Outro.flac', folders: ['X', 'Live', 'CD2'], tags: { ok: false } },
  { id: 5, name: 'Ginger Root - Let\'s Stay Out.ogg', folders: ['Various Artists'], tags: tg({ title: 'Let\'s Stay Out', artists: ['Ginger Root'] }) },
  { id: 6, name: 'INOHA - Seventh Heaven.ogg', folders: ['Various Artists'], tags: tg({ title: 'Seventh Heaven', artists: ['INOHA'] }) }
];
const albums = M.groupAlbums(files);
const byIds = albums.map((a) => a.ids.join(','));
assert.ok(byIds.includes('1,2'), 'same album tags go together, whatever the folders: ' + JSON.stringify(byIds));
assert.deepStrictEqual(albums.find((a) => a.ids[0] === 1).votes, { R1: 1, R2: 1 }, 'both editions the files were tagged with');
assert.ok(byIds.includes('3,4'), 'CD1 and CD2 folders are one album');
assert.ok(byIds.includes('5') && byIds.includes('6') && albums.find((a) => a.ids[0] === 5).single, 'unrelated loose songs are singles');
ok('files grouped into albums (tags first, then folders; disc folders join; loose songs are singles)');

// 3. Lining up: a partial album (6 of 19) by tags; lengths decide between similar titles.
const gold = rel('R1', 'Gold: Greatest Hits', 'ABBA', [[['Dancing Queen', 231], ['Knowing Me, Knowing You', 241], ['Take a Chance on Me', 244], ['Mamma Mia', 213], ['Lay All Your Love on Me', 274]]]);
const part = [
  { id: 1, name: '01 Dancing Queen.ogg', tags: tg({ title: 'Dancing Queen', track: 1 }), duration: 231.2 },
  { id: 3, name: '03 Take a Chance on Me.ogg', tags: tg({ title: 'Take a Chance on Me', track: 3 }), duration: 245 },
  { id: 5, name: '05 Lay All Your Love on Me.ogg', tags: tg({ title: 'Lay All Your Love on Me', track: 5 }), duration: 274 }
];
let a = M.assign(part, gold);
assert.deepStrictEqual(a.pairs.map((p) => [p.id, p.track.position]).sort(), [[1, 1], [3, 3], [5, 5]]);
assert.strictEqual(a.extra.length, 0); assert.strictEqual(a.missing.length, 2, 'two tracks not in your files');
assert.ok(a.fit > 0.85, 'a partial album fits well: ' + a.fit);
// No tags, just names and lengths.
a = M.assign([{ id: 9, name: 'Track 4.mp3', tags: { ok: false }, duration: 213 }], gold);
assert.strictEqual(a.pairs[0].track.title, 'Mamma Mia', 'number + length place an untitled file');
// A recording id is certain, even if the title is in another language.
a = M.assign([{ id: 8, name: 'x.mp3', tags: tg({ title: 'ダンシング・クイーン', mb: { recording: 'rec-Dancing Queen' } }), duration: 231 }], gold);
assert.strictEqual(a.pairs[0].track.position, 1); assert.strictEqual(a.pairs[0].cost, 0);
// A file that's not on this edition at all is extra, not forced onto a track.
a = M.assign([{ id: 7, name: '06 Waterloo.mp3', tags: tg({ title: 'Waterloo', track: 6 }), duration: 168 }], gold);
assert.deepStrictEqual(a.extra, [7]);
ok('files lined up with tracks: partial albums, untitled files by number and length, recording ids, files that don’t belong');

// 4. Choosing the edition: the one the files were tagged with; else the one whose tracks fit.
const deluxe = rel('R3', 'Gold: Greatest Hits', 'ABBA', [[['Dancing Queen', 231], ['Knowing Me, Knowing You', 241], ['Take a Chance on Me', 244], ['Mamma Mia', 213], ['Lay All Your Love on Me', 274], ['Bonus', 200]]]);
const vinyl = rel('R4', 'Gold: Greatest Hits', 'ABBA', [[['Dancing Queen', 236], ['Knowing Me, Knowing You', 241]], [['Take a Chance on Me', 250], ['Mamma Mia', 213], ['Lay All Your Love on Me', 274]]], { formats: ['12" Vinyl'] });
let r = M.rankReleases({ album: 'Gold: Greatest Hits', artist: 'ABBA', votes: { R3: 3 } }, part, [gold, deluxe, vinyl]);
assert.strictEqual(r.best.release.id, 'R3', 'the edition the files say they are'); assert.ok(r.sure);
r = M.rankReleases({ album: 'Gold: Greatest Hits', artist: 'ABBA', votes: {} }, part, [vinyl, deluxe, gold]);
assert.ok(r.best.release.id === 'R1' || r.best.release.id === 'R3', 'an edition whose tracks fit: ' + r.best.release.id);
assert.notStrictEqual(r.best.release.id, 'R4', 'not the vinyl, whose sides number the tracks differently');
const full = gold.media[0].tracks.map((t, i) => ({ id: 20 + i, name: pad(i + 1) + ' ' + t.title + '.flac', tags: tg({ title: t.title, track: i + 1 }), duration: t.length }));
function pad(n) { return (n < 10 ? '0' : '') + n; }
r = M.rankReleases({ album: 'Gold: Greatest Hits', artist: 'ABBA', votes: {} }, full, [deluxe, gold]);
assert.strictEqual(r.best.release.id, 'R1', 'a full album is the edition with exactly its tracks, not the one with a bonus track');
ok('the edition: the one the files name; else the one whose tracks fit (exact track count for a full album)');

// 5. A loose song's home: the official album, not a compilation or live record.
const home = M.pickHome({ releases: [
  { id: 'c', status: 'Official', date: '2001', group: { primaryType: 'Album', secondaryTypes: ['Compilation'] } },
  { id: 'l', status: 'Official', date: '1999', group: { primaryType: 'Album', secondaryTypes: ['Live'] } },
  { id: 's', status: 'Official', date: '1998', group: { primaryType: 'Single', secondaryTypes: [] } },
  { id: 'a2', status: 'Official', date: '2005', group: { primaryType: 'Album', secondaryTypes: [] } },
  { id: 'a1', status: 'Official', date: '1998-03', group: { primaryType: 'Album', secondaryTypes: [] } },
  { id: 'b', status: 'Bootleg', date: '1990', group: { primaryType: 'Album', secondaryTypes: [] } }
] });
assert.strictEqual(home.id, 'a1');
ok('a loose song goes with its first official album');

// 6. Plex names and tags.
const t1 = M.tracksOf(gold)[0];
let n = M.plexName(gold, t1, 'ogg', { safeName: P.safeName });
assert.deepStrictEqual(n, { folder: ['Music', 'ABBA', 'Gold - Greatest Hits (1992)'], file: '01 - Dancing Queen.ogg' });
const two = rel('R5', 'GOLD SYMPHONY', 'AAA', [[['A', 200]], [['B', 200], ['Wake up!', 227]]]);
n = M.plexName(two, M.tracksOf(two)[2], 'mp3', { safeName: P.safeName, year: false });
assert.deepStrictEqual(n, { folder: ['Music', 'AAA', 'GOLD SYMPHONY'], file: '2-02 - Wake up!.mp3' }, 'several discs: 2-02');
const comp = rel('R6', 'Now 50', 'Various Artists', [[['Song', 200, 'r', 'Ginger Root']]], { compilation: true, artistIds: [M.VARIOUS] });
n = M.plexName(comp, M.tracksOf(comp)[0], 'flac', { safeName: P.safeName });
assert.deepStrictEqual(n, { folder: ['Music', 'Various Artists', 'Now 50 (1992)'], file: '01 - Ginger Root - Song.flac' });
const v = M.tagsFor(gold, t1, { genres: true });
assert.strictEqual(v.title, 'Dancing Queen'); assert.deepStrictEqual(v.albumArtists, ['ABBA']); assert.strictEqual(v.track, 1); assert.strictEqual(v.trackTotal, 5);
assert.strictEqual(v['mb.release'], 'R1'); assert.strictEqual(v['mb.recording'], 'rec-Dancing Queen'); assert.deepStrictEqual(v.genres, ['Pop']);
const d = M.tagDiff(tg({ title: 'Dancing Queen', artists: ['ABBA'], album: 'Gold', track: 1 }), v);
assert.deepStrictEqual(d.filter((x) => x.changed).map((x) => x.field), ['album', 'albumArtists', 'track', 'disc', 'year', 'genres', 'mb.release']);
assert.strictEqual(d.find((x) => x.field === 'track').after, '1 of 5');
ok('Plex names (several discs, compilations, year) and tags, with a clear before → after');

// 7. Nothing by name: recognised by their sound; each song on the track its recording is.
(async () => {
  const junk = [{ id: 31, name: 'AUD-2019-01.mp3', folders: ['Downloads'], tags: tg({}), duration: 213 }, { id: 32, name: 'AUD-2019-02.mp3', folders: ['Downloads'], tags: tg({}), duration: 231 }];
  const api = {
    release: (id) => Promise.resolve(id === 'R1' ? gold : null), search: () => Promise.resolve([]), recordings: () => Promise.resolve([]),
    sound: (fs) => Promise.resolve(fs.map((f) => ({ recordings: [{ id: f.id === 31 ? 'rec-Mamma Mia' : 'rec-Dancing Queen', score: 0.95, releases: [{ id: 'R1', status: 'Official', date: '1992', group: { primaryType: 'Album', secondaryTypes: ['Compilation'] } }] }] })))
  };
  const r = await M.lookAlbum(api, { guess: { album: 'Downloads', artist: '', votes: {} } }, junk, {});
  assert.strictEqual(r.how, 'sound', JSON.stringify(r.none || r.how));
  assert.deepStrictEqual(r.best.result.pairs.map((p) => [p.id, p.track.title]).sort(), [[31, 'Mamma Mia'], [32, 'Dancing Queen']]);
  // No key: the reason by name stands.
  const r2 = await M.lookAlbum(Object.assign({}, api, { sound: () => Promise.resolve(null) }), { guess: { album: 'Downloads', artist: '', votes: {} } }, junk, {});
  assert.ok(r2.none, 'not found, and says why');
  ok('nothing by name: recognised by their sound, each song on its own track');
  console.log(passed + ' music checks passed');
})().catch((e) => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
