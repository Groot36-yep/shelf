# Shelf

**Rename your movie, TV and music files so Plex recognizes them.**

Shelf is a friendly, Mac-style take on tools like FileBot. Drop in your video files, and Shelf
works out what each one is, looks it up, shows you the match with its poster, and gives it the
exact name and folder that Plex expects.

```
charade.1963.1080p.bluray.x264-GRP.mkv        →  Movies/Charade (1963)/Charade (1963).mkv
bonanza.s01e01.a.rose.for.lotta.mkv           →  TV Shows/Bonanza/Season 01/Bonanza - S01E01 - A Rose for Lotta.mkv
bonanza.s01e01.a.rose.for.lotta.en.srt        →  TV Shows/Bonanza/Season 01/Bonanza - S01E01 - A Rose for Lotta.en.srt
ABBA/Gold/01 Dancing Queen.ogg                →  Music/ABBA/Gold - Greatest Hits (1992)/01 - Dancing Queen.ogg
```

> **Private by design.** Your videos, folders and file list never leave your computer (unless you send
> the videos to your own Plex server). Only a
> cleaned-up title (like `Charade` + `1963`) is ever looked up. No accounts, no tracking, and it
> never checks for updates on its own.


**Two looks.** *Studio* is clean and quiet. *Living Room* is warm walnut with 1970s type and one
calm palette to match the wood. Pick one in Settings → Look; both follow
Windows light or dark mode. The Living Room's fonts (Fraunces, Nunito, Courier Prime) are under the
SIL Open Font License (see `app/assets/fonts/OFL.txt`) and are built in, so nothing is downloaded.

