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
   TV shows use the same episode order as Plex: The Movie Database by default (same key), or TheTVDB
   if your Plex is set to it (add your TheTVDB key). Without a key, TV shows use [TVmaze](https://www.tvmaze.com).
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
- Shows kept in folders, like `Breaking Bad (2008)/Season 1/E01.mkv`, double episodes (`S01E01-E02`),
  daily shows by date, and Specials
- **Two-part cartoons** like *SpongeBob SquarePants* and *The Fairly OddParents*. The databases list
  each 11-minute cartoon as its own episode, but most files hold a whole half-hour. Shelf reads the
  cartoon titles in the file name (`S01E02 Bubblestand Ripped Pants` → `S01E04-E05`). Without titles it
  works out from your files whether they're numbered by cartoon or by half-hour, and asks once if it
  can't tell. DVD numbering is fixed the same way, by title.
- Names like `SpongeBob SquarePants - Reef Blower` with no episode number: Shelf checks that show's
  episode list for the title (and keeps it a movie if there's no such episode).

## Looking inside videos (only when you ask)

Shelf never reads a video's contents on its own. For shows split into short cartoons, two buttons
appear on a file that needs a look, and each one shows a Windows prompt naming the files first:

- **Check Lengths** reads only the small part of each file that says how long it is (MP4, MKV, AVI).
  About 11 minutes means one cartoon, about 22 means a half-hour.
- **Read Title Cards** (turn on in Settings → Advanced) finds the moments where the picture holds
  still and reads the text there with an OCR engine built into Shelf, then compares it with the
  show's real episode titles. On 16 real SpongeBob title cards it identified 12 and got none wrong;
  when it isn't sure it says so instead of guessing. Everything happens on your computer: nothing is
  uploaded or downloaded, and no pictures are saved. Takes roughly 5–30 seconds per video.

## Check Episodes: see what's really in a file (and split it, if you want)

Every TV file shows which episodes Shelf thinks it holds, with the frame of each title card it read
and *how* it knows (title cards, the title in the file name, or just the number). Each episode has
its own **Change** (season tabs, search by title or `S01E08`). If something needs a decision, a
problem card says so in plain words: **Resolve…** shows the title cards side by side and settles it
in one click (split the file at the gap, keep one file, or confirm one long episode).

**Check Episodes…** opens the video, after a prompt, in a window built for checking:

- A player with frame-by-frame stepping (hold to repeat), ½×–2× speed, J/K/L and
  "Play Around Cut".
- One timeline, like a video editor: drag to scrub (preview pictures follow instantly), hover to
  skim, pinch or Ctrl + scroll to zoom down to 6 seconds. Split points move only when you drag
  their own handle (they snap to the black gap) or use **Set Cut Here**.
- Every title card Shelf read is one click away (a row under the timeline, and a **Jump to**
  button over the video).
- **One File** keeps one name (listing every episode in it, if they're in a row), or **Split Into
  Files** gives each episode its own file. Shelf suggests each cut at the black, silent moment
  before the next episode. You move a cut only with **Set Cut Here** (or add and remove cuts).
- Formats the built-in player can't show (like HEVC) switch to a frame preview that scrubs
  instantly.

Nothing is cut until **Rename Now**. Cuts don't re-encode, so quality is untouched; your original is
kept, and **Undo** removes the pieces. See [ROADMAP.md](ROADMAP.md) for what's next.

## Settings

- **Add TMDB ID to movie names**: `Charade (1963) {tmdb-4808}.mkv`. Plex then never mismatches it.
- **Add year to show names**: `Doctor Who (2005)`. Useful when a show has been remade.
- **Episode order**: The Movie Database (Plex's default), TheTVDB (Aired) or TheTVDB (DVD). Pick the
  one your Plex uses (in Plex: open the show → Edit → Advanced → Episode ordering).
- **Add show ID to folder names** (on by default): `SpongeBob SquarePants {tmdb-387}`, so Plex picks the right show.
- **Read title cards** (Advanced, off by default): see above.
- **Add quality to file names**: `Charade (1963) - 1080p BluRay.mkv`, and `[1080p BluRay]` for episodes.
- **Move, Copy or Hard Link**: hard links use no extra disk space, which is handy for files you keep seeding.
- **Show posters**: turn off to download no images at all.
- **Forget Key** removes your TMDB key. **Privacy → Erase All Shelf Data** removes everything Shelf saved.

## Project layout

```
app/              the window: index.html, styles, parsing (js/parser.js), lookups (js/sources.js), interface (js/app.js)
desktop/          main.js (window + security), preload.js (the small bridge), fileops.js (the only code that touches files)
tests/            npm test; app/tv/sources.smoke.js run the whole app end to end with mocked lookups
index.html        the download page at groot36-yep.github.io/shelf
```

Run from source: `npm install`, then `npm start`. Build the Windows installer: `npm run dist:win`.
Every release is built by GitHub Actions on Windows, after the safety tests pass there.

## Credits

This product uses the TMDB API but is not endorsed or certified by TMDB.

Metadata provided by [TheTVDB](https://thetvdb.com). Please consider adding missing information or
[subscribing](https://thetvdb.com/subscribe).

TV information is provided by [TVmaze](https://www.tvmaze.com), licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Shelf is not affiliated with Plex Inc.

## License

MIT. See [LICENSE](LICENSE).
