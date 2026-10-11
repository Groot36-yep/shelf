# Shelf — what's next

Where things stand, and what's left to do. Newest first.

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

## Done after 1.6 (not released yet)
- **Subtitles follow a split**: text subtitles (SRT, WebVTT, ASS/SSA) next to a split video are cut at the same points,
  with times moved so each piece starts at 0, and named to match each piece. The text's encoding is kept byte for byte.
  Picture subtitles (IDX/SUB) are left alone and the rename summary says so. Undo removes the pieces; the original is kept.

## To do next
1. **Try 1.6 on real episodes** (your own files) and report anything that feels clunky or named wrong.
2. **Apply to the whole show**: "Split every half-hour of this show" in one go, reusing the same cut logic per file,
   with a review list before anything is written.
3. **Originals after a split**: optional "Move originals to the Recycle Bin" button after a successful split (never automatic).
4. **Exact cuts** (optional): re-encode only the few seconds around a cut when the nearest keyframe is too far from the gap.
5. **Unreadable title cards** (Bubblestand, Hall Monitor, Squid's Day Off): try more image versions, or let you mark the
   card's spot in the split window so Shelf learns where cards are for that show.
6. **MKV/HEVC playback in the split window**: falls back to still frames today; could convert a short preview on the fly.
7. **Mac version**: build and test a macOS app (the code is mostly ready; needs a Mac build in CI).
8. **Code signing** so Windows stops showing "unknown publisher" (needs a paid certificate).
