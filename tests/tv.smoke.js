// End-to-end TV matching check with realistic TVmaze answers (mocked, so it runs offline).
// Run with: xvfb-run -a node tests/tv.smoke.js   (needs the "playwright" package)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require(process.env.PLAYWRIGHT || 'playwright');

const ROOT = path.join(__dirname, '..');
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real shapes from api.tvmaze.com (trimmed). Five shows are called "The Office".
const show = (id, name, premiered, weight, country) => ({ id, name, premiered, weight, network: country ? { name: 'Net', country: { code: country } } : null, url: 'https://www.tvmaze.com/shows/' + id });
const SEARCH = {
  'the office': [show(526, 'The Office', '2005-03-24', 99, 'US'), show(1292, 'The Office', '2001-07-09', 95, 'GB'), show(69044, 'The Office', '2024-10-18', 94, null), show(57704, 'The Office', '2019-06-28', 31, 'IN'), show(57168, 'The Office', '1995-03-11', 28, 'US'), show(80108, 'The Office Movers', '2024-10-11', 90, 'CA')],
  'breaking bad': [show(169, 'Breaking Bad', '2008-01-20', 99, 'US'), show(70000, 'Breaking Bad: Original Minisodes', '2009-02-17', 20, 'US')],
  'lost': [show(123, 'Lost', '2004-09-22', 98, 'US'), show(9999, 'Lost', '2001-01-01', 12, 'GB'), show(8888, 'Lost Girl', '2010-09-12', 80, 'CA')],
  'the daily show': [show(249, 'The Daily Show', '1996-07-22', 97, 'US')],
  'bonanza': [show(1, 'Bonanza', '1959-09-12', 90, 'US'), show(2, 'Bonanza', '2020-01-01', 6, 'AU')],
  'doctor who': [show(210, 'Doctor Who', '2005-03-26', 98, 'GB'), show(766, 'Doctor Who', '1963-11-23', 92, 'GB'), show(73000, 'Doctor Who', '2023-11-25', 90, 'GB')]
};
const F = require('./fixtures/cartoons.json');
const fx = (k) => F[k].map(([season, number, name, airdate, runtime]) => ({ season, number, name, airdate, runtime }));
SEARCH['spongebob squarepants'] = [Object.assign(show(713, 'SpongeBob SquarePants', '1999-05-01', 99, 'US'), { externals: { thetvdb: 75886 } })];
SEARCH['the fairly oddparents'] = [Object.assign(show(2565, 'The Fairly OddParents', '2001-03-30', 97, 'US'), { externals: { thetvdb: 76372 } }), show(53840, 'The Fairly OddParents: Fairly Odder', '2022-03-31', 60, 'US')];
const EPISODES = {
  713: fx('spongebob'), 2565: fx('fop'),
  526: [{ season: 2, number: 3, name: 'Office Olympics', airdate: '2005-10-04' }],
  1292: [{ season: 1, number: 1, name: 'Downsize', airdate: '2001-07-09' }, { season: 1, number: 2, name: 'Work Experience', airdate: '2001-07-16' }],
  169: [{ season: 1, number: 1, name: 'Pilot' }, { season: 1, number: 2, name: "Cat's in the Bag..." }, { season: 2, number: 1, name: 'Seven Thirty-Seven' }],
  123: [{ season: 1, number: 1, name: 'Pilot (1)' }, { season: 1, number: 2, name: 'Pilot (2)' }, { season: 1, number: 5, name: 'White Rabbit', airdate: '2004-10-20' }],
  249: [{ season: 29, number: 6, name: 'Guest Night', airdate: '2024-01-15' }],
  1: [{ season: 1, number: 1, name: 'A Rose for Lotta' }],
  210: [{ season: 1, number: 1, name: 'Rose' }], 766: [{ season: 1, number: 1, name: 'An Unearthly Child' }], 73000: []
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-tv-'));
  const dl = path.join(tmp, 'Downloads'); const lib = path.join(tmp, 'Plex');
  const files = [
    'The.Office.US.S02E03.720p.HDTV.x264-LOL.mkv',
    'the.office.s01e01.1080p.web-dl.mkv',
    'the.office.s01e02.1080p.web-dl.mkv',
    'Breaking Bad (2008)/Season 1/E01.mkv',
    "Breaking Bad (2008)/Season 1/02 - Cat's in the Bag.mkv",
    'Lost/Season 1/Lost.S01E01E02.Pilot.720p.BluRay.mkv',
    'Lost/Season 1/Lost.S01E01E02.Pilot.720p.BluRay.en.srt',
    'The.Daily.Show.2024.01.15.Guest.Night.720p.WEB.h264.mkv',
    'bonanza.s01e01.a.rose.for.lotta.mkv',
    'Doctor.Who.S01E01.mkv',
    // Half-hour files from a streaming service: two cartoons each, numbered by half-hour.
    'SpongeBob SquarePants/Season 1/SpongeBob.SquarePants.S01E02.Bubblestand.Ripped.Pants.1080p.WEB-DL.mkv',
    'SpongeBob SquarePants/Season 1/SpongeBob.SquarePants.S01E03.1080p.WEB-DL.mkv',
    // No titles, too few files to tell: Shelf must ask.
    'The Fairly OddParents/Season 2/The.Fairly.OddParents.S02E02.mkv',
    'The Fairly OddParents/Season 2/The.Fairly.OddParents.S02E03.mkv'
  ];
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(dl, f)), { recursive: true }); fs.writeFileSync(path.join(dl, f), 'v'); }
  fs.mkdirSync(lib);

  const requests = [];
  const handle = (route) => {
    const u = route.request().url();
    if (u.includes('api.tvmaze.com')) {
      requests.push(u.replace('https://api.tvmaze.com', ''));
      const sm = u.match(/search\/shows\?q=([^&]+)/);
      if (sm) {
        const q = decodeURIComponent(sm[1]);
        return route.fulfill({ status: 200, body: JSON.stringify((SEARCH[q] || []).map((s, i) => ({ score: 1.2 - i * 0.01, show: s }))), headers: H });
      }
      const em = u.match(/shows\/(\d+)\/episodes/);
      return route.fulfill({ status: 200, body: JSON.stringify(EPISODES[em[1]] || []), headers: H });
    }
    return route.continue();
  };

  const errors = [];
  const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-')), ROOT] });
  await app.evaluate(({ dialog }, dirs) => { const q = [...dirs]; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [q.shift()] }); }, [dl, lib]);
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.route('**/*', handle);
  await win.waitForLoadState();

  // Turn on "Add quality to file names".
  await win.click('.side-item[data-open=settings]');
  await win.check('#optQuality');
  await win.keyboard.press('Escape'); await sleep(300);

  const t0 = Date.now();
  await win.click('text=Choose Folder…');
  const settled = () => win.evaluate(() => window.Shelf.items().length > 0 && window.Shelf.items().every((x) => !['pending', 'matching'].includes(x.status)));
  for (let i = 0; i < 80 && !(await settled()); i++) await sleep(100);
  const took = Date.now() - t0;
  await sleep(300); // let the list redraw

  const state = () => win.evaluate(() => {
    const out = {};
    window.Shelf.items().forEach((i) => { out[i.name] = { status: i.status, confirmed: i.confirmed, error: i.error, to: (document.querySelector('[data-id="' + i.id + '"]') || {}).textContent }; });
    return out;
  });
  let s = await state();
  console.log('matched in', took, 'ms with', requests.length, 'TVmaze requests:\n ', requests.join('\n  '));
  for (const [k, v] of Object.entries(s)) console.log(' ', v.status.padEnd(8), v.confirmed ? 'confirmed' : '         ', k, v.error ? '— ' + v.error : '');

  const ready = (n) => s[n].status === 'matched' || (s[n].status === 'review' && s[n].confirmed);
  assert.ok(ready('The.Office.US.S02E03.720p.HDTV.x264-LOL.mkv'), 'The Office US should match by itself');
  assert.strictEqual(s['the.office.s01e01.1080p.web-dl.mkv'].status, 'review', 'plain "The Office" should ask');
  assert.match(s['the.office.s01e01.1080p.web-dl.mkv'].error, /look alike/, 'and say why');
  assert.ok(ready('E01.mkv') && ready("02 - Cat's in the Bag.mkv"), 'Season folder episodes should match');
  assert.ok(ready('Lost.S01E01E02.Pilot.720p.BluRay.mkv'), 'Lost (far better known) should match');
  assert.ok(ready('The.Daily.Show.2024.01.15.Guest.Night.720p.WEB.h264.mkv'), 'Daily show by date');
  assert.ok(ready('bonanza.s01e01.a.rose.for.lotta.mkv'), 'Bonanza: obscure namesake should not block');
  assert.strictEqual(s['Doctor.Who.S01E01.mkv'].status, 'review', 'Doctor Who has three real versions: ask');
  const searches = requests.filter((r) => r.includes('search')).length;
  assert.strictEqual(searches, 8, 'one search per show, got ' + searches);
  assert.ok(ready('SpongeBob.SquarePants.S01E02.Bubblestand.Ripped.Pants.1080p.WEB-DL.mkv') && ready('SpongeBob.SquarePants.S01E03.1080p.WEB-DL.mkv'), 'SpongeBob half-hours');
  const fopA = 'The.Fairly.OddParents.S02E02.mkv';
  assert.strictEqual(s[fopA].status, 'review', 'unsure numbering must ask');
  assert.ok(/one cartoon or a whole half-hour/.test(s[fopA].error), s[fopA].error);
  // Answer once: "A half-hour" — both files follow.
  await win.evaluate((n) => { const it = window.Shelf.items().find((i) => i.name === n); document.querySelector('[data-id="' + it.id + '"]').click(); }, fopA);
  await sleep(200);
  assert.ok(await win.isVisible('#inspSegWrap'), 'chooser visible');
  await win.click('#inspSeg button[data-mode=halfhours]');
  await sleep(300);
  s = await state();
  assert.ok(ready(fopA) && ready('The.Fairly.OddParents.S02E03.mkv'), 'FOP ready after choosing');

  // Pick the UK Office once, for one episode — the other episode should follow.
  await win.evaluate(() => { const it = window.Shelf.items().find((i) => i.name === 'the.office.s01e01.1080p.web-dl.mkv'); document.querySelector('[data-id="' + it.id + '"]').click(); });
  await sleep(200);
  await win.click('#inspCands .cand:has-text("(2001)")');
  await sleep(1200);
  s = await state();
  assert.ok(ready('the.office.s01e02.1080p.web-dl.mkv'), 'second Office episode should follow the pick');

  await win.click('#renameBtn');
  await win.click('#pickLib'); await sleep(300);
  await win.click('#renameNow'); await sleep(1500);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(lib, path.join(d, e.name)).split(path.sep).join('/')]);
  const got = walk(lib).sort();
  console.log('library:\n ', got.join('\n  '));
  const want = [
    // Another show shares the name, so the year goes in (as Plex recommends).
    'TV Shows/Bonanza (1959)/Season 01/Bonanza (1959) - S01E01 - A Rose for Lotta.mkv',
    "TV Shows/Breaking Bad/Season 01/Breaking Bad - S01E01 - Pilot.mkv",
    "TV Shows/Breaking Bad/Season 01/Breaking Bad - S01E02 - Cat's in the Bag.mkv", // Windows drops trailing dots
    'TV Shows/Lost (2004)/Season 01/Lost (2004) - S01E01-E02 - Pilot [720p BluRay].en.srt',
    'TV Shows/Lost (2004)/Season 01/Lost (2004) - S01E01-E02 - Pilot [720p BluRay].mkv',
    'TV Shows/The Daily Show/Season 29/The Daily Show - S29E06 - Guest Night [720p WEB].mkv',
    'TV Shows/The Office (2001)/Season 01/The Office (2001) - S01E01 - Downsize [1080p WEB-DL].mkv',
    'TV Shows/The Office (2001)/Season 01/The Office (2001) - S01E02 - Work Experience [1080p WEB-DL].mkv',
    'TV Shows/The Office (2005)/Season 02/The Office (2005) - S02E03 - Office Olympics [720p HDTV].mkv',
    // The two-part cartoons, named the way Plex lists them:
    'TV Shows/SpongeBob SquarePants {tvdb-75886}/Season 01/SpongeBob SquarePants - S01E04-E05 - Bubblestand & Ripped Pants [1080p WEB-DL].mkv',
    'TV Shows/SpongeBob SquarePants {tvdb-75886}/Season 01/SpongeBob SquarePants - S01E06-E07 - Jellyfishing & Plankton! [1080p WEB-DL].mkv',
    'TV Shows/The Fairly OddParents {tvdb-76372}/Season 02/The Fairly OddParents - S02E03-E04 - Boy Toys & Inspection Detection.mkv',
    'TV Shows/The Fairly OddParents {tvdb-76372}/Season 02/The Fairly OddParents - S02E05-E06 - Action Packed & Smarty Pants.mkv'
  ];
  const missing = want.filter((w) => !got.includes(w));
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ERRORS:', errors);
  assert.deepStrictEqual(missing, [], 'missing from library');
  assert.deepStrictEqual(errors, []);
  console.log('TV test passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
