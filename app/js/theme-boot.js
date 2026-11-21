/* Sets the chosen look before the page is drawn, so it never flashes the other one. */
(function () {
  var t = 'studio';
  try { t = JSON.parse(localStorage.getItem('shelf.theme')) || 'studio'; } catch (e) { /* default */ }
  document.documentElement.dataset.theme = t === 'seventies' ? 'seventies' : 'studio';
  // And the app icon's style (Settings → Look), so the right one shows from the start.
  var i = 'auto';
  try { i = JSON.parse(localStorage.getItem('shelf.appIcon')) || 'auto'; } catch (e) { /* default */ }
  if (!/^(amber|walnut|sage|ocean|sunset|midnight|graphite|paper)$/.test(i)) i = t === 'seventies' ? 'walnut' : 'amber';
  document.documentElement.dataset.icon = i;
})();
