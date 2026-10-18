// Remembered lookups: the same show isn't looked up again in the next session, answers expire,
// "Forget" forgets, keys are never stored, and an id in the folder name skips the search.
// Run with: node tests/remember.test.js   (the services are faked: nothing goes online)
const assert = require('assert');
const path = require('path');
const R = require('../app/js/remember.js').ShelfRemember;

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, '\n ', e.message); }
}

// The services, in their documented shapes.
const asked = [];
let broken = false;
const today = new Date().toISOString().slice(0, 10);
const ANSWERS = [
  [/api\.tvmaze\.com\/search\/shows\?q=lost$/, () => [{ score: 0.9, show: { id: 123, name: 'Lost', premiered: '2004-09-22', weight: 99, externals: { thetvdb: 73739 }, url: 'https://www.tvmaze.com/shows/123/lost' } }]],
  [/api\.tvmaze\.com\/search\/shows\?q=nothing/, () => []],
  [/api\.tvmaze\.com\/shows\/123\/episodes/, () => [{ season: 1, number: 1, name: 'Pilot (1)', airdate: '2004-09-22', runtime: 42 }, { season: 1, number: 2, name: 'Pilot (2)', airdate: '2004-09-29', runtime: 42 }]],
  [/api\.tvmaze\.com\/shows\/555\/episodes/, () => [{ season: 1, number: 1, name: 'New', airdate: today, runtime: 30 }]],
  [/api\.tvmaze\.com\/lookup\/shows\?thetvdb=73739$/, () => ({ id: 123, name: 'Lost', premiered: '2004-09-22', weight: 99, externals: { thetvdb: 73739 } })],
  [/api\.themoviedb\.org\/3\/search\/movie\?/, () => ({ results: [{ id: 603, title: 'The Matrix', original_title: 'The Matrix', release_date: '1999-03-30', popularity: 50 }] })],
  [/api\.themoviedb\.org\/3\/movie\/603\?/, () => ({ id: 603, title: 'The Matrix', original_title: 'The Matrix', release_date: '1999-03-30', popularity: 50 })],
  [/api\.themoviedb\.org\/3\/tv\/4607\?append_to_response=season%2F0%2C/, () => ({
    id: 4607, name: 'Lost', original_name: 'Lost', first_air_date: '2004-09-22', popularity: 80, origin_country: ['US'], number_of_seasons: 1,
    'season/1': { episodes: [{ season_number: 1, episode_number: 1, name: 'Pilot (1)', air_date: '2004-09-22' }, { season_number: 1, episode_number: 2, name: 'Pilot (2)', air_date: '2004-09-29' }] }
  })]
];
global.fetch = async (url) => {
  asked.push(url);
  if (broken) return { ok: false, status: 500, json: async () => ({}) };
  const a = ANSWERS.find(([re]) => re.test(url));
  if (!a) return { ok: false, status: 404, json: async () => null };
  const body = a[1]();
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
};

// One store on "disk" shared by every session (a fresh copy of sources.js is a new session).
const disk = new Map();
const backend = {
  get: async (k) => disk.get(k),
  put: async (k, rec) => { disk.set(k, JSON.parse(JSON.stringify(rec))); },
  del: async (k) => { disk.delete(k); },
  clear: async () => { disk.clear(); },
  sweep: async (t) => { for (const [k, r] of disk) if (!(r.until > t)) disk.delete(k); }
};
let now = Date.now();
const clock = () => now;
const DAY = 864e5;
function session(store) {
  const file = require.resolve('../app/js/sources.js');
  delete require.cache[file];
  const S = require(file).ShelfSources;
  S.rememberIn(store === undefined ? R.create(backend, clock) : store);
  return S;
}
const TVMAZE = { order: 'tvmaze' };
const count = async (fn) => { const before = asked.length; const v = await fn(); return { v, n: asked.length - before }; };

