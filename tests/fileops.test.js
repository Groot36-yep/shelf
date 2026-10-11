// Tests the desktop app's rename engine on real files in a throwaway folder.
// Run with: node tests/fileops.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../desktop/fileops.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('FAIL', m); } }

(async () => {
  for (const mode of ['move', 'copy', 'link']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ops-'));
    const src = path.join(root, 'Downloads');
    const lib = path.join(root, 'Plex');
    const journal = path.join(root, 'journal.json');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.mkdirSync(lib);
    const names = ["it's $(touch X).mkv", '[YTS] Matrix [720p].mkv', 'sub/Amélie ‘q’.mp4', 'notes.txt', '.hidden.mkv'];
    names.forEach((n, i) => fs.writeFileSync(path.join(src, n), 'v' + i));
    fs.writeFileSync(path.join(root, 'outside.mkv'), 'not picked');

    const found = await F.expand([src]);
    ok(found.length === 3, mode + ': expand finds 3 videos, skips txt + hidden (' + found.length + ')');
    const allowed = new Set(found.map((f) => path.resolve(f.fullPath)));

    // Pre-existing file in the library must never be overwritten.
    fs.mkdirSync(path.join(lib, 'Movies', 'The Matrix (1999)'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'Movies', 'The Matrix (1999)', 'The Matrix (1999).mkv'), 'ORIGINAL');

    const its = found.find((f) => f.name.startsWith('it'));
    const ops = [
      { source: its.fullPath, folder: ['Movies', "Ocean's $(x) (2001)"], file: "Ocean's $(x) (2001).mkv" },
      { source: found.find((f) => f.name.startsWith('[YTS]')).fullPath, folder: ['Movies', 'The Matrix (1999)'], file: 'The Matrix (1999).mkv' },
      { source: found.find((f) => f.name.startsWith('Amélie')).fullPath, folder: ['Movies', '..', '..', 'escape'], file: 'x.mp4' },
      { source: path.join(root, 'outside.mkv'), folder: ['Movies', 'Sneaky'], file: 'Sneaky.mkv' },
      { source: its.fullPath, folder: ['Movies', 'Exe'], file: 'virus.exe' }
    ];
    const { results } = await F.run(ops, { library: lib, mode, allowed, journalPath: journal });
    ok(results[0].ok && fs.existsSync(path.join(lib, 'Movies', "Ocean's $(x) (2001)", "Ocean's $(x) (2001).mkv")), mode + ': normal rename works');
    ok(!results[1].ok && results[1].skipped && fs.readFileSync(path.join(lib, 'Movies', 'The Matrix (1999)', 'The Matrix (1999).mkv'), 'utf8') === 'ORIGINAL', mode + ': never overwrites');
    ok(!fs.existsSync(path.join(root, 'escape')) && !fs.existsSync(path.join(lib, 'escape')), mode + ': ".." cannot escape the library');
    ok(!results[3].ok && /picked/.test(results[3].error), mode + ': refuses files not picked');
    ok(!results[4].ok, mode + ': refuses changing the file type');
    ok(!fs.existsSync(path.join(src, 'X')), mode + ': no command ran');
    ok(fs.existsSync(its.fullPath) === (mode !== 'move'), mode + ': original ' + (mode === 'move' ? 'moved' : 'kept'));

    const u = await F.undo(journal);
    ok(u.undone >= 1, mode + ': undo did something (' + u.undone + ')');
    ok(fs.existsSync(path.join(src, "it's $(touch X).mkv")), mode + ': original is back / intact');
    ok(!fs.existsSync(path.join(lib, 'Movies', "Ocean's $(x) (2001)")), mode + ': undo removed what it made');
    ok(fs.readFileSync(path.join(lib, 'Movies', 'The Matrix (1999)', 'The Matrix (1999).mkv'), 'utf8') === 'ORIGINAL', mode + ': undo left your own file alone');
    ok((await F.undo(journal)).nothing, mode + ': second undo does nothing');
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
