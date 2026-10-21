# UI redesign: work in progress (branch ui-redesign)

Done so far:
- app/index.html: new window (top bar with Find, All/Needs you filter, Read Title Cards, Add, Plex server, ⚙ menu;
  "stage" panel with shows column, list, "Needs you" card, details drawer inside <main>, bottom action bar).
- app/css/styles.css: new design tokens (warm paper/ink, amber accent, dark mode), new main-window styles; sheets,
  reader, editor, send, quick picks kept from before.
- app/js/app.js: new knownFor/rowParts/rowNode (one-line rows), shelfHead, renderShows (show filter),
  renderNeeds/questionFor (Needs you card, keys 1–9), drawer open/close, render() rewired, paintDest (bottom bar).

Still to do:
- app.js: add usePickEntries(item, p) next to usePick (renderNeeds calls it); keyboard: digits → answerNeeds(k-1),
  E → Check Episodes for the Needs-you file, Esc closes drawer/menu, Enter opens drawer; ⚙ menu open/close and
  positioning (#menuBtn/#mainMenu, close on outside click and after a [data-open] item); Find input (#findInput →
  findText, scheduleRender, entrance()); filter/show changes call entrance(); list background click closes drawer;
  updateDot → $('menuBtn').classList.toggle('has-update'); pickLib → libPath = lib; paintDest().
- desktop/main.js overlayColors: Studio light {color:'#F4F1EC', symbolColor:'#1F1A15'}, dark {'#12100E','#F3EEE7'}.
- app/css/theme-70s.css: rewrite main-window parts for the new structure (keep tokens/fonts/editor parts).
- Wording pass on sheets; README "Auto Mode" → "Read Title Cards".
- Smoke tests: 'text=Choose Folder…' → '#chooseFolder'; rows now open the drawer; '.tag' → '.known'.
- Run npm test + app via Playwright (scratchpad work/uishots.js), screenshots light/dark, push branch, open PR.
