// Sơ đồ bàn 2.5D (views/pages/tables_map.ejs): view mode = tilted plan, tap opens the POS;
// edit mode = flat plan, drag tables, pick a shape, save through POST /admin/tables/layout (JSON, CSRF in a header).
(function () {
  'use strict';
  var floor = document.getElementById('floor');
  if (!floor) return;
  var btnEdit = document.getElementById('map-edit');
  var btnSave = document.getElementById('map-save');
  var tools = document.getElementById('map-tools');
  var label = document.getElementById('map-selected');
  var shapeBtns = tools.querySelectorAll('[data-shape]');
  var tables = Array.prototype.slice.call(floor.querySelectorAll('.fp-table'));
  var csrf = document.getElementById('map-csrf').value;
  var editing = false;
  var dirty = false;
  var selected = null;
  var drag = null;
  var moved = false;

  function state(el) { return { id: Number(el.dataset.id), x: Number(el.dataset.x), y: Number(el.dataset.y), shape: el.dataset.shape }; }

  function place(el, x, y) {
    el.dataset.x = x;
    el.dataset.y = y;
    el.style.left = (x / 10) + '%';
    el.style.top = (y / 10) + '%';
  }

  function select(el) {
    if (selected) selected.removeAttribute('data-selected');
    selected = el;
    if (el) el.setAttribute('data-selected', 'true');
    label.textContent = el ? el.dataset.name : 'Chọn một bàn để đổi hình dạng';
    shapeBtns.forEach(function (b) { b.disabled = !el; });
  }

  function setEditing(on) {
    editing = on;
    floor.dataset.mode = on ? 'edit' : 'view';
    btnEdit.textContent = on ? 'Thoát sửa' : 'Sửa bố cục';
    btnSave.classList.toggle('hidden', !on);
    tools.classList.toggle('hidden', !on);
    tools.classList.toggle('flex', on);
    if (!on) select(null);
  }

  btnEdit.addEventListener('click', function () {
    if (editing && dirty && !window.confirm('Bố cục chưa lưu sẽ mất. Thoát sửa?')) return;
    if (editing && dirty) window.location.reload();
    setEditing(!editing);
  });

  tables.forEach(function (el) {
    // In edit mode a tap selects instead of following the link; a drag moves the table.
    el.addEventListener('click', function (e) { if (editing) e.preventDefault(); });
    el.addEventListener('pointerdown', function (e) {
      if (!editing) return;
      e.preventDefault();
      var r = floor.getBoundingClientRect();
      drag = { el: el, r: r, dx: e.clientX - (r.left + (Number(el.dataset.x) / 1000) * r.width), dy: e.clientY - (r.top + (Number(el.dataset.y) / 1000) * r.height) };
      moved = false;
      el.setPointerCapture(e.pointerId);
      select(el);
    });
    el.addEventListener('pointermove', function (e) {
      if (!drag || drag.el !== el) return;
      var x = Math.min(1000, Math.max(0, Math.round(((e.clientX - drag.dx - drag.r.left) / drag.r.width) * 1000)));
      var y = Math.min(1000, Math.max(0, Math.round(((e.clientY - drag.dy - drag.r.top) / drag.r.height) * 1000)));
      if (x !== Number(el.dataset.x) || y !== Number(el.dataset.y)) { moved = true; dirty = true; place(el, x, y); }
    });
    var end = function () { drag = null; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });

  shapeBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      if (!selected) return;
      selected.dataset.shape = b.dataset.shape;
      dirty = true;
    });
  });

  document.getElementById('map-reset').addEventListener('click', function () {
    var cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
    var rows = Math.max(1, Math.ceil(tables.length / cols));
    tables.forEach(function (el, i) {
      place(el, Math.round(80 + (i % cols) * (840 / cols)), Math.round(80 + Math.floor(i / cols) * (840 / rows)));
    });
    dirty = true;
  });

  btnSave.addEventListener('click', function () {
    btnSave.disabled = true;
    fetch('/admin/tables/layout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ tables: tables.map(state) })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok, j: j }; }); })
      .then(function (res) {
        btnSave.disabled = false;
        if (!res.ok) { window.alert(res.j.error || 'Không lưu được bố cục.'); return; }
        dirty = false;
        setEditing(false);
      })
      .catch(function () { btnSave.disabled = false; window.alert('Mất kết nối, chưa lưu được bố cục.'); });
  });

  window.addEventListener('beforeunload', function (e) { if (editing && dirty) { e.preventDefault(); e.returnValue = ''; } });
})();
