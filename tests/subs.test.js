// Run with: node tests/subs.test.js
const assert = require('assert');
const { splitSubtitle, splitSubtitleBytes, parseTime } = require('../desktop/subs.js');
let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, '\n  ', e.message); } }
const pieces = [{ start: 0, end: 660 }, { start: 660, end: 1320 }];

check('times', () => {
  assert.strictEqual(parseTime('00:11:00,500'), 660.5);
  assert.strictEqual(parseTime('0:11:00.50'), 660.5);
  assert.strictEqual(parseTime('11:00.500'), 660.5);
});

check('srt', () => {
  const srt = '﻿1\r\n00:00:05,000 --> 00:00:07,000\r\nHello!\r\n\r\n2\r\n00:10:58,000 --> 00:11:02,000\r\nAcross the cut\r\n\r\n3\r\n00:11:10,250 --> 00:11:12,000\r\nI\'m ready!\r\nTwo lines\r\n';
  const [a, b] = splitSubtitle(srt, 'srt', pieces);
  assert.strictEqual(a, '1\n00:00:05,000 --> 00:00:07,000\nHello!\n\n2\n00:10:58,000 --> 00:11:00,000\nAcross the cut\n');
  assert.strictEqual(b, '1\n00:00:00,000 --> 00:00:02,000\nAcross the cut\n\n2\n00:00:10,250 --> 00:00:12,000\nI\'m ready!\nTwo lines\n');
});

check('vtt', () => {
  const vtt = 'WEBVTT\n\nSTYLE\n::cue { color: yellow }\n\nintro\n00:05.000 --> 00:07.000 align:start\nHi\n\n00:11:10.000 --> 00:11:11.000\nLater\n';
  const [a, b] = splitSubtitle(vtt, 'vtt', pieces);
  assert.match(a, /^WEBVTT\n\nSTYLE[\s\S]*intro\n00:00:05\.000 --> 00:00:07\.000 align:start\nHi\n$/);
  assert.match(b, /00:00:10\.000 --> 00:00:11\.000\nLater/);
  assert.ok(!/Hi/.test(b));
});

check('ass', () => {
  const ass = '[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Hello, world\nDialogue: 0,0:11:10.00,0:11:12.50,Default,,0,0,0,,{\\i1}Later{\\i0}\n';
  const [a, b] = splitSubtitle(ass, 'ass', pieces);
  assert.match(a, /Dialogue: 0,0:00:05\.00,0:00:07\.00,Default,,0,0,0,,Hello, world/);
  assert.ok(!/Later/.test(a));
  assert.match(b, /Dialogue: 0,0:00:10\.00,0:00:12\.50,Default,,0,0,0,,\{\\i1\}Later\{\\i0\}/);
  assert.match(b, /\[Script Info\]/);
});

check('bytes keep encoding', () => {
  const body = '1\n00:00:01,000 --> 00:00:02,000\nCafé ½ — ok\n\n2\n00:11:01,000 --> 00:11:02,000\nÜber\n';
  // UTF-8 with a marker: each piece keeps the marker and the exact bytes of the text.
  const u8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
  const [a, b] = splitSubtitleBytes(u8, 'srt', pieces);
  assert.deepStrictEqual([...a.data.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(a.data.toString('utf8').includes('Café ½ — ok'));
  assert.ok(b.data.toString('utf8').includes('00:00:01,000 --> 00:00:02,000\nÜber'));
  assert.strictEqual(a.cues, 1); assert.strictEqual(b.cues, 1);
  // Windows-1252 bytes stay as they were.
  const w = Buffer.from(body.replace('½ — ', ''), 'latin1');
  const [c] = splitSubtitleBytes(w, 'srt', pieces);
  assert.ok(c.data.includes(Buffer.from([0x43, 0x61, 0x66, 0xe9])));
  // UTF-16 little-endian.
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
  const [, d] = splitSubtitleBytes(u16, 'srt', pieces);
  assert.ok(d.data.subarray(2).toString('utf16le').includes('Über'));
  assert.strictEqual(splitSubtitleBytes(Buffer.from([0xfe, 0xff, 0, 0x31]), 'srt', pieces), null);
});

check('unsupported', () => assert.strictEqual(splitSubtitle('x', 'sub', pieces), null));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
