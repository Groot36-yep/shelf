// The automatic episode namer in harder situations, from real readings and real lists (Phineas and Ferb, Cake Boss):
// how many episodes a video holds, credits and logos read on title cards, another season's titles, words heard
// that happen to be in a title, and videos with no episode number in a season's folder.
// Run with: node tests/namer.test.js
'use strict';
const assert = require('assert');
const P = require('../app/js/parser.js');
const scan = require('../desktop/scan.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('FAIL', name, '\n  ', e.message); }
}

// Part of Phineas and Ferb's list as TVmaze has it (its own order; every cartoon "15 minutes", the double-length
// ones 30).
const pf = [
  [1, 1, 'Rollercoaster', 15], [1, 2, 'Lawn Gnome Beach Party of Terror', 15], [1, 3, 'Flop Starz', 15],
  [1, 7, 'Candace Loses Her Head', 15], [1, 13, 'Are You My Mummy?', 15], [1, 21, "It's About Time!", 30],
  [1, 27, 'Crack That Whip', 15], [1, 28, 'The Best Lazy Day Ever', 15], [1, 31, "A Hard Day's Knight", 15],
  [1, 34, 'Got Game?', 15], [1, 45, 'Phineas and Ferb Get Busted!', 30], [1, 46, 'Unfair Science Fair', 15],
  [2, 35, 'What Do It Do?', 15], [2, 58, 'Ladies and Gentlemen, Meet Max Modem!', 15],
  [3, 1, 'Phineas and Ferb Interrupted', 30], [4, 12, 'Bee Story', 15]
].map(([season, number, name, runtime]) => ({ season, number, name, runtime }));
const season1 = pf.filter((e) => e.season === 1);
const SHOW = 'Phineas and Ferb';

check('a 23-minute video of a show listed at 15 minutes a cartoon holds two (TV slots, not running times)', () => {
  assert.strictEqual(scan.runSecs(15), 675);
  assert.strictEqual(scan.partsIn(1362, 15), 2, 'Phineas and Ferb: two cartoons');
  assert.strictEqual(scan.partsIn(1362, 30), 1, 'a half-hour show listed at 30: one');
  assert.strictEqual(scan.partsIn(1320, 22), 1, 'listed at its running time: one');
  assert.strictEqual(scan.partsIn(1380, 11), 2, 'SpongeBob listed at 11: two');
  assert.strictEqual(scan.partsIn(1320, 7), 3, '7-minute shorts: three');
  assert.strictEqual(scan.partsIn(2580, 60), 1, 'a 43-minute documentary listed at an hour: one');
  assert.strictEqual(scan.partsIn(1320, 0), 0, 'no length listed: not known');
  assert.strictEqual(scan.windowsFor(1362, 2).length, 2);
  assert.strictEqual(scan.windowsFor(1320, 3).length, 3);
  assert.strictEqual(scan.windowsFor(1320, 0).length, 2, 'not known: by the video’s length');
});

check('opening credits ("Story By", "Storyboards By") never name an episode', () => {
  assert.strictEqual(P.matchCardText(['Story By A) Jon Colton Barry Martin Olson', 'pre Story By n Colton Barry 7 Martin Olsen'], pf, [], SHOW), null);
  assert.strictEqual(P.matchCardText(['~] J Storyboards By ( J] Jor Barry lus,', 'Storvbsards By ~2r Barry Pers Big,'], pf, [], SHOW), null);
  // ...but a title read next to them still counts.
  const m = P.matchCardText(['Story By Jon Colton Barry', '“Are You My Mummy?"'], pf, [], SHOW);
  assert.strictEqual(m && m.entry.name, 'Are You My Mummy?');
});

check('a title that starts with the show’s name is judged by the rest of it', () => {
  const texts = ['> a - a A ‘Peingas cid Terk “ Ger Busteal’ —', '‘Snineas end Fob Vw, Got Busted!”', '(=) IE i 7 = —— Cet Busted'];
  const m = P.matchCardText(texts, pf, [], SHOW);
  assert.strictEqual(m && m.entry.name, 'Phineas and Ferb Get Busted!');
  // The logo on its own is none of those titles.
  assert.strictEqual(P.matchCardText(['Phineas and Ferb', 'PHINEAS AND FERB'], pf, [], SHOW), null);
});

