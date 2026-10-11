// Real title-card readings from three SpongeBob season 7 half-hours (only the text the reader saw is
// kept, no video). Each real card must be recognised; every other frame must match nothing.
// Run with: node tests/cards-real.test.js
const assert = require('assert');
const P = require('../app/js/parser.js');
const FIX = require('./fixtures/s7-real-ocr.json');
const S7 = require('./fixtures/s7-titles.json').map(([season, number, name]) => ({ season, number, name }));
const CARDS = {
  S07E09: { 53: 'One Coarse Meal', 708.8: 'Gary in Love' },
  S07E10: { 53: "The Play's the Thing", 714: 'Rodeo Daze' },
  S07E11: { 53: "SpongeBob's Last Stand" }
};
let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, '\n  ', e.message); } }
for (const f of FIX.files) {
  const code = f.name.match(/S07E\d\d/)[0], cards = CARDS[code];
  for (const r of f.readings) {
    const m = P.matchCardText(r.texts, S7);
    const want = cards[r.t];
    if (want) check(code + ' card at ' + r.t, () => assert.ok(m && m.entry.name === want, 'want ' + want + ', got ' + (m && m.entry.name) + ' from ' + JSON.stringify(r.texts).slice(0, 200)));
    else check(code + ' not a card at ' + r.t, () => assert.ok(!m || Object.values(cards).includes(m.entry.name), 'matched ' + (m && m.entry.name + ' ' + m.score) + ' from ' + JSON.stringify(r.texts).slice(0, 300)));
  }
}

// Season 3 half-hours and a special, matched against seasons 3–7 at once (153 titles: harder).
const FIX3 = require('./fixtures/s3-real-ocr.json');
const POOL = require('./fixtures/sb-titles-s3-s7.json').map(([season, number, name]) => ({ season, number, name }));
const CARDS3 = {
  S03E01: { real: ["The Algae's Always Greener", 'SpongeGuard on Duty'], at: { 53.3: "The Algae's Always Greener" } },
  S03E02: { real: ['Club SpongeBob', 'My Pretty Seahorse'], at: { 714.3: 'My Pretty Seahorse' } },
  S03E03: { real: ['Just One Bite', 'The Bully'], at: { 53.3: 'Just One Bite', 675.3: 'The Bully' } },
  S03E04: { real: ['Nasty Patty', 'The Idiot Box'], at: { 53.3: 'Nasty Patty' } },
  S03E05: { real: ['Mermaid Man and Barnacle Boy IV', 'Doing Time'], at: { 718: 'Doing Time' } },
  S03E06: { real: ['The Snowball Effect', "One Krab's Trash"], at: { 53: 'The Snowball Effect' } },
  S07E09: { real: ['One Coarse Meal', 'Gary in Love'], at: { 53: 'One Coarse Meal', 708.8: 'Gary in Love' } },
  S07E10: { real: ["The Play's the Thing", 'Rodeo Daze'], at: { 53: "The Play's the Thing", 714: 'Rodeo Daze' } },
  S07E11: { real: ["SpongeBob's Last Stand"], at: { 53: "SpongeBob's Last Stand" } },
  Pest: { real: ['Pest of the West'], at: { 63.5: 'Pest of the West' } }
};
for (const f of FIX3.files) {
  const key = Object.keys(CARDS3).find((k) => f.name.includes(k)), c = CARDS3[key];
  for (const r of f.readings) {
    if (!r.texts.length) continue;
    const m = P.matchCardText(r.texts, POOL), want = c.at[r.t];
    if (want) check(key + ' card at ' + r.t, () => assert.ok(m && m.entry.name === want, 'want ' + want + ', got ' + (m && m.entry.name) + ' from ' + JSON.stringify(r.texts).slice(0, 200)));
    else check(key + ' not a card at ' + r.t, () => assert.ok(!m || c.real.includes(m.entry.name), 'matched ' + (m && m.entry.name + ' ' + m.score) + ' from ' + JSON.stringify(r.texts).slice(0, 300)));
  }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
