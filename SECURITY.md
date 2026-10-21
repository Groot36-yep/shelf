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

**Undo is careful.** Every change is written to an undo record as it happens (one record per Rename Now; the last
50 are kept, newest undone first).
- *Move:* undo only moves a file back if its old spot is still empty.
- *Copy:* undo only deletes the copy if it still matches the original.
- *Hard link:* undo only deletes the link if it is still the same file as the original.

**Names that only change capital letters** are recognised as the same file (Windows and macOS), renamed through a
temporary name, and never mistaken for a clash. **Links out of the library** are followed before anything is
written: a folder inside your library that really points elsewhere is refused.

**The app itself is locked down.** Electron's fuses are set on the shipped app: it can't be started as a plain
Node.js program (`ELECTRON_RUN_AS_NODE`), ignores `NODE_OPTIONS` and debugger switches, only loads its code from its
own archive, and checks that archive's fingerprint at start-up. The Windows build runs with read-only access,
pins every GitHub Action to an exact commit, and only the final release step can publish.

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

**Send to Plex is SSH only, and checks who it's talking to** (desktop/server.js, desktop/plexsend.js).
- The server's host-key fingerprint is shown the first time and pinned. A different fingerprint stops
  the connection before any password, key or file is sent. Trusting a new one needs a fresh look-up
  and your click.
- Modern algorithms only (curve25519 / ECDH, AES-GCM / AES-CTR, SHA-2 MACs, Ed25519 / ECDSA /
  RSA-SHA2 host keys).
- Shelf makes its own Ed25519 key and forgets your password. Secrets are encrypted with your Windows
  account (DPAPI), live only in the app, and never go back to the window.
- The window can only ask to send files that are inside your library's Movies / TV Shows folders
  (checked after resolving links). Each file only goes under the server folder you chose for its kind.
  `..`, slashes and line breaks in names are refused.
- Uploads go to a hidden `.shelf-part` file, are checked (size, plus SHA-256 computed by the server),
  and only then renamed. Existing files are never replaced unless you choose **Replace Them**.
- The only command Shelf runs on the server is `sha256sum` on a file it just sent, with the path
  safely quoted. Plex is reached through the SSH connection (to the server's own 127.0.0.1:32400).
- The log file never contains file names, paths, hosts' passwords or keys.

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
node tests/ssh-loopback.test.js       # Send to Plex against a built-in test SSH server (runs on Windows too)
node tests/server.test.js             # …and against real OpenSSH (Linux, as root): fingerprints, resume, damage, Plex
node tests/plexsend.test.js           # the send queue: checks while sending, Stop/resume, re-send bad copies, Forget
xvfb-run -a node tests/send.smoke.js  # the whole setup and send, clicked through in the app
```

The Windows build on GitHub runs the safety tests on Windows before building the installer, then
checks the built app can read a title card and send a file over SSH.

## Reporting a problem

If you find a security or privacy problem, please open an issue on this repository. Don't
include any API keys or personal file names in it.
