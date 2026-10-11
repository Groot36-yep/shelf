// Runs the generated rename + undo scripts for real, against hostile filenames,
// inside a throwaway folder. Needs bash; PowerShell (pwsh) is used if PWSH is set.
// Run with: node tests/scripts.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../js/parser.js');

const PWSH = process.env.PWSH || '';
let pass = 0, fail = 0;
const CI = !!process.env.GITHUB_ACTIONS;
function annotate(msg) { if (CI) console.log('::error::' + String(msg).slice(0, 1500).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')); }
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('FAIL', msg); annotate('FAIL ' + msg); } }

// Hostile names: shell metacharacters, quotes of every kind, wildcards, unicode.
const WIN = process.platform === 'win32';
const SOURCES = WIN ? [
  // Windows forbids | > " * ? in names, so use every other trick.
  "it's $(touch PWNED) `touch PWNED2`.mkv",
  'semi;colon & amp $HOME %PATH% $(x).mkv',
  '[YTS] The Matrix (1999) [720p].mkv',
  'quote‘curly’ ’single‚ ‛.mkv',
  'Amélie (2001) 日本.mkv',
  'sub/folder/nested [a-z] star.mkv'
] : [
  "it's $(touch PWNED) `touch PWNED2`.mkv",
  'semi;colon & amp | pipe > out.mkv',
  '[YTS] The Matrix (1999) [720p].mkv',
  'quote‘curly’ "double".mkv',
  'Amélie (2001) 日本.mkv',
  'sub/folder/nested * star ?.mkv'
];
// Hostile titles, as if a database returned them.
const TITLES = ['$(touch PWNED3)', '../../escape', "Ocean's Eleven", 'Star Wars: Episode IV', 'CON', 'Amélie'];

function setup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  SOURCES.forEach((s, i) => {
    const full = path.join(dir, s);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'video ' + i);
  });
  return SOURCES.map((src, i) => {
    const parsed = P.parseFilename(path.basename(src));
    const n = P.plexName(parsed, { type: 'movie', title: TITLES[i], year: 2000 + i, id: 100 + i }, {});
    return { source: src, folder: n.folder, file: n.file };
  });
}

function listAll(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(path.relative(dir, f)); } })(dir);
  return out.sort();
}

function run(platform, shell, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-'));
  const work = path.join(root, 'videos');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const items = setup(work);
  // On Windows, test an absolute library path (D:\...), elsewhere the "~" home shortcut.
  const lib = WIN ? path.join(home, 'Library Plex') : '~/Library Plex';
  const out = P.buildScript(items, { platform, mode, library: lib });
  const scriptPath = path.join(work, 'shelf-rename.' + out.ext);
  const undoPath = path.join(work, 'shelf-undo.' + out.ext);
  fs.writeFileSync(scriptPath, out.script);
  fs.writeFileSync(undoPath, out.undo);
  const env = { ...process.env, HOME: home };
  const exec0 = (file) => shell === 'bash'
    ? execFileSync('bash', [file], { env, cwd: root, input: '\n' }).toString()
    : execFileSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { env, cwd: root, input: '\n' }).toString();
  const label = platform + '/' + mode;
  const exec = (file) => {
    try { return exec0(file); }
    catch (e) {
      const out = ((e.stdout || '') + '\n' + (e.stderr || '')).toString();
      fail++; console.log('FAIL', label, 'script crashed:', out); annotate(label + ' script crashed: ' + out);
      return out;
    }
  };

  const log1 = exec(scriptPath);
  const libFiles = listAll(path.join(home, 'Library Plex'));
  ok(libFiles.length === SOURCES.length, label + ': all files placed (' + libFiles.length + ')\n' + log1);
  ok(!fs.existsSync(path.join(root, 'PWNED')) && !fs.existsSync(path.join(work, 'PWNED')) && !fs.existsSync(path.join(work, 'PWNED2')) && !fs.existsSync(path.join(work, 'PWNED3')), label + ': no injected command ran');
  ok(!fs.existsSync(path.join(home, 'escape')) && !fs.existsSync(path.join(root, 'escape')), label + ': no folder escape');
  ok(libFiles.some(f => f.includes("Ocean's Eleven (2002)")), label + ': apostrophe title kept');
  ok(libFiles.some(f => f.includes('CON_')), label + ': reserved Windows name fixed');
  ok(libFiles.some(f => f.includes('Amélie')), label + ': unicode kept');
  const remaining = listAll(work).filter(f => !/^shelf-/.test(f));
  ok(mode === 'move' ? remaining.length === 0 : remaining.length === SOURCES.length, label + ': originals ' + (mode === 'move' ? 'moved' : 'kept') + ' (' + remaining.length + ')');

  // Running again must not overwrite anything.
  const log2 = exec(scriptPath);
  ok(/skipped/i.test(log2), label + ': second run skips safely');

  // Undo
  exec(undoPath);
  const after = listAll(work).filter(f => !/^shelf-/.test(f));
  ok(after.length === SOURCES.length, label + ': undo restored originals (' + after.length + ')');
  ok(listAll(path.join(home, 'Library Plex')).length === 0, label + ': undo emptied library');
  fs.rmSync(root, { recursive: true, force: true });
}

if (!process.env.SKIP_BASH) for (const mode of ['move', 'copy', 'link']) run('mac', 'bash', mode);
// Hard links in the PowerShell script use a Windows API, so that mode is only tested on Windows.
if (PWSH) for (const mode of WIN ? ['move', 'copy', 'link'] : ['move', 'copy']) run('windows', 'pwsh', mode);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
