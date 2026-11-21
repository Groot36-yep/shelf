'use strict';
// Shelf's icon in the style you chose: the window and taskbar, and (installed Shelf) its desktop,
// Start menu and pinned-taskbar shortcuts. The page draws the pictures (it has the SVGs); this
// file checks them, packs them into an .ico in Shelf's own folder and points the shortcuts at it.
// Only shortcuts that open this very Shelf are touched; "Amber" (the built-in icon) puts them back.

const fs = require('fs');
const path = require('path');

const STYLES = ['amber', 'walnut', 'sage', 'ocean', 'sunset', 'midnight', 'graphite', 'paper'];
const SIZES = [16, 24, 32, 48, 64, 256];
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A PNG of the size it says it is (read from its header), not too big.
function checkPng(buf, size) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.length > 400 * 1024) return false;
  if (!buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') return false;
  return buf.readUInt32BE(16) === size && buf.readUInt32BE(20) === size;
}

// An .ico holding PNG pictures (Windows Vista and later read these).
function makeIco(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((im, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(im.size >= 256 ? 0 : im.size, e); head.writeUInt8(im.size >= 256 ? 0 : im.size, e + 1);
    head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(im.png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += im.png.length;
  });
  return Buffer.concat([head].concat(images.map((im) => im.png)));
}

// Where Windows keeps Shelf's shortcuts for this user.
function shortcutPaths(app) {
  const roaming = app.getPath('appData');
  return [
    path.join(app.getPath('desktop'), 'Shelf.lnk'),
    path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Shelf.lnk'),
    path.join(roaming, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Shelf.lnk')
  ];
}

const same = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();

// Point each of Shelf's own shortcuts at the icon (or back at Shelf itself). Returns how many changed.
function updateShortcuts(shell, links, exe, ico) {
  let changed = 0;
  for (const p of links) {
    let s;
    try { if (!fs.existsSync(p)) continue; s = shell.readShortcutLink(p); } catch (e) { continue; }
    if (!same(s.target, exe)) continue; // someone else's shortcut, or another copy of Shelf
    const want = ico || exe;
    if (same(s.icon || exe, want) && (s.iconIndex || 0) === 0) continue;
    try { if (shell.writeShortcutLink(p, 'update', { icon: want, iconIndex: 0 })) changed++; } catch (e) { /* not ours to fight over */ }
  }
  return changed;
}

function create({ shell, nativeImage, dir, links, exe, canShortcuts }) {
  const file = (n, ext) => path.join(dir, 'app-icon-' + n + '.' + ext);
  // The chosen pictures: write the .ico and .png, then use them. pngs: { 16: Buffer, … 256: Buffer }
  function save(name, pngs) {
    if (!STYLES.includes(name)) throw new Error('Unknown icon style.');
    const images = SIZES.map((size) => ({ size, png: Buffer.from(pngs && pngs[size] || []) }));
    if (!images.every((im) => checkPng(im.png, im.size))) throw new Error('Those icon pictures didn’t look right.');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (/^app-icon-.*\.(ico|png)$/.test(f) && !f.startsWith('app-icon-' + name + '.')) fs.rmSync(path.join(dir, f), { force: true });
    fs.writeFileSync(file(name, 'ico'), makeIco(images));
    fs.writeFileSync(file(name, 'png'), images[images.length - 1].png);
    return name;
  }
  function image(name) {
    if (!STYLES.includes(name) || !fs.existsSync(file(name, 'png'))) return null;
    const im = nativeImage.createFromPath(file(name, 'png'));
    return im.isEmpty() ? null : im;
  }
  // Use the style on a window and on the shortcuts. Amber is Shelf's own icon, so it needs no file.
  function apply(name, win) {
    const im = image(name);
    if (win && !win.isDestroyed() && im) win.setIcon(im);
    if (!canShortcuts()) return 0;
    const ico = name !== 'amber' && fs.existsSync(file(name, 'ico')) ? file(name, 'ico') : null;
    return updateShortcuts(shell, links(), exe(), ico);
  }
  // Forget it: the shortcuts get Shelf's own icon back and the pictures are deleted.
  function reset() {
    const n = canShortcuts() ? updateShortcuts(shell, links(), exe(), null) : 0;
    try { for (const f of fs.readdirSync(dir)) if (/^app-icon-.*\.(ico|png)$/.test(f)) fs.rmSync(path.join(dir, f), { force: true }); } catch (e) { /* none */ }
    return n;
  }
  return { save, image, apply, reset, file };
}

module.exports = { STYLES, SIZES, checkPng, makeIco, shortcutPaths, updateShortcuts, create };
