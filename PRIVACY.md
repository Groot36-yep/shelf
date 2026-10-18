# Privacy

Shelf is built to know as little about you as possible.

## Stays on your computer, always

- **Your video files.** Shelf never uploads them anywhere, except to your own Plex server when you
  use **Send to Plex**.
- **Your original file names and folders.** Shelf works out the title on your computer. Only the
  cleaned-up title is ever looked up (see below).
- **Your file list.** It is kept in memory only, and disappears when you close Shelf.
- **Remembered lookups.** What TMDB, TheTVDB or TVmaze answered (search results and episode lists,
  under names like `tvmaze:search:bonanza`, never your keys) is kept in Shelf's own storage on your
  computer, so the same show isn't looked up again next time: searches for 30 days, episode lists
  for a week (a day for shows still airing). **Privacy → Forget Remembered Lookups** removes them.
- **Renaming.** Shelf does it itself, on your computer.

## The only things that leave your computer

| What | Sent to | Why |
|---|---|---|
| Movie title and year, e.g. `Charade` + `1963` | [TMDB](https://www.themoviedb.org) | To find the right movie |
| Show title, e.g. `Bonanza` | [TMDB](https://www.themoviedb.org), [TheTVDB](https://thetvdb.com) or [TVmaze](https://www.tvmaze.com), whichever matches your episode order | To find the show and its episode list |
| Requests for poster images (optional, can be turned off) | TMDB / TVmaze image servers | To show posters |
| Your TMDB key | TMDB only | TMDB requires it |
| Your TheTVDB key (and PIN, if you have one) | TheTVDB only | TheTVDB requires it |

Each file's details panel shows exactly what was shared for that file.

**Send to Plex** (only if you set it up) sends your renamed files to **your own Plex server**, over
your network, encrypted with SSH. Nothing goes through anyone else's computer. See below.

Like any online service, TMDB, TheTVDB and TVmaze can see your internet (IP) address when Shelf asks them
something. Shelf sends no cookies and no "referrer".

## The app

- It renames files itself, on your computer. It can only touch files you picked, and only put
  them inside the library folder you chose.
- Your TMDB and TheTVDB keys are encrypted with your Windows account (DPAPI) before they are saved.
- No telemetry, no automatic update checks, no crash reports, and no spell-check downloads.
- **Updates** only when you click it: Shelf asks GitHub for its latest release page. If you choose to
  install, it downloads the file from Shelf's own GitHub releases and checks it against the SHA-256
  fingerprint GitHub publishes before running it. Nothing about you or your files is sent.
- Before Shelf looks inside a video (title cards, Check Episodes, lengths) it asks in its own
  permission window. Only a click in that window says yes: the main window can't answer it.
- The app asks for no permissions (camera, microphone, location, notifications) and can't open
  other websites inside its window. Links open in your normal browser.
- Settings, remembered lookups and the undo record are kept in `%APPDATA%\Shelf`. **Privacy → Erase
  All Shelf Data** removes them.

## Looking inside your videos

Shelf only reads a video's contents when you click **Auto Mode** or **Deep Scan**, and only after
Shelf's prompt listing those files, where you choose OK or Cancel.

- **Auto Mode** and **Deep Scan** read each video's running time and decode still moments of
  the video in memory and reads the words on them with an OCR engine that ships inside Shelf. No
  pictures are written to disk, nothing is uploaded, and no data is downloaded for it.
- **Split…** asks before opening a video, then plays it inside Shelf (only that one file, through a
  private one-time link that stops working when the window closes) and reads it to suggest a cut.
- What was read is kept only in memory until you close Shelf or clear the list.

## Send to Plex (your own server)

- Files go only to the server you set up, over SSH (encrypted). Plain FTP isn't supported.
- Shelf checks the server's fingerprint every time, and stops before sending your password or any
  file if it has changed.
- With the secure key (the default), your password is used once to add Shelf's key to your server,
  then forgotten. Shelf's key, your password (if you chose to keep it) and your Plex token are
  encrypted with your Windows account. The window never sees them after you type them.
- **From FileZilla** reads FileZilla's saved servers on this PC, only when you open the setup.
  Its saved password or key file is used on this PC and isn't copied anywhere.
- Your Plex token is only sent to Plex on your server, inside the SSH connection.
- Only files in your Shelf library's Movies and TV Shows folders can be sent, and only into the
  server folders you chose.
- **Forget This Server…** and **Erase All Shelf Data** delete everything Shelf saved about your
  server. Forget can also take Shelf's key back off the server.

## Your TMDB key

- It is encrypted with your Windows account before it is saved, and only ever sent to TMDB.
- **Settings → Forget Key** removes it immediately.
- Prefer the long **API Read Access Token**. Shelf sends it in a request header, so it never
  appears in a web address.
- The key is never part of this project's code and is never uploaded to GitHub.

## Never

- No accounts, sign-ups, cookies, tracking, analytics or ads.
- No code, fonts or images from anywhere else. Shelf's window may only connect to TMDB, TheTVDB and TVmaze
  (and load posters from their image servers). Everything else is blocked.
