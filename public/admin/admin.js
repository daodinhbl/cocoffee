/* CoCoffee Web Admin: vanilla JS only (no React/Vue/jQuery).
   Everything is wired by event delegation on data-* hooks, so it works with any page that follows the markup. */
(function () {
  'use strict';

  var html = document.documentElement;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
  };
  var norm = function (s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  };
  var fmtMoney = function (n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + 'đ'; };
  var fmtPct = function (n) { return n.toFixed(1).replace('.', ',') + '%'; };

  /* ------------------------------------------------------------------ toast */
  var TOAST_TONE = { info: 'border-gray-200', success: 'border-green-300', warn: 'border-amber-300', error: 'border-red-300' };
  function toast(message, tone) {
    var region = $('#toast-region');
    if (!region) return;
    var el = document.createElement('div');
    el.className = 'pointer-events-auto rounded border border-l-4 bg-white px-4 py-3 text-sm text-gray-800 shadow-sm ' + (TOAST_TONE[tone] || TOAST_TONE.info);
    if (tone === 'success' || !tone) el.className += ' border-l-amber-400';
    el.textContent = message;               // textContent: never interpret the message as HTML
    region.appendChild(el);
    window.setTimeout(function () { el.remove(); }, 4200);
  }
  window.CoCoffee = { toast: toast };

  /* ---------------------------------------------------------------- sidebar */
  var sidebar = $('#sidebar');
  var overlay = $('[data-sidebar-overlay]');
  var drawerTrigger = null;

  function syncCollapseButton() {
    var collapsed = html.getAttribute('data-sb') === 'collapsed';
    var btn = $('[data-sidebar-collapse]');
    if (!btn) return;
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng');
    btn.title = collapsed ? 'Mở rộng' : 'Thu gọn';
  }
  /* Device tiers (same thresholds as the inline script in layout.ejs):
       phone <768   off-canvas drawer + bottom tab bar, tables become cards
       tablet 768-1023   icon rail (always collapsed), card grid
       laptop 1024-1279  rail by default, full table
       desktop >=1280    expanded sidebar
     A saved sidebar preference is honoured only at >=1024 (the toggle button is hidden below that). */
  function effectiveSidebar() {
    var w = window.innerWidth, pref = store.get('cocoffee.sidebar');
    return (w < 1024 || (pref ? pref === 'collapsed' : w < 1280)) ? 'collapsed' : 'expanded';
  }
  function applyResponsive() {
    var w = window.innerWidth;
    html.setAttribute('data-device', w < 768 ? 'phone' : (w < 1024 ? 'tablet' : 'desktop'));
    html.setAttribute('data-sb', effectiveSidebar());
    html.setAttribute('data-pointer', window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine');
    if (w >= 768 && drawerOpen()) setDrawer(false);
    syncCollapseButton();
  }
  function setCollapsed(collapsed) {
    store.set('cocoffee.sidebar', collapsed ? 'collapsed' : 'expanded');
    applyResponsive();
  }
  // While the drawer is open the page behind it (and the bottom bar) is inert: no focus, no taps, no screen-reader reach.
  function setBackgroundInert(on) {
    [sidebar && sidebar.nextElementSibling, $('nav[aria-label="Điều hướng nhanh"]')].forEach(function (el) {
      if (!el) return;
      if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    });
  }
  function setDrawer(open, trigger) {
    if (!sidebar) return;
    sidebar.setAttribute('data-open', String(open));
    if (overlay) overlay.hidden = !open;
    $$('[data-sidebar-toggle][aria-controls]').forEach(function (b) { b.setAttribute('aria-expanded', String(open)); });
    setBackgroundInert(open);
    if (open) {
      drawerTrigger = trigger || drawerTrigger;
      var first = $('nav a', sidebar);
      if (first) first.focus();
    } else if (drawerTrigger) {
      drawerTrigger.focus();
      drawerTrigger = null;
    }
  }
  var drawerOpen = function () { return sidebar && sidebar.getAttribute('data-open') === 'true'; };

  // swipe left on the open drawer to close it
  if (sidebar) {
    var sx = null, sy = null;
    sidebar.addEventListener('touchstart', function (e) {
      if (!drawerOpen()) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    sidebar.addEventListener('touchend', function (e) {
      if (sx === null) return;
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      sx = sy = null;
      if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.5) setDrawer(false);
    }, { passive: true });
  }

  var rafId = 0;
  ['resize', 'orientationchange'].forEach(function (ev) {
    window.addEventListener(ev, function () { window.cancelAnimationFrame(rafId); rafId = window.requestAnimationFrame(applyResponsive); });
  });
  if (window.matchMedia) {
    var coarse = window.matchMedia('(pointer: coarse)');
    if (coarse.addEventListener) coarse.addEventListener('change', applyResponsive);   // e.g. keyboard/mouse attached to a tablet
  }
  applyResponsive();

  /* -------------------------------------------------------------- dropdowns */
  function closeDropdowns(except) {
    $$('[data-dropdown]').forEach(function (btn) {
      var panel = $(btn.getAttribute('data-dropdown'));
      if (!panel || panel === except) return;
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  /* ------------------------------------------------------------------- tabs */
  function selectTab(tab, focus) {
    var list = tab.closest('[role="tablist"]');
    $$('[role="tab"]', list).forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      var panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
    if (window.history && history.replaceState) history.replaceState(null, '', '#' + tab.id);
  }

  /* ---------------------------------------------------------------- filter */
  // the page-level search box of the tab panel that is currently shown (panels toggle via [hidden])
  function visibleFilterInput() {
    return $$('[data-filter-input]').filter(function (i) { return i.offsetParent !== null; })[0] || null;
  }
  function applyFilter(query) {
    var q = norm(query).trim();
    $$('[data-filterable]').forEach(function (table) {
      var shown = 0;
      var rows = $$('tbody tr[data-row]', table);
      rows.forEach(function (tr) {
        if (tr._s === undefined) tr._s = norm($$('td:not(.rt-actions)', tr).map(function (td) { return td.textContent; }).join(' '));   // action labels ("Sửa") are not searchable
        var hit = !q || tr._s.indexOf(q) !== -1;
        tr.hidden = !hit;
        if (hit) shown += 1;
      });
      var empty = $('[data-empty]', table);
      if (empty) empty.hidden = shown !== 0;
      var panel = table.closest('[role="tabpanel"]');
      if (panel) {
        $$('[data-count]', panel).forEach(function (n) { n.textContent = String(shown); });
        $$('[data-total]', panel).forEach(function (n) { n.textContent = String(rows.length); });
        var tabBtn = document.getElementById(panel.getAttribute('aria-labelledby'));
        var badge = tabBtn && $('[data-tab-count]', tabBtn); if (badge) badge.textContent = String(rows.length);
      }
    });
  }

  /* ------------------------------------------------------- recipe dialog */
  var catalogEl = $('#recipe-catalog');
  var catalog = null;
  try { catalog = catalogEl ? JSON.parse(catalogEl.textContent) : null; } catch (e) { catalog = null; }
  var recipeDlg = $('#recipe-dialog');

  // Inactive items are offered only to the line that already uses one, so editing never drops it silently.
  function lineOptions(select, kind, keepRef) {
    (catalog && catalog[kind] || []).forEach(function (item) {
      if (item.active === false && String(item.id) !== String(keepRef)) return;
      var opt = document.createElement('option');
      opt.value = String(item.id);
      opt.textContent = item.active === false ? item.name + ' (ngưng dùng)' : item.name;
      opt.setAttribute('data-cost', String(item.unitCost));
      opt.setAttribute('data-unit', item.unit);
      select.appendChild(opt);
    });
  }
  function addLine(line) {
    var tpl = $('#recipe-line-tpl');
    if (!tpl || !recipeDlg) return;
    var node = tpl.content.firstElementChild.cloneNode(true);
    var select = $('[data-line-ref]', node);
    lineOptions(select, recipeDlg.getAttribute('data-kind'), line && line.ref);
    if (line && line.ref != null) select.value = String(line.ref);
    $('[data-line-qty]', node).value = line && line.qty != null ? String(line.qty) : '';
    $('#recipe-lines').appendChild(node);
    recalc();
  }
  function recalc() {
    if (!recipeDlg) return;
    var cogs = 0;
    $$('[data-line]', recipeDlg).forEach(function (row) {
      var opt = $('[data-line-ref]', row).selectedOptions[0];
      var qty = parseFloat($('[data-line-qty]', row).value) || 0;
      var cost = (opt ? parseFloat(opt.getAttribute('data-cost')) || 0 : 0) * qty;
      $('[data-line-unit]', row).textContent = opt ? opt.getAttribute('data-unit') : '';
      $('[data-line-cost]', row).textContent = fmtMoney(cost);
      cogs += cost;
    });
    var price = parseFloat($('#f-price').value) || 0;
    var margin = $('[data-margin]', recipeDlg);
    $('[data-cogs]', recipeDlg).textContent = fmtMoney(cogs);
    $('[data-profit]', recipeDlg).textContent = price > 0 ? fmtMoney(price - cogs) : '—';
    if (price > 0) {
      var m = ((price - cogs) / price) * 100;
      margin.textContent = fmtPct(m);
      margin.className = 'mt-1 font-mono text-base font-semibold tnum ' + (m >= 65 ? 'text-green-700' : m >= 55 ? 'text-amber-700' : 'text-red-700');
    } else {
      margin.textContent = '—';
      margin.className = 'mt-1 font-mono text-base font-semibold tnum';
    }
  }
  function openRecipe(mode, recipe) {
    if (!recipeDlg) return;
    var kind = 'drink';
    recipeDlg.setAttribute('data-kind', kind);
    $('#recipe-form').setAttribute('action', '/admin/bom-recipes' + (mode === 'edit' && recipe ? '/' + encodeURIComponent(recipe.id) : ''));
    $('#recipe-title').textContent = mode === 'edit' ? 'Sửa công thức' : 'Thêm công thức';
    $('#f-name').value = recipe ? recipe.name : '';
    $('#f-sku').value = recipe ? recipe.sku : '';
    $('#f-sku').readOnly = mode === 'edit';
    $('#f-price').value = recipe ? recipe.price : '';
    var cat = $('#f-category');
    if (cat) cat.value = recipe && recipe.category_id != null ? String(recipe.category_id) : (cat.options[0] ? cat.options[0].value : '');
    $$('[data-image-field]', recipeDlg).forEach(function (f) { setImageField(f, recipe && recipe.image_url ? recipe.image_url : ''); });
    $('#recipe-lines').textContent = '';
    (recipe && recipe.lines.length ? recipe.lines : [{}]).forEach(addLine);
    recalc();
    recipeDlg.showModal();
    $('#f-name').focus();
  }

  /* ------------------------------------------------------------- photo fields */
  // [data-image-field] (views/partials/image_field.ejs): the picked picture is centre-cropped to a square,
  // scaled to 400px and re-encoded as JPEG here, then posted as a data URL in image_data (no multipart upload).
  var IMG_SIZE = 400;
  function showImage(field, src) {
    var img = $('[data-image-preview]', field);
    var empty = $('[data-image-empty]', field);
    var clear = $('[data-image-clear]', field);
    if (src) img.src = src; else img.removeAttribute('src');
    img.classList.toggle('hidden', !src);
    empty.classList.toggle('hidden', !!src);
    clear.classList.toggle('hidden', !src);
    clear.classList.toggle('inline-flex', !!src);
    $('[data-image-pick-label]', field).textContent = src ? 'Đổi ảnh' : 'Chọn ảnh';
  }
  function setImageField(field, url) {
    $('[name="image_data"]', field).value = '';
    $('[name="image_remove"]', field).value = '';
    $('[data-image-current]', field).value = url || '';
    var file = $('[data-image-file]', field); if (file) file.value = '';
    var hint = $('[data-image-hint]', field);   // back to the default help text after a previous pick
    if (hint) { if (!hint.hasAttribute('data-default')) hint.setAttribute('data-default', hint.textContent); hint.textContent = hint.getAttribute('data-default'); }
    showImage(field, url || '');
  }
  function compressImage(file, done) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { done(new Error('Chỉ nhận ảnh JPEG, PNG hoặc WebP.')); return; }
    if (file.size > 15 * 1024 * 1024) { done(new Error('Ảnh quá lớn (tối đa 15 MB trước khi nén).')); return; }
    // Read as a data: URL, not URL.createObjectURL: the admin CSP allows img-src 'self' data: only (no blob:).
    var reader = new FileReader();
    var img = new Image();
    reader.onload = function () { img.src = reader.result; };
    reader.onerror = function () { done(new Error('Không đọc được ảnh này.')); };
    img.onload = function () {
      var side = Math.min(img.naturalWidth, img.naturalHeight);
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = Math.min(IMG_SIZE, side);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);   // transparent PNG -> white, not black
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
      var q = 0.85, data = canvas.toDataURL('image/jpeg', q);
      while (data.length > 750000 && q > 0.4) { q -= 0.1; data = canvas.toDataURL('image/jpeg', q); }
      done(null, data);
    };
    img.onerror = function () { done(new Error('Không đọc được ảnh này.')); };
    reader.readAsDataURL(file);
  }

  /* ------------------------------------------- generic dialogs + confirmation */
  // <button data-modal-open="#dlg" data-action="/url" data-title="..." data-fill='{"name":"x"}'> opens a form dialog:
  // the form is reset, its action/title are set, and fields are filled by name (checkbox pairs: hidden "0" + checkbox "1").
  function prepareDialog(dlg, trigger) {
    var form = $('form', dlg);
    if (form && form.reset) form.reset();
    var action = trigger.getAttribute('data-action');
    if (form && action) form.setAttribute('action', action);
    var title = trigger.getAttribute('data-title');
    var heading = $('[data-dialog-title]', dlg);
    if (title && heading) heading.textContent = title;
    var raw = trigger.getAttribute('data-fill');
    if (form) $$('[data-create-only]', form).forEach(function (el) { el.readOnly = !!raw; });   // identifiers are fixed once created
    if (form) $$('[data-new-only]', form).forEach(function (el) { el.style.display = raw ? 'none' : ''; });   // opening balance exists only when creating
    if (form) $$('[data-image-field]', form).forEach(function (f) { setImageField(f, ''); });
    if (!form || !raw) return;
    var data = {};
    try { data = JSON.parse(raw) || {}; } catch (err) { data = {}; }
    Object.keys(data).forEach(function (name) {
      var group = $$('[name="' + name + '"]', form);
      var hasCheckbox = group.some(function (el) { return el.type === 'checkbox'; });
      var value = data[name];
      group.forEach(function (el) {
        if (el.type === 'checkbox') el.checked = value === true || value === 1 || value === '1';
        else if (el.type === 'hidden' && hasCheckbox) { /* the "0" companion of a checkbox */ }
        else el.value = value == null ? '' : String(value);
      });
    });
    $$('[data-image-field]', form).forEach(function (f) { setImageField(f, data.image_url || ''); });
  }
  var pendingConfirm = null;

  /* ------------------------------------------------------------------ clicks */
  document.addEventListener('click', function (e) {
    var t = e.target;
    var el;

    if ((el = t.closest('[data-image-clear]'))) {
      var imgField = el.closest('[data-image-field]');
      $('[name="image_data"]', imgField).value = '';
      $('[name="image_remove"]', imgField).value = $('[data-image-current]', imgField).value ? '1' : '';
      var fileInput = $('[data-image-file]', imgField); if (fileInput) fileInput.value = '';
      showImage(imgField, '');
      return;
    }
    if ((el = t.closest('[data-sidebar-collapse]'))) { setCollapsed(html.getAttribute('data-sb') !== 'collapsed'); return; }
    if ((el = t.closest('[data-sidebar-toggle]'))) { setDrawer(!drawerOpen(), el); return; }
    if (t.closest('[data-sidebar-overlay]')) { setDrawer(false); return; }
    if (drawerOpen() && t.closest('#sidebar a')) { setDrawer(false); }

    if ((el = t.closest('[data-dropdown]'))) {
      var panel = $(el.getAttribute('data-dropdown'));
      var willOpen = panel.hidden;
      closeDropdowns();
      panel.hidden = !willOpen;
      el.setAttribute('aria-expanded', String(willOpen));
      return;
    }
    if (!t.closest('[data-dropdown], #notif-panel')) closeDropdowns();

    if ((el = t.closest('[role="tab"]'))) { selectTab(el, false); return; }

    if ((el = t.closest('[data-recipe-open]'))) {
      var mode = el.getAttribute('data-recipe-open');
      var data = null;
      try { data = mode === 'edit' ? JSON.parse(el.getAttribute('data-recipe')) : null; } catch (err) { data = null; }
      openRecipe(mode, data);
      return;
    }
    if ((el = t.closest('[data-modal-open]'))) {
      var dlg = $(el.getAttribute('data-modal-open'));
      if (dlg) {
        prepareDialog(dlg, el);
        dlg.showModal();
        var firstField = $('input:not([type="hidden"]):not([readonly]), select, textarea', dlg);
        if (firstField && firstField.focus) firstField.focus();
      }
      return;
    }
    if ((el = t.closest('[data-modal-close]'))) { var d = el.closest('dialog'); if (d) d.close(); return; }

    if (t.matches('dialog')) {                      // click on the backdrop (the dialog fills its own box)
      var r = t.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) t.close();
      return;
    }

    if ((el = t.closest('[data-line-add]'))) { addLine(); return; }
    if ((el = t.closest('[data-line-remove]'))) {
      var rows = $$('[data-line]', recipeDlg);
      if (rows.length > 1) { el.closest('[data-line]').remove(); recalc(); } else toast('Cần ít nhất một dòng.', 'warn');
      return;
    }

    if (t.closest('[data-confirm-ok]')) {
      var form = pendingConfirm;
      pendingConfirm = null;
      $('#confirm-dialog').close();
      if (form) { form._confirmed = true; if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
    }
  });

  /* ------------------------------------------------------------------- input */
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.matches('#quick-search')) {
      var local = visibleFilterInput();
      if (local) local.value = t.value;
      applyFilter(t.value);
      return;
    }
    if (t.matches('[data-filter-input]')) {
      var qs = $('#quick-search'); if (qs) qs.value = t.value;
      applyFilter(t.value);
      return;
    }
    if (recipeDlg && recipeDlg.contains(t) && t.matches('[data-line-qty], #f-price')) recalc();
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('[data-image-file]') && t.files && t.files[0]) {
      var field = t.closest('[data-image-field]');
      var hint = $('[data-image-hint]', field);
      compressImage(t.files[0], function (err, data) {
        if (err) { toast(err.message, 'error'); t.value = ''; return; }
        $('[name="image_data"]', field).value = data;
        $('[name="image_remove"]', field).value = '';
        showImage(field, data);
        if (hint) hint.textContent = 'Ảnh mới sẽ được lưu khi bấm Lưu (' + Math.round(data.length * 0.75 / 1024) + ' KB).';
      });
      return;
    }
    if (recipeDlg && recipeDlg.contains(t) && t.matches('[data-line-ref]')) recalc();
  });

  /* ------------------------------------------------------------------ submits */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.matches('[data-no-submit]')) { e.preventDefault(); return; }
    if (form.id === 'recipe-form') {
      if (!form.reportValidity()) { e.preventDefault(); return; }
      var lines = $$('[data-line]', recipeDlg).map(function (row) {
        return { inventory_item_id: parseInt($('[data-line-ref]', row).value, 10), quantity: parseFloat($('[data-line-qty]', row).value) };
      }).filter(function (l) { return l.inventory_item_id > 0 && l.quantity > 0; });
      if (!lines.length) { e.preventDefault(); toast('Cần ít nhất một nguyên liệu có định lượng.', 'warn'); return; }
      $('#f-recipe').value = JSON.stringify(lines);       // validated again (and merged) on the server
      lockSubmit(form, e);                                 // let the browser POST it (once)
      return;
    }
    if (form.hasAttribute('data-confirm') && !form._confirmed) {
      e.preventDefault();
      pendingConfirm = form;
      $('[data-confirm-text]').textContent = form.getAttribute('data-confirm');
      $('#confirm-dialog').showModal();
      return;
    }
    form._confirmed = false;
    lockSubmit(form, e);
  });

  // A double-click (or Enter twice) must not POST twice: e.g. the same stock receipt booked two times.
  function lockSubmit(form, e) {
    if ((form.method || '').toLowerCase() !== 'post') return;
    if (form._submitting) { e.preventDefault(); return; }
    form._submitting = true;
    setTimeout(function () { $('button[type="submit"], button:not([type])', form).forEach(function (b) { b.disabled = true; b.setAttribute('aria-busy', 'true'); }); }, 0);
  }
  // Back/forward cache restores the page with the form still locked.
  window.addEventListener('pageshow', function (ev) {
    if (!ev.persisted) return;
    $('form').forEach(function (f) { f._submitting = false; $('button[aria-busy="true"]', f).forEach(function (b) { b.disabled = false; b.removeAttribute('aria-busy'); }); });
  });

  /* --------------------------------------------------------------- keyboard */
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      var qs = $('#quick-search');
      if (qs && qs.offsetParent !== null) { e.preventDefault(); qs.focus(); qs.select(); }
      return;
    }
    if (e.key === 'Escape') {
      if (drawerOpen()) setDrawer(false);
      var open = $$('[data-dropdown]').filter(function (b) { return b.getAttribute('aria-expanded') === 'true'; })[0];
      if (open) { closeDropdowns(); open.focus(); }
      return;
    }
    var tab = e.target.closest && e.target.closest('[role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) !== -1) {
      var tabs = $$('[role="tab"]', tab.closest('[role="tablist"]'));
      var i = tabs.indexOf(tab);
      if (e.key === 'ArrowRight') i = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') i = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') i = 0;
      else i = tabs.length - 1;
      e.preventDefault();
      selectTab(tabs[i], true);
    }
  });

  /* ------------------------------------------------------------------- boot */
  var hashTab = null;
  try { if (window.location.hash.length > 1) hashTab = document.getElementById(decodeURIComponent(window.location.hash.slice(1))); } catch (e) { hashTab = null; /* malformed %-escape */ }
  if (hashTab && hashTab.getAttribute('role') === 'tab') selectTab(hashTab, false);
})();
