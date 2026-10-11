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
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
