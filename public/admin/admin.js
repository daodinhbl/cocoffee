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
        if (tr._s === undefined) tr._s = norm(tr.textContent);
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

  function currentKind() {
    var tab = $('[role="tab"][aria-selected="true"]');
    return (tab && tab.getAttribute('data-kind')) || 'drink';
  }
  function lineOptions(select, kind) {
    (catalog && catalog[kind] || []).forEach(function (item) {
      var opt = document.createElement('option');
      opt.value = String(item.id);
      opt.textContent = item.name;
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
    lineOptions(select, recipeDlg.getAttribute('data-kind'));
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
    var kind = recipe ? recipe.kind : currentKind();
    recipeDlg.setAttribute('data-kind', kind);
    $('#recipe-title').textContent = (mode === 'edit' ? 'Sửa' : 'Thêm') + (kind === 'combo' ? ' combo' : ' công thức');
    $('[data-lines-title]', recipeDlg).textContent = kind === 'combo' ? 'Món trong combo' : 'Nguyên liệu';
    $('#f-name').value = recipe ? recipe.name : '';
    $('#f-sku').value = recipe ? recipe.sku : '';
    $('#f-price').value = recipe ? recipe.price : '';
    $('#recipe-lines').textContent = '';
    (recipe && recipe.lines.length ? recipe.lines : [{}]).forEach(addLine);
    recalc();
    recipeDlg.showModal();
    $('#f-name').focus();
  }

  /* ---------------------------------------------------------- delete dialog */
  var pendingRow = null;

  /* ------------------------------------------------------------------ clicks */
  document.addEventListener('click', function (e) {
    var t = e.target;
    var el;

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
      if (dlg) dlg.showModal();
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

    if ((el = t.closest('[data-delete]'))) {
      pendingRow = el.closest('tr');
      $('[data-delete-name]').textContent = el.getAttribute('data-name');
      $('#delete-dialog').showModal();
      return;
    }
    if (t.closest('[data-delete-confirm]')) {
      if (pendingRow) { pendingRow.remove(); pendingRow = null; var fi = visibleFilterInput(); applyFilter(fi ? fi.value : ''); }
      $('#delete-dialog').close();
      toast('Đã xóa công thức (bản demo, chưa ghi vào CSDL).', 'success');
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
    if (recipeDlg && recipeDlg.contains(t) && t.matches('[data-line-ref]')) recalc();
    if (t.matches('#import-file')) {
      var f = t.files && t.files[0];
      $('[data-file-name]').textContent = f ? f.name : 'Chọn file .xlsx / .csv';
      $('[data-import-submit]').disabled = !f;
    }
  });

  /* ------------------------------------------------------------------ submits */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.matches('[data-no-submit]')) { e.preventDefault(); return; }
    if (form.id === 'recipe-form') {
      e.preventDefault();
      if (!form.reportValidity()) return;
      recipeDlg.close();
      toast('Đã ghi nhận công thức (bản demo, chưa ghi vào CSDL).', 'success');
    }
    if (form.id === 'import-form') {
      e.preventDefault();
      $('#import-dialog').close();
      toast('Đã nhận file Excel (bản demo, chưa xử lý).', 'success');
      $('#import-file').value = '';
      $('[data-file-name]').textContent = 'Chọn file .xlsx / .csv';
      $('[data-import-submit]').disabled = true;
    }
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
