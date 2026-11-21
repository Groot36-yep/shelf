// The app icon styles: pictures are checked, the .ico is built right, and only Shelf's own shortcuts change.
// Run with: node tests/appicon.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const A = require('../desktop/appicon.js');

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

// A real (tiny, one-colour) PNG of a given size.
function png(size) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 4, 200)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(size).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

ok('only real PNGs of the stated size are taken', () => {
  assert.ok(A.checkPng(png(32), 32));
  assert.ok(!A.checkPng(png(32), 48), 'wrong size');
  assert.ok(!A.checkPng(Buffer.from('<svg/>'), 32), 'not a PNG');
  assert.ok(!A.checkPng(Buffer.alloc(500 * 1024), 32), 'too big');
  assert.ok(!A.checkPng('not a buffer', 32));
});

ok('the .ico holds every size, 256 written as 0, offsets pointing at each picture', () => {
  const images = A.SIZES.map((size) => ({ size, png: png(size) }));
  const ico = A.makeIco(images);
  assert.strictEqual(ico.readUInt16LE(2), 1, 'icon type');
  assert.strictEqual(ico.readUInt16LE(4), images.length);
  images.forEach((im, i) => {
    const e = 6 + 16 * i;
    assert.strictEqual(ico[e], im.size === 256 ? 0 : im.size);
    assert.strictEqual(ico.readUInt16LE(e + 6), 32, 'bits per pixel');
    const len = ico.readUInt32LE(e + 8), off = ico.readUInt32LE(e + 12);
    assert.ok(ico.subarray(off, off + len).equals(im.png), 'picture ' + im.size);
  });
});

ok('save: unknown styles and bad pictures are refused; a good one writes the .ico and .png, old ones go', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-icon-'));
  const fakeImage = { createFromPath: () => ({ isEmpty: () => false }) };
  const icons = A.create({ shell: {}, nativeImage: fakeImage, dir, exe: () => 'x', canShortcuts: () => false, links: () => [] });
  const pngs = {}; A.SIZES.forEach((s) => { pngs[s] = new Uint8Array(png(s)); });
  assert.throws(() => icons.save('../evil', pngs), /Unknown/);
  assert.throws(() => icons.save('sage', Object.assign({}, pngs, { 48: new Uint8Array(png(32)) })), /didn’t look right/);
  icons.save('sage', pngs);
  assert.ok(fs.existsSync(path.join(dir, 'app-icon-sage.ico')) && fs.existsSync(path.join(dir, 'app-icon-sage.png')));
  icons.save('ocean', pngs);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['app-icon-ocean.ico', 'app-icon-ocean.png']);
  icons.reset();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('shortcuts: only ones that open this Shelf change, and unchanged ones aren’t rewritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-lnk-'));
  const links = { mine: { target: 'C:\\Apps\\Shelf\\Shelf.exe' }, other: { target: 'C:\\Other\\Shelf.exe' } };
  for (const n of Object.keys(links)) fs.writeFileSync(path.join(dir, n + '.lnk'), '');
  const writes = [];
  const shell = {
    readShortcutLink: (p) => Object.assign({}, links[path.basename(p, '.lnk')]),
    writeShortcutLink: (p, op, o) => { writes.push([path.basename(p), op, o.icon]); Object.assign(links[path.basename(p, '.lnk')], o); return true; }
  };
  const paths = ['mine', 'other', 'missing'].map((n) => path.join(dir, n + '.lnk'));
  assert.strictEqual(A.updateShortcuts(shell, paths, 'c:\\apps\\shelf\\shelf.exe', 'C:\\data\\app-icon-sage.ico'), 1);
  assert.deepStrictEqual(writes, [['mine.lnk', 'update', 'C:\\data\\app-icon-sage.ico']]);
  assert.strictEqual(A.updateShortcuts(shell, paths, 'C:\\Apps\\Shelf\\Shelf.exe', 'C:\\data\\app-icon-sage.ico'), 0, 'already right');
  assert.strictEqual(A.updateShortcuts(shell, paths, 'C:\\Apps\\Shelf\\Shelf.exe', null), 1, 'back to Shelf’s own');
  assert.strictEqual(links.mine.icon, 'C:\\Apps\\Shelf\\Shelf.exe');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(passed + ' passed, 0 failed');
