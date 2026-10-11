# Privacy

Shelf is built to know as little about you as possible.

## Stays on your computer, always

- **Your video files.** Shelf never uploads them. It only reads their names, and the browser
  only gives a web page the files you choose.
- **Your original file names and folders.** Shelf works out the title on your computer. Only the
  cleaned-up title is ever looked up (see below).
- **Your file list.** It is kept in memory only, and disappears when you close the tab.
- **The rename script.** It is created on your computer and downloaded straight from the page.
  It never goes through a server.

## The only things that leave your computer

| What | Sent to | Why |
|---|---|---|
| Movie title and year, e.g. `Charade` + `1963` | [TMDB](https://www.themoviedb.org) | To find the right movie |
| Show title, e.g. `Bonanza`, plus season and episode numbers | [TVmaze](https://www.tvmaze.com) | To find the show and the episode name |
| Requests for poster images (optional, can be turned off) | TMDB / TVmaze image servers | To show posters |
| Your TMDB key | TMDB only | TMDB requires it |

Each file's details panel shows exactly what was shared for that file.

Like any website, TMDB and TVmaze can see your internet (IP) address when Shelf asks them
something. Shelf sends no cookies and no "referrer", so they don't learn which page asked.

## Your TMDB key

- It is stored only in your browser on this device, and only sent to TMDB.
- Turn off **Remember key on this device** in Settings to have it forgotten when you close the tab.
- **Forget Key** removes it immediately. **Privacy → Erase All Shelf Data** removes every setting.
- Prefer the long **API Read Access Token**. Shelf sends it in a request header, so it never
  appears in a web address.
- The key is never part of this project's code and is never uploaded to GitHub.

## Never

- No accounts, sign-ups, cookies, tracking, analytics or ads.
- No code, fonts or images from any other website. The page's Content Security Policy only allows
  connections to TMDB and TVmaze, and blocks everything else.

## Hosting

The demo is hosted on GitHub Pages. GitHub, like any web host, can see that your address loaded
the page. For the most privacy, download this project and open `index.html` from your own
computer. It works the same way.
