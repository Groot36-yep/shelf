// Recognising an episode from what's said at its start (parser.js matchHeard).
// Run with: node tests/heard.test.js
const assert = require('assert');
const P = require('../app/js/parser.js');

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

// A show's list as TVmaze gives it (titles and descriptions; trimmed).
const list = [
  { season: 1, number: 1, name: 'JATO Car, Pop Rocks (Pilot 1)', about: 'Myths tested: Can a 1967 Chevy take off with JATO rockets? Can Pop Rocks and soda make your stomach explode?' },
  { season: 2, number: 1, name: 'Exploding Toilet, Is It Worth Running in the Rain?, Ice Bullet', about: 'Myths tested: Can a person be propelled off a toilet seat by dropping a lit cigarette into a toilet bowl filled with combustible materials? Is running better than walking to keep dry in the rain? Can a bullet made of ice kill?' },
  { season: 2, number: 2, name: 'Cell Phone+Gas Station=Explosion??, Exploding Implants, Exploding CDs', about: 'Can a cell phone ignite gasoline fumes at a gas station? Can breast implants explode on a plane? Can a CD shatter in a fast drive?' },
  { season: 2, number: 3, name: 'Barrel of Bricks, Peeing on the Third Rail, EEL Skin Wallet', about: 'The barrel of bricks story: a worker, a pulley, a rope and a 500 pound barrel. Can urinating on a third rail electrocute you? Can an eel skin wallet erase credit cards?' },
  { season: 11, number: 10, name: 'Toilet Bomb', about: 'The team revisits exploding toilets.' }
];
const heard = (text) => ({ text, lines: text.split(/(?<=[.?!])\s+/).map((t, i) => ({ t: i * 5, text: t })) });

ok('the episode whose title and description fit the words', () => {
  const m = P.matchHeard(heard('On this episode of Mythbusters, we turn up the heat on the exploding toilet myth. Somebody dumped bug spray and gasoline down a toilet, sits down, has a cigarette. Clothing gets kinky to answer an age-old weather mystery: walking or running in the rain. And Adam and Jamie take aim at the bullet.'), list);
  assert.ok(m, 'found');
  assert.strictEqual(m.entry.number, 1); assert.strictEqual(m.entry.season, 2);
  assert.ok(m.words.includes('toilet') && m.words.includes('cigarette'), m.words.join());
  assert.match(m.line.text, /toilet|rain/, 'a sentence that shows it');
});

ok('another one, by its rarer words', () => {
  const m = P.matchHeard(heard('Today the guys hoist a 500 pound barrel of bricks with a rope and a pulley, just like the old story about the worker. Then we find out whether peeing on the third rail can really kill you. And can an eel skin wallet wipe your credit cards?'), list);
  assert.strictEqual(m && m.entry.name, 'Barrel of Bricks, Peeing on the Third Rail, EEL Skin Wallet');
});

ok('no answer when nothing stands out, or too little was said', () => {
  assert.strictEqual(P.matchHeard(heard('Hello and welcome back. Today we have a great show for you, so stay with us. Let us get started right away with our first test of the day.'), list), null);
  assert.strictEqual(P.matchHeard(heard('Exploding toilet.'), list), null, 'too few words');
  assert.strictEqual(P.matchHeard(heard('Toilet toilet toilet explode explode bomb bomb'), [list[1], list[4]]), null, 'two episodes fit about as well');
});

ok('words are compared plainly (plurals, -ing, possessives, stop words)', () => {
  assert.deepStrictEqual(P.heardWords("The toilets' exploding, Jamie's bullets"), ['toilet', 'explod', 'jamie', 'bullet']);
});

ok('a file whose name has a title: clear evidence of another episode asks; weak evidence leaves the title', () => {
  const dora = [
    { season: 1, number: 6, name: 'Choo Choo', runtime: 23 }, { season: 1, number: 7, name: 'Treasure Island', runtime: 23 },
    { season: 1, number: 8, name: 'Three L’il Piggies', runtime: 23 }, { season: 1, number: 9, name: 'Big River', runtime: 23 }
  ];
  const parsed = P.parseFilename('Dora the Explorer - S01E07 - Treasure Island 360p.mkv');
  const ctx = (score, margin) => ({ show: 'Dora the Explorer', file: { minutes: 23, parts: 1, cards: [{ part: 0, t: 40, start: 0, texts: [], heard: { key: '1x8', score, margin } }] } });
  const strong = P.resolveEpisode(parsed, dora, ctx(20, 3));
  assert.strictEqual(strong.number, 8); assert.strictEqual(strong.sure, false);
  assert.match(strong.note, /name says “Treasure Island”, but what’s said at the start fits S01E08 “Three L’il Piggies”/);
  const weak = P.resolveEpisode(parsed, dora, ctx(7.9, 1.6));
  assert.strictEqual(weak.number, 7, 'the title in the name stands'); assert.notStrictEqual(weak.how, 'heard');
  // No title in the name: what's heard decides.
  const plain = P.resolveEpisode(P.parseFilename('Dora S01E07.mkv'), dora, ctx(20, 3));
  assert.strictEqual(plain.number, 8); assert.strictEqual(plain.how, 'heard');
});

console.log(passed + ' passed, 0 failed');