(async () => {
  let first;
  await check('first session asks the service once per show', async () => {
    const S = session();
    const a = await count(() => S.searchShowsFor('Lost', TVMAZE));
    const b = await count(() => S.searchShowsFor('LOST ', TVMAZE));
    const eps = await count(() => S.getEpisodeList(a.v[0], TVMAZE));
    assert.strictEqual(a.n, 1); assert.strictEqual(b.n, 0); assert.strictEqual(eps.n, 1);
    assert.strictEqual(eps.v.rememberedAt, undefined, 'a fresh answer isn’t marked as remembered');
    first = { cands: a.v, eps: eps.v };
  });
  await check('next session: no requests at all, identical answers', async () => {
    const S = session();
    const a = await count(() => S.searchShowsFor('Lost', TVMAZE));
    const eps = await count(() => S.getEpisodeList(a.v[0], TVMAZE));
    assert.strictEqual(a.n + eps.n, 0, 'asked again: ' + asked.slice(-2));
    assert.deepStrictEqual(a.v, first.cands);
    assert.deepStrictEqual(eps.v, first.eps);
    assert.ok(eps.v.rememberedAt > 0, 'marked as remembered');
  });
  await check('each answer is a copy (changing one never changes the next)', async () => {
    const S = session();
    const a = await S.searchShowsFor('Lost', TVMAZE);
    a[0].title = 'changed';
    assert.strictEqual((await S.searchShowsFor('Lost', TVMAZE))[0].title, 'Lost');
  });
  await check('episode lists expire after a week, searches after 30 days', async () => {
    now += 8 * DAY;
    let S = session();
    const a = await count(() => S.searchShowsFor('Lost', TVMAZE));
    const eps = await count(() => S.getEpisodeList(a.v[0], TVMAZE));
    assert.strictEqual(a.n, 0, 'search still remembered'); assert.strictEqual(eps.n, 1, 'list asked again');
    now += 31 * DAY;
    S = session();
    assert.strictEqual((await count(() => S.searchShowsFor('Lost', TVMAZE))).n, 1, 'search asked again');
  });
  await check('a show still airing: its list is kept for a day; nothing found: a day', async () => {
    let S = session();
    await S.getEpisodeList({ source: 'TVmaze', id: 555 }, TVMAZE);
    await S.searchShowsFor('Nothing Here', TVMAZE);
    now += DAY / 2;
    S = session();
    assert.strictEqual((await count(() => S.getEpisodeList({ source: 'TVmaze', id: 555 }, TVMAZE))).n, 0);
    assert.strictEqual((await count(() => S.searchShowsFor('Nothing Here', TVMAZE))).n, 0);
    now += DAY;
    S = session();
    assert.strictEqual((await count(() => S.getEpisodeList({ source: 'TVmaze', id: 555 }, TVMAZE))).n, 1);
    assert.strictEqual((await count(() => S.searchShowsFor('Nothing Here', TVMAZE))).n, 1);
  });
  await check('fresh: asks again even when remembered', async () => {
    const c = (await session().searchShowsFor('Lost', TVMAZE))[0];
    await session().getEpisodeList(c, TVMAZE);
    const S = session();
    assert.ok((await S.getEpisodeList(c, TVMAZE)).rememberedAt);
    const f = await count(() => S.getEpisodeList(c, TVMAZE, { fresh: true }));
    assert.strictEqual(f.n, 1);
    assert.strictEqual(f.v.rememberedAt, undefined);
  });
  await check('Forget Remembered Lookups: everything is asked afresh', async () => {
    let S = session();
    await S.forgetRemembered();
    assert.strictEqual(disk.size, 0);
    S = session();
    assert.strictEqual((await count(() => S.searchShowsFor('Lost', TVMAZE))).n, 1);
  });
  await check('your keys are never stored', async () => {
    const S = session();
    await S.searchMovies('The Matrix', 1999, 'SECRET-TMDB-KEY');
    await S.showByIdFor({ tmdb: 4607 }, { order: 'tmdb', tmdb: 'SECRET-TMDB-KEY' });
    assert.ok(asked.some((u) => u.includes('SECRET-TMDB-KEY')), 'the key was used');
    assert.ok(!JSON.stringify([...disk]).includes('SECRET'), 'stored: ' + [...disk.keys()]);
  });
  await check('failed lookups are not remembered', async () => {
    const S = session();
    broken = true;
    await assert.rejects(S.searchShowsFor('Broken Show', TVMAZE));
    broken = false;
    assert.strictEqual((await count(() => S.searchShowsFor('Broken Show', TVMAZE))).n, 1);
  });
  await check('no storage: lookups still work, just not remembered', async () => {
    const dead = R.create({ get: () => Promise.reject(new Error('x')), put: () => Promise.reject(new Error('x')), del: () => Promise.reject(new Error('x')), clear: () => Promise.reject(new Error('x')) });
    const S = session(dead);
    const a = await count(() => S.searchShowsFor('Lost', TVMAZE));
    assert.strictEqual(a.n, 1); assert.strictEqual(a.v[0].title, 'Lost');
    await S.forgetRemembered();
  });

  // ---- Ids in folder names ----
  await check('TVmaze: {tvdb-N} is looked up directly, never searched', async () => {
    await session().forgetRemembered();
    const S = session();
    const r = await count(() => S.showByIdFor({ tvdb: 73739 }, TVMAZE));
    assert.strictEqual(r.n, 1);
    assert.ok(/lookup\/shows\?thetvdb=73739$/.test(asked[asked.length - 1]));
    assert.strictEqual(r.v.length, 1); assert.strictEqual(r.v[0].id, 123); assert.strictEqual(r.v[0].tvdbId, 73739); assert.ok(r.v[0].byId);
    assert.strictEqual((await count(() => session().showByIdFor({ tvdb: 73739 }, TVMAZE))).n, 0, 'remembered next session');
  });
  await check('TMDB: {tmdb-N} costs one request for the show and its episodes together', async () => {
    const S = session();
    const keys = { order: 'tmdb', tmdb: 'k' };
    const r = await count(async () => { const c = await S.showByIdFor({ tmdb: 4607 }, keys); return { c, eps: await S.getEpisodeList(c[0], keys) }; });
    assert.strictEqual(r.n, 1, asked.slice(-r.n).join('\n'));
    assert.strictEqual(r.v.c[0].title, 'Lost'); assert.strictEqual(r.v.c[0].year, 2004); assert.strictEqual(r.v.c[0].source, 'TMDB');
    assert.deepStrictEqual(r.v.eps.map((e) => e.name), ['Pilot (1)', 'Pilot (2)']);
  });
  await check('movies: {tmdb-N} is looked up directly', async () => {
    const S = session();
    const r = await count(() => S.movieById(603, 'k'));
    assert.strictEqual(r.n, 1); assert.strictEqual(r.v[0].title, 'The Matrix'); assert.strictEqual(r.v[0].year, 1999); assert.ok(r.v[0].byId);
    assert.deepStrictEqual(await S.movieById(603, ''), [], 'no key: nothing (Shelf searches as usual)');
  });
  await check('TheTVDB order, or an id the service can’t look up: no direct lookup (searched instead)', async () => {
    const S = session();
    const r = await count(async () => [await S.showByIdFor({ tvdb: 73739 }, { order: 'tvdb', tvdb: 'k' }), await S.showByIdFor({ tmdb: 4607 }, TVMAZE)]);
    assert.strictEqual(r.n, 0); assert.deepStrictEqual(r.v, [[], []]);
  });

  // ---- The store itself ----
  await check('store: expired answers are swept once per session', async () => {
    const b = R.memoryBackend();
    let t = 1000;
    const s1 = R.create(b, () => t);
    await s1.set('a', [1], 1); await s1.set('b', [2], 30);
    assert.deepStrictEqual((await s1.get('a')).v, [1]);
    t += 2 * DAY;
    assert.strictEqual(await s1.get('a'), null);
    const s2 = R.create(b, () => t);
    await s2.get('zzz'); await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(b.size(), 1);
    assert.deepStrictEqual((await s2.get('b')).v, [2]);
  });

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
