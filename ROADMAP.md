# Shelf — what's next

Where things stand, and what's left to do. Newest first.

## Next release (not released yet)
- **A calmer, clearer window.** One top bar (Find, All / Needs you, Read Title Cards, your Plex server, and a ⚙ menu
  for Settings, updates, privacy and about); your shows down the left; one line per file saying the episode, what
  it becomes, and how Shelf knows; and the rename button with where files go along the bottom. Warm paper and ink
  by day, deep brown by evening.
- **Needs you**: the files Shelf isn't sure about are asked one at a time, above the list, as a plain question with
  its answers as buttons (or keys 1–9; N for the next one, E to check the episodes in the video).
- **Details slide in** when you click a file (Enter from the keyboard, Esc to close), instead of a panel that is
  always open. Find (Ctrl+F) narrows the list by file name, show, episode title or code.
- Small, quick animations that only ever move what changed, and none at all when Windows is set to show fewer.
- **Fixed: renames that only change capital letters** (`the matrix (1999).mkv` → `The Matrix (1999).mkv`) were
  refused on Windows as "a file with this name already exists". Undo changes them back too.
- **Editions and split movies**: `Blade Runner (1982) {edition-Final Cut}`, `Kill Bill - Vol. 1 (2003) - cd1`. Before,
  two versions of a film (or its two halves) got the same name and the second was silently skipped.
- **Two files that would get the same name** are now marked "Same name" and wait for you, instead of one being
  skipped at Rename Now.
- **Subtitle languages**: about 80 languages and regional tags (`pt-BR`, `zh-Hans`, `es-419`, `chs`); before, many
  were lost and showed up as the episode title.
- **Anime and other shows numbered from episode 1** (`[Group] One Piece - 1085 (1080p)`, `Show - 05 [1080p]`).
- **IMDb ids** in names (`{imdb-tt0133093}`) are looked up directly.
- **Undo history**: Undo puts back your last 50 renames, one at a time, not just the last one. Taking a file off
  the list can be undone too (Ctrl+Z).
- **Safer moves**: moving to another drive keeps the file's dates; nothing is written through a link that leads out
  of your library folder.
- **Faster and lighter with big folders** (2,080 files, measured in the window): matching 42 s → 27 s, layout work
  15.8 s → 1.5 s, script time 7.2 s → 2.4 s, window memory 11.6 MB → 5.8 MB, poster downloads 5.4 MB → 1.9 MB.
  Rows out of sight aren't drawn, posters are the size they're shown at, lookups kept in memory are capped, and
  title-card reading starts fewer readers when memory is short.
- **Double-length episodes**: once a title card names an episode as long as the whole video (a special like
  *SpongeBob's Last Stand* or *Pest of the West*), Shelf stops looking for a second cartoon. Before, it searched
  the rest of the video for one, which was slow and could turn up a false second episode. On the two real specials:
  114 s → 28 s, and both now come out as one episode.
- **Fixing a file in one click**: when Shelf isn't sure, the side panel offers the likeliest answers from the show's
  own episode list (the half-hour the file's number points at, the whole half-hour, a nearby double-length episode,
  just the first cartoon, the half-hours either side). Click one or press 1–4, and Shelf moves on to the next file
  that needs you, so a whole season can be settled from the keyboard.
- **Fix My Plex Library, faster and clearer**: folders on the server are read eight at a time, Plex is asked
  1,000 files a page with pages side by side, and the title bar says exactly what's happening ("Asking Plex what
  it matched: 3,000 of 12,400…", "Looking through your folders: 412 folders, 5,230 files…") with a Stop that
  keeps what was found so far.
- **Checked on 10 real SpongeBob episodes** (Shelf's own scanner end to end: frame picking, ffmpeg, OCR, matching):
  13 of 18 title cards read by the normal scan, none wrong, same as before the changes.
- **Motion**: sheets rise in and settle, new files slide into place, a changed status springs, a renamed file gets a
  sweep, posters fade in, the side panel cross-fades. Only opacity and transform move, nothing loops, and all of it
  is off when Windows is set to show fewer animations.
- **Security**: Electron's fuses are set on the shipped app (it can't be used to run other scripts, and its files are
  checked at start-up); the Windows build pins every action to an exact commit, uses read-only access except for the
  final release step, and runs on Node 22.
- Erase All Shelf Data also removes the startup log and the undo history; a window that keeps crashing shows an
  error instead of reloading forever; the Privacy sheet and README say exactly what's kept.
- **Title cards read far better**: before reading, Shelf now cleans the picture down to the lettering alone. It splits
  the frame into its main colours, keeps the big letter-shaped blobs that sit in rows (dropping the background's
  pattern, bubbles and texture), keeps small letters and dots among them, and turns slanted lettering level (*Life of
  Crime*). Measured with Shelf's own scanner on 44 real SpongeBob videos (61 cartoons whose answers were checked by
  eye): Season 2, with the file names' hints, **32 → 36 of 36** read right in 346 s → 247 s; Season 7, with names
  that say nothing, **25 → 37 of 52** read right, **4 → 0 wrong**, 631 s → 520 s.
