/* Sets the chosen look before the page is drawn, so it never flashes the other one. */
(function () {
  var t = 'studio';
  try { t = JSON.parse(localStorage.getItem('shelf.theme')) || 'studio'; } catch (e) { /* default */ }
  document.documentElement.dataset.theme = t === 'seventies' ? 'seventies' : 'studio';
})();
