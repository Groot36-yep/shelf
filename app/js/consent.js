/* Shelf's permission window: shows what Shelf is asking to do, and sends back only Yes or No. */
(function () {
  'use strict';
  var bridge = window.shelfConsent;
  function $(id) { return document.getElementById(id); }
  var NS = 'http://www.w3.org/2000/svg';
  function icon(paths) {
    var s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24');
    paths.forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  // Big icons (one per kind of request) and small ones for the points.
  var BIG = {
    cards: ['M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z', 'M7 10h10M9 14h6'],
    deep: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M15.5 15.5L20 20', 'M8 10.5h5M10.5 8v5'],
    open: ['M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z', 'M10 9v6l5-3z'],
    split: ['M6 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 15a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M8 8l12 9M8 16l12-9'],
    length: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7.5V12l3 2']
  };
  var SMALL = {
    lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
    trash: ['M5 7h14', 'M9 7V5h6v2', 'M7 7l1 13h8l1-13'],
    clock: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M12 8v4l2.5 1.5'],
    keep: ['M5 12.5l4.5 4.5L19 7.5'],
    eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z']
  };
  function sendSize() { bridge.size(Math.ceil($('c').getBoundingClientRect().height)); }

  bridge.onShow(function (d) {
    document.body.dataset.kind = d.kind || 'cards';
    $('cIcon').replaceChildren(icon(BIG[d.kind] || BIG.cards));
    $('cTitle').textContent = d.title || '';
    $('cLead').textContent = d.lead || '';
    $('cPoints').replaceChildren.apply($('cPoints'), (d.points || []).map(function (p) {
      var li = document.createElement('li');
      li.appendChild(icon(SMALL[p.icon] || SMALL.keep));
      var t = document.createElement('span'); t.textContent = p.text; li.appendChild(t);
      return li;
    }));
    var files = d.files || [];
    $('cFilesBox').hidden = !files.length;
    $('cFilesLabel').textContent = files.length === 1 ? 'Video' : 'Videos';
    $('cFilesCount').textContent = files.length > 1 ? String(files.length) : '';
    var shown = files.slice(0, 6).map(function (n) {
      var li = document.createElement('li'); li.title = n;
      li.appendChild(icon(['M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z', 'M4 9h16M4 15h16M8 5v4M16 5v4M8 15v4M16 15v4']));
      var t = document.createElement('span'); t.textContent = n; li.appendChild(t);
      return li;
    });
    if (files.length > 6) { var more = document.createElement('li'); more.className = 'more'; more.textContent = 'and ' + (files.length - 6) + ' more'; shown.push(more); }
    $('cFiles').replaceChildren.apply($('cFiles'), shown);
    $('cOk').textContent = d.ok || 'Continue';
    requestAnimationFrame(function () { sendSize(); $('cOk').focus(); document.body.classList.add('in'); });
  });

  var answered = false;
  function answer(yes) { if (answered) return; answered = true; document.body.classList.add('out'); bridge.answer(yes); }
  $('cOk').addEventListener('click', function () { answer(true); });
  $('cCancel').addEventListener('click', function () { answer(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); answer(false); }
    // Tab stays between the two buttons.
    if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === $('cOk') ? $('cCancel') : $('cOk')).focus(); }
  });
})();
