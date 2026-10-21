// Fix My Plex Library's folder walk and Plex paging, against a pretend server (no SSH needed):
// same files in the same order however the answers arrive, progress as it goes, Stop, and Plex's
// pages fetched side by side once it says how many there are.
//   node tests/plexwalk.test.js
'use strict';
const assert = require('assert');
const F = require('../desktop/plexfix.js');

const tree = {
  '/lib': [['TV', 'd'], ['Movies', 'd'], ['.hidden', 'd'], ['@eaDir', 'd'], ['notes.txt', 'f']],
  '/lib/TV': [['Show B', 'd'], ['Show A', 'd'], ['Loop', 'L']],
  '/lib/TV/Show A': [['Season 1', 'd']],
  '/lib/TV/Show A/Season 1': [['a.s01e02.mkv', 'f'], ['a.s01e01.mkv', 'f'], ['a.s01e01.en.srt', 'f'], ['link.mkv', 'fl']],
  '/lib/TV/Show B': [['b.s01e10.mkv', 'f'], ['b.s01e9.mkv', 'f']],
  '/lib/TV/Loop': [['Loop', 'L']],
  '/lib/Movies': [['Broken', 'd'], ['m (1999).mp4', 'f']]
};
function session(delay) {
  let inFlight = 0, most = 0;
  return {
    get most() { return most; },
    entries(dir) {
      inFlight++; most = Math.max(most, inFlight);
      return new Promise((resolve, reject) => setTimeout(() => {
        inFlight--;
        if (/Loop(\/Loop)*$/.test(dir) && dir.split('/').length > 3) return resolve([['Loop', 'L']].map(toEntry));
        if (!tree[dir]) return reject(new Error('no such folder'));
        resolve(tree[dir].map(toEntry));
      }, delay(dir)));
    }
  };
}
function toEntry([name, k]) { return { name, dir: k === 'd' || k === 'L', file: k === 'f' || k === 'fl', size: 1, link: k === 'L' || k === 'fl' }; }

(async () => {
  const want = ['/lib/Movies/m (1999).mp4', '/lib/TV/Show A/Season 1/a.s01e01.en.srt', '/lib/TV/Show A/Season 1/a.s01e01.mkv', '/lib/TV/Show A/Season 1/a.s01e02.mkv', '/lib/TV/Show B/b.s01e9.mkv', '/lib/TV/Show B/b.s01e10.mkv'];
  for (const delay of [() => 1, (d) => (d.length * 7) % 13, (d) => 20 - d.length % 17]) {
    const s = session(delay), got = [], stats = { files: 0, unreadable: 0, truncated: false };
    let ticks = 0;
    await F.walk(s, '/lib', (f) => got.push(f.path), stats, () => ticks++);
    assert.deepStrictEqual(got, want, 'same files, same order, whatever order the server answers in');
    assert.ok(s.most > 1 && s.most <= 8, 'several folders read at once, at most 8 (' + s.most + ')');
    assert.ok(ticks >= 6 && stats.folders >= 6, 'progress after every folder');
    assert.strictEqual(stats.unreadable, 1, 'a folder that can\'t be read is counted, not fatal');
  }
  console.log('  ✓ parallel walk: same result as one-at-a-time, with progress');
  let stop = false;
  const got2 = [];
  await F.walk(session(() => 5), '/lib', (f) => got2.push(f.path), { files: 0, unreadable: 0 }, () => { stop = true; }, () => stop);
  assert.ok(got2.length < want.length, 'Stop ends the walk early');
  console.log('  ✓ Stop');

  // Plex paging: 2,500 items, 1,000 a page, the last two pages asked for side by side.
  const asked = [];
  let open = 0, most = 0;
  const plexS = { plex: (token, url) => {
    const start = Number(/Start=(\d+)/.exec(url)[1]); asked.push(start); open++; most = Math.max(most, open);
    return new Promise((r) => setTimeout(() => { open--; const n = Math.max(0, Math.min(1000, 2500 - start));
      r(JSON.stringify({ MediaContainer: { totalSize: 2500, Metadata: Array.from({ length: n }, (x, i) => ({ guid: i % 2 ? 'local://1' : 'plex://x', Media: [{ Part: [{ file: '/f/' + (start + i) }] }] })) } })); }, 10));
  } };
  const prog = [];
  const map = await F.plexFiles(plexS, 't', { key: '1', kind: 'tv' }, (d, t) => prog.push([d, t]));
  assert.strictEqual(map.size, 2500);
  assert.strictEqual(map.get('/f/1'), 'unmatched'); assert.strictEqual(map.get('/f/2'), 'matched');
  assert.deepStrictEqual(asked.slice().sort((a, b) => a - b), [0, 1000, 2000]);
  assert.ok(most >= 2, 'later pages side by side');
  assert.deepStrictEqual(prog[prog.length - 1], [2500, 2500], 'progress reaches the total');
  console.log('  ✓ Plex pages: 1,000 at a time, side by side, with progress');
  console.log('plexwalk: all passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
