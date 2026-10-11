# Shelf — what's next

Where things stand, and what's left to do. Newest first.

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