check('a title from a season far from the file’s needs to be read almost perfectly; the next season is close enough', () => {
  const near1 = pf.filter((e) => Math.abs(e.season - 1) <= 1);
  assert.strictEqual(P.matchCardText(['BEE STQRV'], pf, [], SHOW, near1), null, 'a rough fourth-season title in a first-season file');
  const clear = P.matchCardText(['"Bee Story"'], pf, [], SHOW, near1);
  assert.strictEqual(clear && clear.entry.name, 'Bee Story', 'read clearly, it still counts');
  const next = P.matchCardText(['"Ladies and Gentlemen, Meet Max Modem!"'], pf, [], SHOW, near1);
  assert.strictEqual(next && next.entry.name, 'Ladies and Gentlemen, Meet Max Modem!', 'the next season’s');
});

check('very short everyday words don’t make a title ("WHAT should we do today?" isn’t "What Do It Do?")', () => {
  assert.strictEqual(P.matchCardText(['Today? | “_” WHAT Should we do Today?'], pf, [], SHOW), null);
  const clear = P.matchCardText(['"What Do It Do?"'], pf, [], SHOW);
  assert.strictEqual(clear && clear.entry.name, 'What Do It Do?', 'read clearly, it still counts');
});

check('letters scattered through a long smudge don’t make a short title', () => {
  assert.strictEqual(P.matchCardText(['Nd bg Pl ~ [ec', 'Po Eee] ry', '& 4 rg Jig A; ESLER we NL'], pf, season1, SHOW), null);
});

// Readings of one frame of "No More Bunny Business & Spa Day" (S02E28-E29), 12 minutes in: the second cartoon's credit,
check('a one-word title isn’t made of letters from two different words ("Sou DwArd" isn’t "UpWard")', () => {
  const sb = [[5, 33, 'The Two Faces of Squidward'], [15, 4, 'UpWard'], [3, 10, 'Gary in Love']].map(([season, number, name]) => ({ season, number, name }));
  assert.strictEqual(P.matchCardText(['0 Frcs of 0', "Tho Th O'Faces oF i Iy G", '{ TxD Sou DwArd'], sb, null, 'SpongeBob SquarePants'), null);
  assert.strictEqual((P.matchCardText(['UPWARD'], sb) || {}).entry, sb[1], 'the card itself still names it');
  assert.strictEqual((P.matchCardText(['garyinlove'], sb) || {}).entry, sb[2], 'and words the reader ran together still count');
});

// "Story By Jennifer Keene", where OCR lost the "By" now and then ("Story" ≈ "Storm", "Zim pert ee" ≈ "Imperfect").
const keene = ['1 w 42 Pf 534 Sennifor Keane Story Br', 'a. oy r. ~ He = hd xz S*zry By Jennifer Keene', 'Tag ~ gt hs fd Story By ~ennifer Keene',
  '= re I # ~ PEE _—— Zim pert ee — A »', 'Py 3 Story Jennifer Keane —', 'Wi 04 5 (4 Ji Ay |— VY - >) Ceo J =) Story, By. Jennifer Keene'];
const pf2 = pf.concat([[2, 28, 'No More Bunny Business'], [2, 29, 'Spa Day'], [4, 32, 'Imperfect Storm']].map(([season, number, name]) => ({ season, number, name, runtime: 15 })));
check('words on screen in many of a show’s videos (its credits) don’t count towards a title, once learned', () => {
  // Before anything is learned, as before: the credit passes for "Imperfect Storm".
  assert.strictEqual((P.matchCardText(keene, pf2, [], SHOW) || {}).entry, pf2.find((e) => e.name === 'Imperfect Storm'));
  assert.deepStrictEqual(P.matchCardText(keene, pf2, [], SHOW, null, []), P.matchCardText(keene, pf2, [], SHOW), 'nothing learned: no change');
  const usual = ['story', 'by', 'written', 'storyboard', 'jennifer', 'keene'];
  assert.strictEqual(P.matchCardText(keene, pf2, [], SHOW, null, usual), null, 'the credit isn’t "Imperfect Storm"');
  assert.strictEqual(P.matchCardText(keene, pf2, pf2, SHOW, null, ['story']), null, '"story" alone is enough, near or not');
  // The real card still is, and a title with one of those words in it ("Bee Story") still counts it.
  const spa = P.matchCardText(['- NPA ce Fe, —', '~~ I — — = ‘Sp: Day’ -n'], pf2, [], SHOW, null, usual);
  assert.strictEqual(spa && spa.entry.name, 'Spa Day');
  const bee = P.matchCardText(['"Bee Story"'], pf2, [], SHOW, null, usual);
  assert.strictEqual(bee && bee.entry.name, 'Bee Story');
  const storm = P.matchCardText(['“Imperfect Storm”'], pf2, [], SHOW, null, usual);
  assert.strictEqual(storm && storm.entry.name, 'Imperfect Storm');
  // What a video adds towards them: what it read besides the titles found in it, each word once.
  assert.deepStrictEqual(P.otherCardWords(['Story By Jennifer Keene', 'STORY BY JENNIFER KEENE', '“No More Bunny Business”'], ['No More Bunny Business']),
    ['story', 'jennifer', 'keene']);
});