- **Fixed: a file where only the second cartoon's card was read** was marked Ready as that one episode, so renaming it
  would have left the first cartoon out of Plex. It's marked for a look now.
- **Live-action shows**: on-screen text isn't a title card, so a "card" that points to another season than the file's
  name says is a question now, not an answer (checked on 16 Mythbusters episodes: "THE SAN FRANCISCO" in a 2003
  episode was being read as 2016's *San Francisco Drift*).
- **When the second cartoon starts late** (a Patchy the Pirate segment, a long first cartoon: *Gary Takes a Bath* 17
  minutes into a 24-minute video), Shelf looks further on, at the moments straight after a fade to black.
- **Fewer false readings**: the show's own logo ("SpongeBob SquarePants") is no longer taken for the episode
  *SpongeBob SpareParts*; when two titles share most of their words (*The Battle* / *The Curse of Bikini Bottom*) the
  word that tells them apart must be read cleanly; a one-word title isn't found by running two words together
  ("porters old" isn't *Sold!*); and *Legends of Bikini Bottom: The Main Drain* is found from "THE MAIN DRAIN" alone.
- **Two episodes written with "&"** (`2x23 & 2x24 - Prehibernation Week & Life of Crime`, `S02E23 & S02E24`) are read
  as both episodes. Before, only the first was kept, and "Prehibernation" didn't match "Pre-Hibernation".
- **Names that only give the season** (`SpongeBob.SquarePants.S07 (3).mkv`, the copies Windows makes of one name) are
  TV episodes now, not movies: Auto Mode reads which episodes they hold. Without a title card Shelf asks instead of
  guessing "episode 1".
- **A video much longer than the episode it's named after** (a 24-minute file called *Whale Watching*, a 15-minute
  cartoon) is marked for a look once its length is known, unless a title card backs the name.
- **Double-length episodes, carefully**: the early stop only trusts an episode that's clearly longer than the show's
  usual one and no longer than the video itself (TVmaze lists 11-minute *Squid's Day Off* at 30 minutes).
- **Safer moves**: a folder in the library that links outside it is refused before any folder is made.
- **Windows build**: a failing safety test now stops the build (before, only the last test in the list counted);
  the test copy builds again; and a version that's already released is never published again over its installers.

## Done (2.1.0)
- **Read title cards in videos on your Plex server**: after Check Library, Read Title Cards, Auto
  Mode and Deep Scan work on files on the server too. Only the minutes Shelf needs are read, over
  your SSH connection, straight into memory: nothing is downloaded to disk or installed on the
  server. (A SpongeBob half-hour: both cards read in under 10 s, about half the file read.)
- **Lookups are remembered on this PC**: checking the same shows again is near-instant (2,000 files:
  55 s → 2.2 s the second time, no requests). Shows and movies with {tmdb-…} or {tvdb-…} in their
  folder name are looked up directly. Privacy → Forget Remembered Lookups clears them.
- **Adding folders is faster** (2,090 files: 560 ms → 145 ms), and the text readers stay ready for a
  minute after reading title cards, so the next batch starts sooner.
- **Fix My Plex Library**: tidy the files already on your Plex server, from this PC, with nothing
  installed on the server. Shelf lists your Plex libraries' folders over SSH, asks Plex (through the
  same SSH connection) which files it couldn't match or never added, and puts those, plus any not
  named the Plex way, in the list. Rename fixes them *on the server* (an instant rename, nothing is
  copied), removes folders left empty, and asks Plex to rescan. Undo puts everything back. In the
  sidebar under Plex Server, and in the server window.
- **Server folders**: drives linked into /mnt or /media show up (linked folders were hidden); type a
  path or jump to /, /mnt, /media, Home or a Plex folder; a folder Shelf can't open or save in says
  why, with the command that fixes it on the server.
- **Fixed: talking to Plex over SSH never worked** (Connect Plex, finding your Plex folders, "Tell
  Plex about new files"): the request went to this PC's own port 32400 instead of through the tunnel.
- **Title cards read about 40% faster** (8 SpongeBob half-hours: 66 s → 39 s, same 16 of 16 cards):
  several text readers work side by side (one per spare processor core, up to 6), and every part of a
  video gets its thumbnails made at once. Deep Scan, which reads far more pictures, gains the most:
  each moment it checks (41 pictures, two ways) is read 3.6× faster (17.1 s → 4.8 s), same text.
- **Graphics card (Settings → Reading title cards)**: Auto uses it only for heavy video (HEVC/x265,
  AV1, 4K), where it measured 1.5–2× faster; ordinary H.264 TV rips are faster on the processor
  (measured on an RTX 3070 + Ryzen 5 3600). NVIDIA (CUDA) first, then any card (Direct3D 11); if the
  card fails, the processor takes over.
- Tests: `tests/plexfix.test.js`, `tests/hwaccel.test.js`, and `tests/plexfix.smoke.js` (the whole
  Fix My Plex Library flow in the real window, against a pretend server; runs on Windows).

## Done (2.0.0)
- **Send to Plex**: Shelf copies renamed files to your Plex server over SSH, like FileZilla, but
  built in. Set up from FileZilla's saved servers in one click; the server's fingerprint is checked
  every time; Shelf uses its own key and forgets your password; Plex's Movies / TV Shows folders are
  found for you when Shelf can see Plex.
- **Automatic**: Send after renaming, tell Plex about new files, double-check every file (SHA-256,
  done while the next file sends), free up space on this PC, retry dropped connections, resume.
- **Tidier toolbar**: Clear moved to the bottom bar as **Clear List**; on a narrower window the longer
  buttons drop their extra words instead of covering the title.

## Done (1.11.0)
- **Much faster**: matching title cards to episode names (the slowest thing Shelf did) is now about
  20 times quicker and remembers its answers, so marking or removing a title card, opening and
  closing Check Episodes no longer freeze (from up to 10 seconds to a fraction of a second).
  Check Episodes fetches each picture once, stops its picture jobs the moment it closes, and no
  longer blurs over the playing video.
- **Shelf shows when it's working**: what it's doing appears under the title with a moving line,
  for opening a video, updating names, finding where to split, reading title cards and looking up.
- **Fewer, clearer buttons**: **Auto Mode** (top toolbar) reads every TV video's title cards;
  **Deep Scan** and **Check Episodes…** are always in the side panel. Gone: Check Lengths (Auto Mode
  reads the lengths too), the extra Read Title Cards buttons, Next to Check (press N), the Resolve
  window (its answers are now right on the problem card).
- **You decide**: a **One Episode / Two or More** switch for every TV file, with **+ Add Another
  Episode** and ✕ to remove one. "One long episode?" now answers with **One Episode** or **Two
  Episodes**. The cartoon / half-hour question stays on each cartoon show's shelf.
- **Better one-or-two detection**: a file named like `S03E01aE01b` is never taken for one long
  episode; Shelf uses the half-hour the title card it read belongs to.
- **Living Room, calmer**: kept the walnut and the fonts; one palette that goes with the wood
  (cream, burnt orange, harvest gold, avocado). Removed the rainbow mural, the TV set, the CRT
  reader, the stripes and the sunburst.

## Done (1.10.1)
- **Read Title Cards** is now a button in the top toolbar whenever there are TV videos, and on every
  show's shelf (not only shows Shelf thinks are split into cartoons).

## Done (1.10.0)
- **Shelves**: the list is grouped by show (and one shelf for movies), episodes in order, each show on
  its own shelf with its poster and how many files are ready or need a look.
- **Read Title Cards is always there**: on each show's shelf and in the side panel. No setting to turn
  on first. It still asks before it looks inside any video.
- **Questions asked once**: "Is each file one cartoon or a half-hour?" sits on the show's shelf; one
  answer settles every episode.
- **Every file says what's wrong** in plain words, right in the list, and **Next to Check** (or N) takes
  you to the next one. The Rename button says how many files it will rename.
- **Living Room, refined**: real wood grain instead of noise; colours checked for readability
  (every text is at least 4.5:1); chocolate text on the orange; fewer stripes, used on purpose.
- **Windows**: the minimise / maximise / close buttons now blend into whatever is behind them, sit on a
  trim strip in the Living Room, and never cover Check Episodes.
- Buttons are solid in every state (no lighter box inside the Rename button).

## Done (1.9.0)
- **Looks**: choose how Shelf looks in Settings. **Studio** is the clean look you know. **Living Room** is new:
  a 1970s den with walnut paneling, harvest-gold walls, a rainbow arch mural with a TV you drop files
  onto, cream paper windows with poster stripes, and buttons that press in like hi-fi knobs.
  Daytime follows Windows light mode, evening (lamps on) follows dark mode.
- **Life in the room**: the mural rises when the room appears and ripples when you drag files over,
  and the TV switches on to say "Let go to add them". Reading title cards happens on a wood-cabinet
  TV with a channel knob that clicks round. A finished rename sends up a little sunburst. Changing
  the look sweeps the new room in from where you clicked. All of it stays still if Windows is set
  to show fewer animations.
- Fonts (Fraunces, Nunito, Courier Prime) are built into Shelf, so nothing is downloaded.

## Done (1.8.0)
- **Updates button** in the sidebar: checks for a new version only when you click it, shows what's new,
  and installs it for you. The download comes from Shelf's own GitHub releases and must match its
  published SHA-256 fingerprint, or it's deleted and never run. Your settings and keys are kept.
- **Shelf's own permission window** for reading title cards, opening Check Episodes and the other
  "look inside a video" steps, instead of the plain Windows message box. It says what will happen,
  lists the videos, and only a click in that window counts as a yes.
- Long episode names no longer break mid-word in the side panel.

## Done (1.7.3–1.7.4) — housekeeping
- **Up-to-date engine**: Shelf now runs on Electron 44 (was 33), which fixes a dozen known security
  problems in the old version. It also opens faster (about half a second).
- **Smaller download**: the text reader's spare engine copies and browser-only files are left out
  (about 35 MB less unpacked), and only the English language pack ships (Shelf is in English).
- **Pictures from your videos are let go** as soon as the video leaves the list (and on Erase Everything).
- Tidier code: unused styles removed, `npm test` runs every quick test, and the Windows build now checks
  that the *installed* app can read a title card.

## Done (1.7.2)
- **Mark a title card yourself**: when Shelf can't read one (curved letters, a card that's only on
  screen for a moment), go to it in Check Episodes and click **Mark Title Card Here** (or press M),
  then pick the episode. Your mark counts like a card Shelf read, and wins over anything it guessed.
  The Resolve window offers **Mark It Yourself…** for a part without a card, and "One long episode?"
  offers **Mark 2nd Card…**. Tested on the 3 hardest real episodes: all 3 named right after marking.
- **File names like S03E01aE01b** (a half-hour in a/b parts) are now read as episodes, not movies.
- **Fewer false title cards**: a noisy picture no longer passes for a title just because a few
  letters line up (it read "As Seen on TV" in an episode of "The Idiot Box").

## Done (1.7.1)
- **Deep Scan** for the hard ones: when a title card was missed, one click takes a slower, closer look
  (more frames, more sizes, two separate readings must agree before a name is used). About 1–3 minutes
  per video, and it asks first.
- **Faster, sharper reading**: frames are read at a smaller size that turned out to be both faster and
  more accurate; most videos now take 15–25 seconds. Cards that fade in are caught too.
- **Fewer wrong guesses**: tested on 19 real episodes (36 title cards): 30 found by the normal scan,
  2 more by Deep Scan, and none named wrong.

## Done (1.7)
- **Title cards, tested on 10 real episodes** (seasons 3 and 7, plus a special): more card styles are read (dark, coloured,
  white and tilted lettering), wrong matches are gone (garbled text can no longer pass for a title), and reading is
  4–5× faster when both cards are read. A single long episode is no longer padded with a second one; a card between two
  black fades marks a second cartoon even when its lettering can't be read.
- **Side panel**: plain-language problem cards with buttons; each episode shows the title-card frame Shelf read and its
  own **Change**; details folded away.
- **Resolve window**: both title cards side by side, change any part, see the exact file names, and settle it in one
  click (split at the gap, keep one file, or confirm one episode).
- **Check Episodes**: editor-style scrubber (one timeline, instant preview pictures, hover preview, split points dragged by
  their handle, pinch/Ctrl-scroll zoom, J/K/L), a row with every title card, a glass "Jump to" button over the video,
  dark studio look. MKV jumps show the exact frame within about half a second.
- **Splitting fixed**: pieces now start exactly on their keyframe (before, on real videos the second piece could start
  up to ~10 s late and lose its title card).
- **Subtitles follow a split** (SRT, WebVTT, ASS/SSA), times moved per piece; picture subtitles are left alone.
- Live title-card reader animation showing the frame being read.

## Done (1.6)
- **Drag and drop fixed**: dropped files and folders are added (the file locations were being lost).
- **Check Episodes window** (replaces the split window): works on any TV file without scanning;
  One File or Split Into Files; true scrubber (cuts only move with Set Cut Here / Add Cut);
  zoomable timeline with picture strip and overview; frame step, ±1/±5 s, speed; jump between
  title cards; each part shows the frame Shelf read as its title card; clear button feedback;
  instant frame preview for formats that can't play.
- **Episode browser**: season tabs, search across all seasons, keyboard, current episode marked.
- **Side panel**: "Shelf thinks this file is…" with codes, titles and how it knows.
- **Second title cards**: Shelf now looks right after black moments first (found on the first try in testing).

## Done (1.5)
- Live feedback while reading title cards: Queued / Reading N% per video, a done flash, and a progress bar with Stop.
- **Split window**: a half-hour holding two cartoons can be split into one file per cartoon, *only if you choose it*.
  The window plays the video with a timeline, shows Shelf's suggested cut (the black, silent gap before the
  next title card), lets you scrub, play around the cut, step, or click a frame to cut there. Cuts are lossless
  (no re-encoding) and snap to the nearest keyframe. Each part shows the episode Shelf thinks it is, with
  **Change…** to search the show's episodes. Pieces are written at Rename Now, checked, and undoable; the original is kept.
