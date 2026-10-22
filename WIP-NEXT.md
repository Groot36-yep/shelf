# Work in progress (branch cleanup-set-aside): delete this file before merging

The user said: when all of this is done and tested, merge to main and publish (next version 2.2.3) without asking.

## Done on this branch (not yet fully re-tested together)
- Free Up Space on Server… (⚙ menu): plexfix.js `shelf:plexSpareList` / `shelf:plexSpareDelete` (walk() got a
  `want` filter), preload, send.js `freeSpace` / `pickSpace`, #spaceSheet in index.html, app.js `Shelf.checkUndo`.
  Tested in tests/dupes.smoke.js (passes).
- Fix My Plex Library: pick seasons (send.js fixGroups/pickFixes rewritten: shows open to their seasons) and an
  "Include files that already look right" switch in the picker (#fpIncludeAll; re-runs the check; the picker now
  always opens, even when nothing needs fixing). tests/plexfix.smoke.js updated for both (fake server gets a
  Season 4 file via opts.extra) — NOT run yet since the last edit.
- SSH transfers (desktop/server.js, plexsend.js):
  - Resume backs up past the in-flight window (a later piece can land while an earlier one was lost: a gap the
    part file's size doesn't show). Window = inFlight × chunk (+1 chunk), aligned to the chunk.
  - Stall watchdog in _pump: no write answered for 60 s (this.stallMs for tests) → LOST → retried.
  - Retries: 6 tries over ~2 min (2, 5, 10, 20, 30, 60 s), message says "(n of 6)".
  - this.tune { chunk, inFlight } hook for measuring. Benchmark (work/sftpbench in the scratchpad, Electron as
    node, loopback): ~115–145 MB/s, noise ±15%; current 128 KB × 24 in flight is as good as any setting tried.
  - New tests/resume.test.js (in-memory ssh2 SFTP server: loses piece 3, drops after 24, resend must be
    byte-exact; plus the stall check). It printed nothing on its first runs: debug it (maybe hangs; check the
    connection/drop handling and that upload rejects), then add it to package.json "test" (runs on Windows CI).

## Still to do
1. Finish/debug tests/resume.test.js; add to npm test.
2. Rerun: npm test + all window tests (app shelves theme dialogs mark resolve send cards split splitall sources tv
   plexfix remotecards dupes). dialogs failed once with "Cannot read properties of undefined (reading 'cards')"
   (list empty after Choose Folder) — rerun to see if it's flaky.
3. User's newest ask: give Check Episodes / the split editor (app/js/editor.js, #editorSheet, styles under
   .editor-sheet / .ed-*) the same care as the new main window: faster, beautiful, clearer buttons, more usable,
   and think about how to make the split view better. Take screenshots before/after (tests/split.smoke.js has
   SHOT=dir support; scratchpad work/ has screenshot harnesses).
4. ROADMAP "Next release" (Free Up Space is there; add seasons, include-all, SSH stability, editor), README.
5. Commit, PR, merge, bump to 2.2.3 (package.json + package-lock top two), rename ROADMAP heading to
   "Done (2.2.3)", push main, watch the Windows build, verify the release.