// What's said at the start, against descriptions (TVmaze's, trimmed).
const told = (text) => ({ text, lines: text.split(/(?<=[.?!])\s+/).map((t, i) => ({ t: i * 4, text: t })) });
const pfAbout = pf.map((e) => Object.assign({}, e, {
  about: { 'The Best Lazy Day Ever': 'Phineas and Ferb decide to do absolutely nothing all day, which makes Candace suspicious that they are doing something.',
    'Ladies and Gentlemen, Meet Max Modem!': 'Phineas and Ferb help a fading rock star get back on stage.',
    'Are You My Mummy?': 'The boys search for a mummy in the backyard pyramid.',
    'Crack That Whip': 'Candace leads her Fireside Girls troop while the boys build a giant whip.' }[e.name] || '' }));
check('dialogue that happens to hold some of a title’s words isn’t that episode', () => {
  assert.strictEqual(P.matchHeard(told('Good evening, ladies and gentlemen. Welcome to the show. Tonight we have a very special guest for you all. Please give a big hand.'), pfAbout, { seasons: [1] }), null);
  assert.strictEqual(P.matchHeard(told('That was the best Cirque I have ever been to. I am not finished. You are doing absolutely nothing. That does not sound like you. Who wants to hear my CD?'), pfAbout, { seasons: [1] }), null);
});

check('one whole part of a title said word for word names it, even with no description (Mythbusters)', () => {
  const myths = [{ season: 2, number: 9, name: 'Explosive Decompression, Frog Giggin\', Rear Axle', about: '' }];
  ['cars', 'boats', 'planes', 'guns', 'bridges', 'trains'].forEach((t, k) => [1, 2, 3, 4, 5, 6].forEach((n) =>
    myths.push({ season: 3, number: k * 6 + n, name: 'The ' + t + ' myth ' + n, about: 'Adam and Jamie test whether ' + t + ' can ' + ['fly', 'sink', 'explode', 'melt', 'float', 'spin'][n - 1] + '.' })));
  const m = P.matchHeard(told('Tonight on Mythbusters, as we test the myth of explosive decompression. Adam and Jamie fill a plane cabin and shoot a hole in the window. Plus a frog and a truck axle.'), myths);
  assert.strictEqual(m && m.entry.number, 9);
});

check('two unusual words of a title heard still name it ("hic" and "boom": Dora’s "Hic-Boom-Ohhh")', () => {
  const dora = [{ season: 1, number: 3, name: 'Hic-Boom-Ohhh', about: 'Dora and Boots hear a strange sound coming from Yellow Valley.' }];
  ['beach', 'river', 'mountain', 'castle', 'farm', 'garden', 'forest', 'island'].forEach((p, k) => [1, 2, 3, 4].forEach((n) =>
    dora.push({ season: 2, number: k * 4 + n, name: 'The ' + p + ' ' + ['Party', 'Race', 'Picnic', 'Parade'][n - 1], about: 'Dora and Boots go to the ' + p + ' for a ' + ['party', 'race', 'picnic', 'parade'][n - 1] + '.' })));
  const m = P.matchHeard(told('Hic! Did you hear that? Boom! It is coming from Yellow Valley. Somebody has the hiccups. Hic! Boom! We have to help.'), dora);
  assert.strictEqual(m && m.entry.name, 'Hic-Boom-Ohhh');
});

