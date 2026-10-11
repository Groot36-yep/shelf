# Shelf

**Rename your movie and TV files so Plex recognizes them.**

Shelf is a friendly, Mac-style take on tools like FileBot. Drop in your video files, and Shelf
works out what each one is, looks it up, shows you the match with its poster, and gives it the
exact name and folder that Plex expects.

```
charade.1963.1080p.bluray.x264-GRP.mkv        →  Movies/Charade (1963)/Charade (1963).mkv
bonanza.s01e01.a.rose.for.lotta.mkv           →  TV Shows/Bonanza/Season 01/Bonanza - S01E01 - A Rose for Lotta.mkv
bonanza.s01e01.a.rose.for.lotta.en.srt        →  TV Shows/Bonanza/Season 01/Bonanza - S01E01 - A Rose for Lotta.en.srt
```

> **Private by design.** Your videos, folders and file list never leave your computer. Only a
> cleaned-up title (like `Charade` + `1963`) is ever looked up. No accounts, tracking or update
> checks. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Get Shelf for Windows

**[Download the latest version](https://github.com/Groot36-yep/shelf/releases/latest)**. Pick `Shelf-Setup-….exe` to install it, or
`Shelf-Portable-….exe` to run it without installing.

The Windows app renames your files directly: choose your videos, check the matches, and press
**Rename Now**. **Undo Rename** puts everything back. Your TMDB key is stored encrypted with your
Windows account.

> Windows will say the app is from an "unknown publisher", because it isn't code-signed yet.
> Click **More info → Run anyway**. Every installer is built automatically by GitHub from the code
> in this repository, after the safety tests pass on Windows.

## How to use it

1. Open Shelf, click **Settings** and paste your free TMDB key (themoviedb.org → Settings → API).
   TV shows work without a key, using [TVmaze](https://www.tvmaze.com).
2. Click **Choose Folder…** (or drag files onto the window).
3. Check anything marked **Review**: click it and pick the right match on the right, or search by title.
4. Click **Rename…**, choose your Plex library folder and **Move**, **Copy** or **Hard Link**, then **Rename Now**.
5. Changed your mind? **Undo Rename** puts everything back.

Shortcuts: **Ctrl+O** add files · **Ctrl+Shift+O** add a folder · **Ctrl+Enter** rename ·
**Ctrl+Z** undo rename · **Ctrl+,** settings · **Delete** remove from list.

## What it understands

- Movie names with or without a year, including `2001.A.Space.Odyssey.1968`, `1917 (2019)` and `[YTS] The Matrix (1999)`
- Episodes written as `S01E02`, `1x02` or `Season 1 Episode 2`
- Subtitles with languages and flags, like `.en.srt` and `.eng.forced.srt`
- Release junk such as `1080p`, `BluRay`, `x264`, `WEB-DL` and release group tags, which is ignored
- Remakes with the same title (*Nosferatu* 1922 / 1979 / 2024), which are flagged for you to pick instead of guessed
- Subtitles next to a video with the same name, which automatically follow that video's match

## Settings

- **Add TMDB ID to movie names**: `Charade (1963) {tmdb-4808}.mkv`. Plex then never mismatches it.
- **Add year to show names**: `Doctor Who (2005)`. Useful when a show has been remade.
- **Move, Copy or Hard Link**: hard links use no extra disk space, which is handy for files you keep seeding.
- **Show posters**: turn off to download no images at all.
- **Forget Key** removes your TMDB key. **Privacy → Erase All Shelf Data** removes everything Shelf saved.

## Project layout

```
app/              the window: index.html, styles, parsing (js/parser.js), lookups (js/sources.js), interface (js/app.js)
desktop/          main.js (window + security), preload.js (the small bridge), fileops.js (the only code that touches files)
tests/            npm test, and tests/app.smoke.js for an end-to-end run of the app
index.html        the download page at groot36-yep.github.io/shelf
```

Run from source: `npm install`, then `npm start`. Build the Windows installer: `npm run dist:win`.
Every release is built by GitHub Actions on Windows, after the safety tests pass there.

## Credits

This product uses the TMDB API but is not endorsed or certified by TMDB.

TV information is provided by [TVmaze](https://www.tvmaze.com), licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Shelf is not affiliated with Plex Inc.

## License

MIT. See [LICENSE](LICENSE).
