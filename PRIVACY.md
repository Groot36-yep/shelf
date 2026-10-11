# Privacy

Shelf is built to know as little about you as possible.

## Stays on your computer, always

- **Your video files.** Shelf never uploads them. It only reads their names.
- **Your original file names and folders.** Shelf works out the title on your computer. Only the
  cleaned-up title is ever looked up (see below).
- **Your file list.** It is kept in memory only, and disappears when you close Shelf.
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

Like any online service, TMDB, TheTVDB and TVmaze can see your internet (IP) address when Shelf asks them
something. Shelf sends no cookies and no "referrer".

## The app

- It renames files itself, on your computer. It can only touch files you picked, and only put
  them inside the library folder you chose.
- Your TMDB and TheTVDB keys are encrypted with your Windows account (DPAPI) before they are saved.
- No telemetry, no automatic update checks, no crash reports, and no spell-check downloads.
- The app asks for no permissions (camera, microphone, location, notifications) and can't open
  other websites inside its window. Links open in your normal browser.
- Settings and the undo record are kept in `%APPDATA%\Shelf`. **Privacy → Erase All Shelf Data**
  removes them.

## Looking inside your videos

Shelf only reads a video's contents when you click **Check Lengths** or **Read Title Cards**, and
only after a Windows prompt listing those files, where you choose OK or Cancel.

- **Check Lengths** reads the few bytes of each file's header that hold its running time.
- **Read Title Cards** (off unless you turn it on in Settings → Advanced) decodes still moments of
  the video in memory and reads the words on them with an OCR engine that ships inside Shelf. No
  pictures are written to disk, nothing is uploaded, and no data is downloaded for it.
- What was read is kept only in memory until you close Shelf or clear the list.

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