// Cake Boss (TVmaze): a reality show, recognised by what's said.
const cb = [
  [1, 4, 'Weddings, Water and Whacked!', 'The team is asked to make a roulette table cake for a local businessman. It is also the start of wedding season and the cake orders are piling up.'],
  [1, 8, 'Museum, Mistakes, and Mother Mary', "Buddy and the team make a prehistoric mammal cake to celebrate a museum's recent discovery, and a scrumptious Sweet 16 cake proves complicated."],
  [1, 12, 'Leaning, Lobsters and Lectures', 'Buddy creates a Leaning Tower of Pisa wedding cake; after a client mixes up the date, Buddy must create a lobster-themed cake at the last minute.'],
  [4, 31, 'Coffins, Costumes and a Cake on a Gurney', 'Buddy makes a coffin cake for a haunted house and a model of a hospital gurney.'],
  [2, 15, 'Chimps, Cinema, and Crumb Cake', 'A chimpanzee sanctuary cake, a movie theater cake and crumb cake for the crew.']
].map(([season, number, name, about]) => ({ season, number, name, about, runtime: 30 }));
// (A real list is long: the rest of the show's episodes, about everything else Buddy's bakery makes.)
const things = ['castle', 'guitar', 'firetruck', 'pirate ship', 'race car', 'snowman', 'carousel', 'jukebox', 'volcano', 'robot', 'piano',
  'train set', 'lighthouse', 'rocket', 'football stadium', 'teapot', 'dragon', 'pinball machine', 'bowling alley', 'treehouse'];
things.forEach((t, k) => [0, 1, 2].forEach((j) => cb.push({ season: 3 + j, number: k + 1, runtime: 30,
  name: t.replace(/\w/g, (c) => c.toUpperCase()) + ' ' + ['Cake', 'Surprise', 'Party'][j],
  about: 'Buddy and the crew build a ' + t + ' cake for a ' + ['birthday', 'wedding', 'charity gala'][j] + ' while the family argues about the bakery.' })));
check('a reality show’s episode, from what’s said about the cake', () => {
  const m = P.matchHeard(told('On this episode of Cake Boss. We all trip to the museum. They found this fossil of this mammal, so they wanted me to recreate it out of cake. Dinosaur there, tree there. So what is the occasion? Sweet sixteen. They called from the Museum of Natural History in New York, and he said we need a cake.'), cb);
  assert.strictEqual(m && m.entry.name, 'Museum, Mistakes, and Mother Mary');
  const m2 = P.matchHeard(told('I will make a long green roulette table, with the chips and the wheel. Wedding season is starting, the orders are piling up.'), cb);
  assert.strictEqual(m2 && m2.entry.name, 'Weddings, Water and Whacked!');
});

// Paths: a video in a season's folder is an episode even without a number in its name.
const path = (f, d) => { const r = P.parsePath(f, d); return [r.kind, r.title, r.season, r.episode, r.episodeTitle].join('|'); };
check('a video without an episode number in a season’s folder is still one of the show’s episodes', () => {
  assert.strictEqual(path('Cake Boss - recording A.mkv', ['Cake Boss', 'Season 1']), 'episode|Cake Boss|1||recording A');
  assert.strictEqual(path('A Bride, a Boat and Bamboozled.mkv', ['Cake Boss', 'Season 01']), 'episode|Cake Boss|1||A Bride, a Boat and Bamboozled');
  assert.strictEqual(path('Cake Boss - The Big Day.mkv', ['Downloads', 'Cake Boss S01']), 'episode|Cake Boss|1||The Big Day');
  assert.strictEqual(path('Phineas and Ferb - 1x07.mkv', ['Phineas and Ferb', 'Season 1']), 'episode|Phineas and Ferb|1|7|');
  // A folder that says nothing about seasons keeps a movie a movie.
  assert.strictEqual(P.parsePath('Harry Potter and the Chamber of Secrets.mkv', ['Movies', 'Harry Potter']).kind, 'movie');
  assert.strictEqual(P.parsePath('The Matrix (1999).mkv', ['Movies']).kind, 'movie');
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