**Send to Plex.** Shelf can put your renamed files straight onto your Plex server over SSH (the
same secure way FileZilla does), into the right Movies, TV Shows and Music folders. See
[Send to Plex](#send-to-plex-your-own-server-over-ssh) below.

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

1. Open Shelf, open **Settings** from the ⚙ menu (top right) and paste your free TMDB key (themoviedb.org → Settings → API).
   TV shows use the same episode order as Plex: The Movie Database by default (same key), or TheTVDB
   if your Plex is set to it (add your TheTVDB key). Without a key, TV shows use [TVmaze](https://www.tvmaze.com).
2. Click **Choose Folder…** (or drag files onto the window).
3. If a file needs you, the **Needs you** card above the list asks one plain question at a time: click an answer
   (or press its number). Click any file to open its details, where you can change the match or search by title.
4. Click **Rename** (bottom right), choose your Plex library folder and **Move**, **Copy** or **Hard Link**, then **Rename Now**.
5. Changed your mind? **Undo Rename** puts the last rename back. Press it again to go further back (Shelf
   remembers your last 50).
6. Have a Plex server? Click **Send to Plex** (see below).

Shortcuts: **Ctrl+O** add files · **Ctrl+Shift+O** add a folder · **Ctrl+Enter** rename ·
**Ctrl+Z** undo (again to go further back: your picks of show and episodes, splits, files taken off the list, then renames) · **Ctrl+,** settings · **Delete** remove from list (Ctrl+Z puts it back) ·
**Ctrl+F** find · **N** next file that needs you · **1–9** answer the Needs you card · **E** check the episodes in the video ·
**Enter** open a file's details · **Esc** close them. In Inspect, **Ctrl+Z** / **Ctrl+Y** undo and redo changes to
the episodes, cuts and title-card marks; everything you changed there is also one Ctrl+Z in the list afterwards.

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

Shelf never reads a video's contents on its own. These buttons are always there for TV videos, and
each one shows a prompt naming the files first:

- **Read Title Cards** (top bar) reads the title cards of every TV video in the list. It finds the moments where the picture holds
  still and reads the text there with an OCR engine built into Shelf, then compares it with the
  show's real episode titles, and notes how long each video is. On 36 real SpongeBob title cards it identified 30 and got none wrong (**Deep Scan**, in a file's details, finds
  more of the hard ones, and for any it can't read you can **mark the title card yourself**);
  when it isn't sure it says so instead of guessing. Everything happens on your computer: nothing is
  uploaded or downloaded, and no pictures are saved. Takes roughly 15–30 seconds per video
  (Deep Scan: 1–3 minutes; Shelf does it by itself for the videos Read Title Cards couldn’t recognise).
- While it's there, it also measures how loud the first seconds are. A logo much louder than the show (the
  Nickelodeon one before SpongeBob) is turned down to the show's level by **Rename Now**: only those seconds of sound
  change (re-encoded once, at about the same quality), the picture is copied as it is, and your original is kept (or
  goes to the Recycle Bin with Move). There's a switch for it in Rename Now.

## Sound tracks: English first, others removed, another language added

A video with more than one language (Hindi and English, say) lists its sound tracks in its details. Shelf suggests
your language to play first (**Settings → File Names → Sound tracks**: your language, and whether to play it first,
keep only it, or leave the tracks alone), and you can untick tracks to remove them or pick another to play first.
**Rename Now** makes a new copy with the tracks changed: nothing is re-encoded, so it's quick and loses nothing, and
your original is kept (or goes to the Recycle Bin with Move); Undo removes the copy. Ctrl+Z undoes your picks.

**Add a Language from Another File…** takes the sound track from another copy of the same episode or movie (another
release, in another language) and adds it. Shelf lines it up with this video by comparing how the two sound moment by
moment, and refuses one that won't stay in time: a different cut (scenes added or taken out), or a European copy that
plays about 4% faster. Only that added track is re-encoded, once. (Plex also has a preferred audio language of its own,
in your Plex account's settings.) Videos on your Plex server aren't changed here: rename them on this PC first.

## Inspect: see what's really in a file (and split it, if you want)

Every TV file shows which episodes Shelf thinks it holds, with the frame of each title card it read
and *how* it knows (title cards, the title in the file name, or just the number). Each episode has
its own **Change** (season tabs, search by title or `S01E08`), and the switch **One Episode / Two or
More** is always there, so you can say how many episodes a file holds yourself. If something needs a
decision, a card says so in plain words and answers it in one click (for example **One Episode** or
**Two Episodes**, or **Split into 2 Files** at the gap). Whenever Shelf is busy, it says what it's doing
under the title, so it never just looks frozen.

**Inspect…** opens the video, after a prompt, in a window built for checking:

- A big picture that takes all the room the controls leave, with clear controls: one second back,
  one frame back (hold to repeat), play, one frame forward, one second forward, ½×–2× speed, and J/K/L.
  **Shortcuts** (or `?`) lists every key.
- One timeline, like a video editor: drag to scrub (preview pictures follow instantly), hover to
  skim, pinch or Ctrl + scroll to zoom down to 6 seconds. Split points move only when you drag
  their own handle (they snap to the black gap) or use the cut bar.
- Every title card Shelf read is one click away (a row under the timeline, and a **Jump to**
  button over the video).
- **Drag the episodes** by their grip (or Alt+↑ / Alt+↓) into the order they play in.
- **One File** keeps one name (listing every episode in it, if they're in a row), or **Split Into
  Files** gives each episode its own file. Shelf suggests each cut at the black, silent moment
  before the next episode.
- In split view, the **cut bar** shows the last frame before the cut and the first frame after it, side
  by side, so you can check a cut at a glance without playing it. Pick a cut with ‹ ›, **Nudge** it to
  the clean cutting point before or after (`,` `.`), **Preview Cut** (4 s either side), **Move Cut to
  Playhead** (`C`), **Add Cut** or delete it. A part much shorter or longer than its episode should be
  says so.
- Formats the built-in player can't show (like HEVC) switch to a frame preview that scrubs
  instantly.

You don't have to open the video to split: a file's details offer **Split into N Files** (Shelf finds the gaps) and
**Split by Hand…**, and **Split All** on a show's heading splits every file of that show that holds more than one
episode, after asking once.

Nothing is cut until **Rename Now**. Cuts don't re-encode, so quality is untouched; your original is
kept, and **Undo** removes the pieces. See [ROADMAP.md](ROADMAP.md) for what's next.

## Missing episodes: do you have every one?

Click **Missing Episodes** on a show's heading in the list (or **Missing Episodes…** in the ⚙ menu) to see which
episodes of the show you don't have yet, season by season: "Season 2: missing S02E07 Mermaid Man and Barnacle Boy III,
S02E20 Gary Takes a Bath". When nothing is missing it says so: **You have all 77 episodes**.

- **What it counts:** the show's files in the list (what Shelf worked out, what you picked in Inspect, and each piece
  of a split), and, if you've set up Send to Plex, the files in the show's folder on your server (by their names,
  read only: nothing on the server is changed). A file holding several episodes (`S01E01-E02-E03`, `S01E04E05`)
  counts for each of them, and the same episode twice counts once.
- **What it compares with:** the show's full episode list from The Movie Database, TheTVDB or TVmaze, in the
  episode order you picked in Settings (the order Plex uses).
- **Left out:** specials (season 0) are shown apart and never make a show look incomplete, and episodes that haven't
  aired yet aren't counted as missing.
- **Said apart:** episodes you have that aren't on the list (often files numbered in another episode order), and
  files whose names don't say which episode they are.
- From the ⚙ menu you can also pick a show that's only on your server. **Copy the List** copies the missing episodes
  as text, one per line.

## Music

Drop in a music folder like anything else. Shelf reads each song's tags, puts songs together into
albums by itself (no dragging files onto albums), and looks each album up on
[MusicBrainz](https://musicbrainz.org):

- **The right edition.** Albums come in many editions (years, countries, CD or digital, bonus tracks).
  Shelf picks the one your songs fit best: the one their MusicBrainz ids name (if Picard or Shelf tagged
  them before), else the one whose track list matches their titles, numbers and lengths, and the year
  in their tags tells same-named albums apart. A few of an album's songs is fine ("6 of 19 songs").
  **Other Editions…** shows every edition side by side; **Search…** finds another album.
- **See every change first.** Each song shows its tags now → after (only what changes stands out), and
  the name and folder it gets. Albums Shelf isn't sure about wait for **Looks Right**.
- **Rename Now** writes the tags (title, artists, album, album artist, track and disc numbers, year,
  MusicBrainz ids, genres if you want) and the album's cover from the
  [Cover Art Archive](https://coverartarchive.org), then files each song the Plex way:
  `Music/Album Artist/Album (Year)/01 - Title.ext` (several discs: `1-01`; compilations under
  `Various Artists`). Synced lyrics (`.lrc`) go along with their song. **Undo** puts back names, tags
  and covers.
- **Songs with no useful tags or names** are recognised by their sound, with a free
  [AcoustID](https://acoustid.org) key (Settings → Music). Shelf listens to them on this PC (Chromaprint's
  fpcalc, built in) and sends only a code made from the sound, and its length.
- **Make lossless songs smaller.** Rename Now offers to turn FLAC, WAV, AIFF and ALAC songs into
  Ogg Vorbis (quality 6) or Opus (160 kbps): about a sixth of the size, sounding the same, with every tag
  and the cover. Copy keeps your originals; Move sends them to the Recycle Bin once each smaller copy is
  checked.
- Formats: MP3, FLAC, M4A/AAC, Ogg Vorbis, Opus, WMA, WAV, AIFF, APE, WavPack and more. A damaged
  file is set aside and explained.
- MusicBrainz is asked politely (Shelf says who it is, at most one question a second, and waits when it's
  busy), and every answer is remembered for 30 days.

## Send to Plex (your own server, over SSH)

If your Plex server is another computer (for example Ubuntu) and you used to copy files with
FileZilla, Shelf can do it for you.

**Set it up once** (click **Plex server** in the top bar, or **Send to Plex**):
1. Pick your server from FileZilla's saved servers (one click), or type its address.
2. Check the server's fingerprint and click **Yes, This Is My Server**. Shelf remembers it, and if it
   ever changes, Shelf stops before sending your password or any file.
3. Log in. Shelf makes its own secure key, adds it to your server, and forgets your password.
4. Choose your server's Movies and TV Shows folders. If Shelf can see Plex on the server it finds
   them for you.

**Then:** rename as usual and click **Send to Plex**, or turn on **Send after renaming** so
**Rename Now** does both. A tray at the bottom shows progress, speed and time left. You can keep
working while it sends.

- **Safe copies.** Each file arrives under a hidden temporary name and only gets its real name once
  it's complete. Plex never sees half a file. **Double-check every file** compares a SHA-256
  fingerprint of each file on both ends, while the next file is already sending.
- **Never overwrites.** Files already on the server are skipped. If a *different* file has the same
  name, Shelf asks: **Skip Them** or **Replace Them**.
- **Picks up where it stopped.** Stop at any time, or lose the connection. Shelf retries by itself
  (6 times over about 2 minutes), and the next send continues from where it was, backing up a little
  to be sure nothing is missing. A connection that stops moving without closing is noticed within a
  minute and retried, instead of waiting forever.
- **Plex finds them right away.** With **Tell Plex about new files**, Shelf asks Plex to look at
  just the new folders (through the same encrypted connection).
- **Free up space on this PC** (off by default): each file goes to the Recycle Bin, but only once
  it's on the server and its fingerprint matched.
- **Send Everything in My Library…** sends anything in your library that isn't on the server yet.
- **Server Files…** (in the ⚙ menu) works like FileZilla: your server on the left, this PC on the right.
  Pick files or whole folders and click **Copy to This PC** or **Copy to Server**, or drag them across
  (from File Explorer too). Pick several as in Windows: **Ctrl**+click, **Shift**+click for a run, **Ctrl+A**,
  or click and drag from an empty spot (or a file's size or date) to draw a box around them. The transfers list shows speed and time left; pause, resume, cancel, and
  try again if one fails. Copies arrive under a temporary name and only get their real name once
  complete, keep their dates, and pick up where they stopped. Files already there: Shelf asks once
  (Skip, Replace or Keep Both), and skips ones with the same size and date. New Folder, Rename and
  Delete work on the server (Delete asks first; it can't be undone). **Ctrl+Z** undoes renames and new folders,
  newest first (a new folder only while it's still empty).
- **Fix My Plex Library…** (in the ⚙ menu) finds files already on your server that Plex couldn't match,
  hasn't added, or that aren't named the Plex way. You pick which shows to fix, and can open a show to
  pick just some of its seasons. **Include files that already look right** lists every file, so you can
  redo episodes you fixed before. They're renamed right there on the server, and **Read Title Cards** and **Check
  Episodes…** work on them too, reading only the parts they need over SSH (nothing is downloaded or
  saved). A file holding episodes that aren't next to each other can be **split** there too: it's read
  over SSH once, cut on this PC (no re-encoding), and the pieces are sent back and checked. The original
  stays on the server as `….shelf-original` (Plex ignores it), and **Undo** puts it back.
- **Find Duplicate Episodes…** (in the ⚙ menu) finds episodes that are in more than one file on your
  server, such as a half-hour kept as one file *and* as two separate files, or a file copied twice. Choose
  **Two-Part Files** or **One File per Episode** (or pick file by file); Shelf keeps one copy of each and
  sets the others aside (renamed to `….shelf-duplicate`, which Plex ignores; nothing is deleted), then
  Plex rescans. **Undo** puts them back.
- **Make Music Smaller…** (in the ⚙ menu) finds the FLAC and other lossless songs in your server's music
  folder, by album, with the space it would save. Each is copied here, made smaller (Ogg Vorbis or Opus,
  with all its tags and cover), sent back next to the original and checked; the original is set aside
  (`….shelf-original`, which Plex ignores) and Plex rescans. **Undo** puts the originals back.
- **Free Up Space on Server…** (in the ⚙ menu) lists those set-aside files (originals of split videos, of
  songs made smaller, and duplicate episodes) with their sizes, and deletes the ones you pick, after you
  confirm. Deleted files can't be put back.
- **Forget This Server…** deletes everything Shelf saved about it, and can take Shelf's key back off
  the server.

Needs SSH on the server (Ubuntu: `sudo apt install openssh-server`). Your account must be allowed
to save files in the folders you pick. Shelf tells you if it isn't.

## Settings

- **Add TMDB ID to movie names**: `Charade (1963) {tmdb-4808}.mkv`. Plex then never mismatches it.
- **Add year to show names**: `Doctor Who (2005)`. Useful when a show has been remade.
- **Episode order**: The Movie Database (Plex's default), TheTVDB (Aired) or TheTVDB (DVD). Pick the
  one your Plex uses (in Plex: open the show → Edit → Advanced → Episode ordering).
- **Add show ID to folder names** (on by default): `SpongeBob SquarePants {tmdb-387}`, so Plex picks the right show.
- **Add quality to file names**: `Charade (1963) - 1080p BluRay.mkv`, and `[1080p BluRay]` for episodes.
- **Move, Copy or Hard Link**: hard links use no extra disk space, which is handy for files you keep seeding.
- **Show posters**: turn off to download no images at all.
- **Forget Key** removes your TMDB key. **Privacy → Erase All Shelf Data** removes everything Shelf saved.

## Project layout

```
app/              the window: index.html, styles, parsing (js/parser.js), lookups (js/sources.js), interface (js/app.js),
                  music matching (js/music.js) and its part of the window (js/musicui.js),
                  missing episodes (js/missing.js, the counting; js/missingui.js, its sheet)
desktop/          main.js (window + security), preload.js (the small bridge), fileops.js (the only code that touches files),
                  server.js + plexsend.js (Send to Plex over SSH), transfer.js (Server Files), showcheck.js (a show's files on the server, for Missing Episodes),
                  tags.js (music tags), musicbrainz.js (album lookups)
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

Music information is provided by [MusicBrainz](https://musicbrainz.org) (CC0), and album covers by the
[Cover Art Archive](https://coverartarchive.org). Music tags are read and written with
[node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp) (LGPL-2.1).

Shelf is not affiliated with Plex Inc.

## License

MIT. See [LICENSE](LICENSE).
