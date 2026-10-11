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
| Show title, e.g. `Bonanza`, plus season and episode numbers | [TVmaze](https://www.tvmaze.com) | To find the show and the episode name |
| Requests for poster images (optional, can be turned off) | TMDB / TVmaze image servers | To show posters |
| Your TMDB key | TMDB only | TMDB requires it |

Each file's details panel shows exactly what was shared for that file.

Like any online service, TMDB and TVmaze can see your internet (IP) address when Shelf asks them
something. Shelf sends no cookies and no "referrer".

## The app

- It renames files itself, on your computer. It can only touch files you picked, and only put
  them inside the library folder you chose.
- Your TMDB key is encrypted with your Windows account (DPAPI) before it is saved.
- No telemetry, no automatic update checks, no crash reports, and no spell-check downloads.
- The app asks for no permissions (camera, microphone, location, notifications) and can't open
  other websites inside its window. Links open in your normal browser.
- Settings and the undo record are kept in `%APPDATA%\Shelf`. **Privacy → Erase All Shelf Data**
  removes them.

## Your TMDB key

- It is encrypted with your Windows account before it is saved, and only ever sent to TMDB.
- **Settings → Forget Key** removes it immediately.
- Prefer the long **API Read Access Token**. Shelf sends it in a request header, so it never
  appears in a web address.
- The key is never part of this project's code and is never uploaded to GitHub.

## Never

- No accounts, sign-ups, cookies, tracking, analytics or ads.
- No code, fonts or images from anywhere else. Shelf's window may only connect to TMDB and TVmaze
  (and load posters from their image servers). Everything else is blocked.
