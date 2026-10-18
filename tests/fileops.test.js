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

  // Looking through folders all at once gives exactly what a one-folder-at-a-time walk gives:
  // same order (Season 2 before Season 10), same files skipped, links never followed, same limit.
  {
    const fsp = fs.promises;
    const { VIDEO_EXT, SUB_EXT } = require('../app/js/parser.js');
    const isWanted = (n) => !n.startsWith('.') && VIDEO_EXT.concat(SUB_EXT).includes(path.extname(n).slice(1).toLowerCase());
    async function oneByOne(paths, max) { // the walk expand() used before (kept here as the reference)
      const out = [];
      async function walk(full, base) {
        if (out.length >= max) return;
        let st;
        try { st = await fsp.lstat(full); } catch (e) { return; }
        if (st.isSymbolicLink()) return;
        if (st.isDirectory()) {
          let names = [];
          try { names = await fsp.readdir(full); } catch (e) { return; }
          names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          for (const n of names) {
            if (n.startsWith('.') || /^(\$RECYCLE\.BIN|System Volume Information)$/i.test(n)) continue;
            await walk(path.join(full, n), base);
          }
        } else if (st.isFile() && isWanted(path.basename(full))) {
          out.push({ name: path.basename(full), relPath: path.relative(base, full).split(path.sep).join('/'), size: st.size, fullPath: full, parents: path.dirname(full).split(/[\\/]+/).filter(Boolean).slice(-3) });
        }
      }
      for (const p of paths) {
        const full = path.resolve(p);
        try { await fsp.lstat(full); } catch (e) { continue; }
        await walk(full, path.dirname(full));
      }
      return out;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-walk-'));
    const tv = path.join(root, 'TV');
    const put = (rel, body) => { const f = path.join(tv, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body || 'x'); };
    for (const s of [1, 2, 10]) for (const e of [1, 2, 10, 11]) put('Lost/Season ' + s + '/Lost.S' + s + 'E' + e + '.mkv', 'v'.repeat(s * 100 + e));
    put('Lost/Season 1/Lost.S1E01.en.srt'); put('Lost/Season 1/poster.jpg'); put('Lost/Season 1/.hidden.mkv');
    put('Lost/.trash/Old.mkv'); put('$RECYCLE.BIN/Deleted.mkv'); put('System Volume Information/x.mkv');
    put('Arcane/Arcane S01E01.MKV'); put('Arcane/notes.txt'); put('Zed/a/b/c/deep.mp4'); fs.mkdirSync(path.join(tv, 'Empty'));
    const outside = path.join(root, 'Elsewhere'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'Secret.mkv'), 's');
    let linked = false;
    try { fs.symlinkSync(outside, path.join(tv, 'Linked'), 'junction'); linked = true; } catch (e) { /* no links on this drive */ }
    try { fs.symlinkSync(path.join(outside, 'Secret.mkv'), path.join(tv, 'Arcane', 'Link.mkv'), 'file'); } catch (e) { /* needs Developer Mode on Windows */ }
    const picks = [tv, path.join(tv, 'Arcane', 'Arcane S01E01.MKV'), path.join(root, 'missing'), path.join(tv, 'Lost', 'Season 2')];
    const want = await oneByOne(picks, 20000);
    const got = await F.expand(picks);
    ok(JSON.stringify(got) === JSON.stringify(want), 'walk: same list, same order as one folder at a time (' + got.length + ' vs ' + want.length + ')');
    ok(got.findIndex((f) => /S2E1\.mkv$/.test(f.name)) < got.findIndex((f) => /S10E1\.mkv$/.test(f.name)), 'walk: Season 2 before Season 10');
    ok(!got.some((f) => /Secret|Old|Deleted|hidden|poster|notes|x\.mkv/.test(f.name)), 'walk: skips hidden, recycle bin, other files' + (linked ? ' and never follows links' : ''));
    ok(got.find((f) => f.name === 'Lost.S1E2.mkv').size === 102, 'walk: sizes are right');
    for (const max of [1, 5, 13, 30]) {
      const a = await F.expand(picks, max), b = await oneByOne(picks, max);
      ok(a.length === Math.min(max, want.length) && JSON.stringify(a) === JSON.stringify(b), 'walk: limit of ' + max + ' keeps the same first files');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
