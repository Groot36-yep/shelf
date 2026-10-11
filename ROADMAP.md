# Shelf — what's next

Where things stand, and what's left to do. Newest first.

## Done (1.5)
- Live feedback while reading title cards: Queued / Reading N% per video, a done flash, and a progress bar with Stop.
- **Split window**: a half-hour holding two cartoons can be split into one file per cartoon, *only if you choose it*.
  The window plays the video with a timeline, shows Shelf's suggested cut (the black, silent gap before the
  next title card), lets you scrub, play around the cut, step, or click a frame to cut there. Cuts are lossless
  (no re-encoding) and snap to the nearest keyframe. Each part shows the episode Shelf thinks it is, with
  **Change…** to search the show's episodes. Pieces are written at Rename Now, checked, and undoable; the original is kept.
- "Wrong episode? Choose…" in the side panel, to pick any episode by title or number.

## To do next
1. **Try it on real episodes** (your own files) and report anything named wrong: file name, what Shelf picked, what it should be.
2. **Subtitles for split videos**: split `.srt` files at the same point (shift the second half's times) instead of leaving them alone.
3. **Apply to the whole show**: "Split every half-hour of this show" in one go, reusing the same cut logic per file,
   with a review list before anything is written.
4. **Originals after a split**: optional "Move originals to the Recycle Bin" button after a successful split (never automatic).
5. **Exact cuts** (optional): re-encode only the few seconds around a cut when the nearest keyframe is too far from the gap.
6. **Unreadable title cards** (Bubblestand, Hall Monitor, Squid's Day Off): try more image versions, or let you mark the
   card's spot in the split window so Shelf learns where cards are for that show.
7. **MKV/HEVC playback in the split window**: falls back to still frames today; could convert a short preview on the fly.
8. **Mac version**: build and test a macOS app (the code is mostly ready; needs a Mac build in CI).
9. **Code signing** so Windows stops showing "unknown publisher" (needs a paid certificate).
