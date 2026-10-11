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

  // Subtitles of a split video are cut at the same points; the original subtitle is never touched.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-subs-'));
    const lib = path.join(root, 'Plex');
    fs.mkdirSync(lib);
    const srt = path.join(root, 'Show.S01E01.en.srt');
    const body = '1\r\n00:00:05,000 --> 00:00:07,000\r\nCafé\r\n\r\n2\r\n00:11:10,000 --> 00:11:12,000\r\nLater\r\n';
    fs.writeFileSync(srt, body, 'utf8');
    const idx = path.join(root, 'Show.S01E01.idx');
    fs.writeFileSync(idx, 'x');
    const allowed = new Set([path.resolve(srt), path.resolve(idx)]);
    const journal = path.join(root, 'j.json');
    const folder = ['TV Shows', 'Show', 'Season 01'];
    const piecesOf = (ext) => [
      { start: 0, end: 660, folder, file: 'Show - S01E01 - A.en' + ext },
      { start: 660, end: 1320, folder, file: 'Show - S01E02 - B.en' + ext },
      { start: 1320, end: 1500, folder, file: 'Show - S01E03 - C.en' + ext }
    ];
    // Third piece has no lines: no empty file is written for it.
    const { results } = await F.run([{ source: srt, split: piecesOf('.srt') }, { source: idx, split: piecesOf('.idx') }], { library: lib, mode: 'move', allowed, journalPath: journal });
    const dir = path.join(lib, ...folder);
    ok(results[0].ok && results[0].split && results[0].pieces.length === 2, 'subs: split into 2 files (' + JSON.stringify(results[0]) + ')');
    ok(fs.readFileSync(path.join(dir, 'Show - S01E01 - A.en.srt'), 'utf8').includes('00:00:05,000 --> 00:00:07,000\nCafé'), 'subs: first piece kept its text');
    ok(fs.readFileSync(path.join(dir, 'Show - S01E02 - B.en.srt'), 'utf8').includes('00:00:10,000 --> 00:00:12,000\nLater'), 'subs: second piece moved to start at 0');
    ok(!fs.existsSync(path.join(dir, 'Show - S01E03 - C.en.srt')), 'subs: no empty file');
    ok(fs.readFileSync(srt, 'utf8') === body, 'subs: original untouched even in move mode');
    ok(!results[1].ok && /can’t be split/.test(results[1].error), 'subs: image subtitles are refused');
    const again = await F.run([{ source: srt, split: piecesOf('.srt') }], { library: lib, mode: 'move', allowed, journalPath: path.join(root, 'j2.json') });
    ok(again.results[0].skipped, 'subs: never overwrites');
    const u = await F.undo(journal);
    ok(u.undone === 2 && !fs.existsSync(path.join(lib, 'TV Shows')), 'subs: undo removes the pieces (' + u.undone + ')');
    ok(fs.existsSync(srt), 'subs: original still there after undo');
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
