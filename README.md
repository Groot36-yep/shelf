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

> **Demo version.** Shelf runs in your web browser. It only reads file *names*. Your videos are
> never uploaded anywhere.

## Try it

Open the live demo: **https://groot36-yep.github.io/shelf/**

1. Click **Or try it with sample filenames** to see it work right away, or choose your own files.
2. TV episodes are matched with [TVmaze](https://www.tvmaze.com). No setup needed.
3. Movies are matched with [TMDB](https://www.themoviedb.org). Add your free TMDB key in
   **Settings** first (themoviedb.org → Settings → API). The key is stored only in your browser.
4. Anything Shelf isn't sure about is marked **Review**. Click it, and pick the right match on
   the right-hand side, or search by title.
5. Click **Rename…** to download a small script that does the renaming on your Mac.

### Running the rename script

A web page can't rename files on your computer by itself, so Shelf gives you a script instead.

1. Put `shelf-rename.sh` in the folder with your videos.
2. Open **Terminal** (press ⌘ Space, type *Terminal*, press Return).
3. Type `bash ` (with a space), drag the script into the Terminal window, and press Return.

Download **shelf-undo.sh** too. Running it the same way puts everything back.

Shelf never overwrites a file that already exists. It skips it and tells you.

## What it understands

- Movie names with or without a year, including `2001.A.Space.Odyssey.1968`, `1917 (2019)` and `[YTS] The Matrix (1999)`
- Episodes written as `S01E02`, `1x02` or `Season 1 Episode 2`
- Subtitles with languages and flags, like `.en.srt` and `.eng.forced.srt`
- Release junk such as `1080p`, `BluRay`, `x264`, `WEB-DL` and release group tags, which is ignored
- Remakes with the same title (*Nosferatu* 1922 / 1979 / 2024), which are flagged for you to pick instead of guessed

## Settings

- **Add TMDB ID to movie names**: `Charade (1963) {tmdb-4808}.mkv`. Plex then never mismatches it.
- **Add year to show names**: `Doctor Who (2005)`. Useful when a show has been remade.
- **Move, Copy or Hard Link**: hard links use no extra disk space, which is handy for files you keep seeding.

## Project layout

```
index.html        the app
css/styles.css    macOS-style look, light and dark mode
js/parser.js      filename parsing, match scoring, Plex names, script builder (no network)
js/sources.js     TMDB and TVmaze lookups
js/app.js         the interface
tests/            run with: node tests/parser.test.js
```

No build step and no dependencies. Open `index.html`, or serve the folder with any static web server.

## Credits

This product uses the TMDB API but is not endorsed or certified by TMDB.

TV information is provided by [TVmaze](https://www.tvmaze.com), licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Shelf is not affiliated with Plex Inc.

## License

MIT. See [LICENSE](LICENSE).
