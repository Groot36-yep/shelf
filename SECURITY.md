# Security

## How Shelf protects you

**Only the files you pick.** The window can't read or change your disk. It can only ask the app
for a short, fixed list of things (desktop/preload.js). The app keeps a list of the files you
picked in a system dialog or dropped onto the window, and refuses to touch anything else.

**Names can't escape your library.** Every new folder and file name is cleaned again by the
app before use (desktop/fileops.js):

- Slashes, `..` and leading dots are removed.
- Control characters and invisible "direction" characters are removed.
- Names Windows reserves (`CON`, `NUL`, `COM1` and so on) are made safe.
- The result must land inside the library folder you chose.
- A file's type can't be changed (a `.mkv` stays a `.mkv`).

**Nothing is ever overwritten.** Moves use an atomic "create only if it doesn't exist" step
where the drive supports it. Across drives, Shelf copies, checks the size, and only then
removes the original.

**Undo is careful.** Every change is written to an undo record as it happens.
- *Move:* undo only moves a file back if its old spot is still empty.
- *Copy:* undo only deletes the copy if it still matches the original.
- *Hard link:* undo only deletes the link if it is still the same file as the original.

**The window is locked down.**
- Sandboxed, with no Node.js access.
- A strict Content Security Policy: no inline or third-party code, and connections only to TMDB,
  TheTVDB and TVmaze.
- It can't navigate away or open pop-ups. Links open in your normal browser.
- Every permission request (camera, microphone, location, notifications) is refused.
- Text from the internet is always shown as text, never as HTML.
- Links and images from the lookup services are checked against an allow-list.

**Reading inside videos only on request.** Video lengths and title cards are read in the app (not
the window), only for files you picked, and only after a system prompt that lists the files. The
bundled ffmpeg and OCR engine run offline; frames are handled in memory.

**No surprises.** No telemetry, automatic update calls, crash reports or spell-check downloads. Updates are
checked only when you click **Updates**; a downloaded installer must match the SHA-256 fingerprint GitHub
publishes for it, or it is deleted and never run. Permission prompts are a separate window run by the app;
its answer is only accepted from that window, so the main window can never approve itself.

## Tests

```
npm test                         # filename parsing + the file engine on hostile names
xvfb-run -a node tests/app.smoke.js   # end-to-end: pick, match, Rename Now, Undo
xvfb-run -a node tests/tv.smoke.js    # TV matching: look-alike shows, Season folders, dates, two-part cartoons
xvfb-run -a node tests/sources.smoke.js   # TheTVDB and TMDB TV lookups
node tests/scan.test.js               # bundled ffmpeg + OCR read a (made-up) title card
xvfb-run -a node tests/cards.smoke.js # Auto Mode (title cards), including Cancel
```

The Windows build on GitHub runs `npm test` on Windows before building the installer.

## Reporting a problem

If you find a security or privacy problem, please open an issue on this repository. Don't
include any API keys or personal file names in it.