- "Wrong episode? Choose…" in the side panel, to pick any episode by title or number.

## To do next
1. **Other cartoon shows**: test on 2–3 more shows; use the episode list's lengths to know whether a half-hour holds
   2 or 3 shorts (and where to look for each card).
2. **Apply to the whole show**: "Split every half-hour of this show" in one go, reusing the same cut logic per file,
   with a review list before anything is written.
3. **Originals after a split**: optional "Move originals to the Recycle Bin" button after a successful split (never automatic).
4. **Exact cuts** (optional): re-encode only the few seconds around a cut when the nearest keyframe is too far from the gap.
5. ~~**Unreadable title cards**~~ done in 1.7.2 (Mark Title Card Here). Was: let you mark the card's spot
   so Shelf learns where cards are for that show.
6. **HEVC playback in the split window**: falls back to still frames today; could convert a short preview on the fly.
7. **Speed pass**: time start-up, big folders, matching and renaming to make sure nothing got slower.
8. **Mac version**: build and test a macOS app (the code is mostly ready; needs a Mac build in CI).
9. **Code signing** so Windows stops showing "unknown publisher" (needs a paid certificate).
10. **Send to Plex, next**: send several files at once on very fast networks; Wake-on-LAN for a sleeping
    server; check free space per folder when Movies and TV Shows are on different drives.
