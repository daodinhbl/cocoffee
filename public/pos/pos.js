/**
 * CoCoffee POS front-office (tablet at the counter). Vanilla JS, no framework.
 * Data comes from <script id="pos-data"> (rendered by controllers/admin/pos.js). The cart lives here;
 * checkout / hold send it to /admin/pos/* where orderService re-prices it from the database, deducts
 * stock (BOM) and records the payment. Prices shown here are for display only.
 */
(function () {
  'use strict';

  var DATA = JSON.parse(document.getElementById('pos-data').textContent);
  var PRINTER = DATA.printer || { autoPrint: true, vatRate: 8 };
  var VAT_RATE = (PRINTER.vatRate || 0) / 100;   // prices include VAT; shown as "of which VAT" (0 = hidden)
  var ICON_TABLE = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="10" y="17" width="28" height="14" rx="3"/><path d="M15 31v8M33 31v8"/><rect x="4" y="21" width="5" height="9" rx="2"/><rect x="39" y="21" width="5" height="9" rx="2"/><path d="M17 12h14"/></svg>';
  var ICON_TAKEAWAY = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" aria-hidden="true"><path d="M10 16h28l-2.5 26h-23L10 16z"/><path d="M18 16v-3a6 6 0 0 1 12 0v3"/><path d="M17 26c2 3 5 4.5 7 4.5s5-1.5 7-4.5"/></svg>';

  var state = { tableId: null, lastPaid: null, cat: 'all', q: '', cart: [], discount: 0, note: '', method: 'cash', given: 0, orderId: null, orderCode: null, busy: false,
    prepaid: 0, orderItems: [], merged: [], dirty: false, pmethod: 'cash', mergePick: null, split: { qty: {}, target: null } };

  /* ------------------------------------------------------------------ helpers */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var fmt = function (n) { return Math.round(n).toLocaleString('vi-VN') + 'đ'; };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var norm = function (s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase(); };
  var show = function (el, on) { el.classList.toggle('hidden', !on); };   // class, never [hidden]: .flex would win
  var products = {};
  DATA.products.forEach(function (p) { products[p.id] = p; });

  // No product photos yet: pick an emoji from the name, then the category.
  var EMOJI = [[/thuoc|555|marlboro|jet/, '🚬'], [/bac xiu|sua tuoi|latte/, '🥛'], [/ca phe|coffee|espresso|americano|cappuccino/, '☕'], [/tra dao|dao/, '🍑'], [/tra vai|vai/, '🍹'],
    [/matcha|tra xanh/, '🍵'], [/\btra\b/, '🍵'], [/cacao|socola|chocolate/, '🍫'], [/\bbo\b/, '🥑'], [/xoai/, '🥭'], [/\bdau\b/, '🍓'],
    [/sinh to|smoothie/, '🥤'], [/banh|cake|croissant/, '🍰'], [/nuoc ngot|coca|pepsi|sting|7up/, '🥤'], [/nuoc|aqua|lavie|suoi/, '💧'],
    [/\bbia\b|beer/, '🍺']];
  function emojiOf(p) {
    var n = norm(p.name);
    for (var i = 0; i < EMOJI.length; i++) if (EMOJI[i][0].test(n)) return EMOJI[i][1];
    return '☕';
  }

  function totals() {
    var subtotal = state.cart.reduce(function (s, l) { return s + products[l.id].price * l.qty; }, 0);
    var discount = Math.min(state.discount, subtotal);
    var total = subtotal - discount;
    var due = Math.max(0, total - state.prepaid);   // what is still to collect after prepayments
    return { subtotal: subtotal, discount: discount, total: total, due: due, prepaid: state.prepaid, vat: total - total / (1 + VAT_RATE), count: state.cart.reduce(function (s, l) { return s + l.qty; }, 0) };
  }

  var toastTimer;
  function toast(msg, tone) {
    var el = $('#toast');
    el.innerHTML = '<div class="slidein max-w-[90vw] rounded-xl px-5 py-3 text-base font-semibold text-white shadow-xl ' +
      (tone === 'ok' ? 'bg-emerald-600' : tone === 'bad' ? 'bg-red-600' : 'bg-navy-darker') + '">' + esc(msg) + '</div>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.innerHTML = ''; }, tone === 'bad' ? 4000 : 2200);
  }

  /** POST JSON to the POS endpoints. Resolves to the JSON body; rejects with a readable message. */
  function post(url, body) {
    body._csrf = DATA.csrf;
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        var type = r.headers.get('content-type') || '';
        if (type.indexOf('application/json') === -1) throw new Error('Phiên đăng nhập đã hết hạn. Tải lại trang để đăng nhập lại.');
        return r.json().then(function (j) { if (!j.ok) throw new Error(j.message || 'Không thực hiện được.'); return j; });
      });
  }

  /* ------------------------------------------------------------------ left side */
  function renderCategories() {
    var cats = [{ id: 'all', name: 'Tất cả' }].concat(DATA.categories.filter(function (c) {
      return DATA.products.some(function (p) { return p.categoryId === c.id; });
    }));
    $('#categories').innerHTML = cats.map(function (c) {
      var on = String(c.id) === String(state.cat);
      return '<button type="button" role="tab" aria-selected="' + on + '" data-cat="' + c.id + '" class="flex h-12 shrink-0 items-center rounded-xl px-5 text-base font-semibold transition active:scale-95 ' +
        (on ? 'bg-navy text-white shadow-md' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:ring-navy-accent') + '">' + esc(c.name) + '</button>';
    }).join('');
  }

  function renderGrid() {
    var q = norm(state.q.trim());
    var list = DATA.products.filter(function (p) {
      return (state.cat === 'all' || String(p.categoryId) === String(state.cat)) && (!q || norm(p.name).indexOf(q) !== -1);
    });
    var inCart = {};
    state.cart.forEach(function (l) { inCart[l.id] = l.qty; });
    $('#grid').innerHTML = list.map(function (p) {
      var qty = inCart[p.id];
      var visual = p.image
        ? '<img src="' + esc(p.image) + '" alt="" loading="lazy" class="mx-auto mt-1 h-20 w-20 rounded-xl object-cover">'
        : '<span class="mx-auto mt-2 text-5xl" aria-hidden="true">' + emojiOf(p) + '</span>';
      return '<button type="button" data-add="' + p.id + '" class="relative flex min-h-[150px] flex-col items-start rounded-2xl bg-white p-4 text-left shadow-card ring-1 transition hover:-translate-y-0.5 active:scale-95 ' +
        (qty ? 'ring-2 ring-navy-accent' : 'ring-slate-100 hover:ring-navy-accent/40') + '">' +
        (qty ? '<span class="absolute right-3 top-3 flex h-7 min-w-[28px] items-center justify-center rounded-full bg-navy-accent px-2 text-sm font-bold text-white tnum">' + qty + '</span>' : '') +
        visual +
        '<span class="mt-auto w-full pt-3"><span class="block truncate text-base font-bold text-dark">' + esc(p.name) + '</span>' +
        '<span class="mt-0.5 block text-lg font-bold text-navy tnum">' + fmt(p.price) + '</span></span></button>';
    }).join('');
    show($('#empty-grid'), list.length === 0);
  }

  /* ------------------------------------------------------------------ right side */
  function currentTable() {
    return DATA.tables.filter(function (t) { return String(t.id) === String(state.tableId); })[0] || null;
  }

  /** The picker button in the order header + the floor grid in the dialog. */
  function renderTables() {
    var cur = currentTable();
    $('#table-icon').innerHTML = '<span class="block h-8 w-8">' + (cur ? ICON_TABLE : ICON_TAKEAWAY) + '</span>';
    $('#table-icon').className = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ' + (cur ? (cur.busy ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600') : 'bg-amber-50 text-amber-600');
    $('#table-name').textContent = cur ? (cur.name || cur.code) : 'Mang đi';
    $('#table-sub').textContent = cur ? (cur.busy ? 'Đang phục vụ' + (state.orderCode ? ' · ' + state.orderCode : '') : 'Bàn trống') : 'Khách mang đi · chạm để chọn bàn';

    var tile = function (o) {
      return '<button type="button" role="menuitem" data-table="' + o.value + '" aria-pressed="' + o.on + '" class="relative flex ' + (o.wide ? 'h-16 w-full flex-row justify-start gap-3 px-4 text-left' : 'h-24 flex-col justify-center gap-0.5 p-2 text-center') + ' items-center rounded-xl border-2 transition active:scale-95 ' + o.cls + (o.on ? ' border-navy-accent ring-4 ring-navy-accent/30' : '') + '">' +
        '<span class="block ' + (o.wide ? 'h-9 w-9' : 'h-9 w-9') + ' shrink-0">' + o.icon + '</span>' +
        '<span class="block min-w-0"><span class="block truncate text-base font-bold leading-tight">' + esc(o.name) + '</span>' +
        '<span class="block truncate text-xs">' + o.sub + '</span></span>' +
        (o.on ? '<span class="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-navy-accent text-xs font-bold text-white">✓</span>' : '') + '</button>';
    };
    $('#table-fixed').innerHTML = tile({ value: '', on: !cur, wide: true, icon: ICON_TAKEAWAY, name: 'Mang đi', sub: 'Không dùng bàn', cls: 'border-amber-300 bg-amber-50 text-amber-700 hover:border-amber-400' });
    $('#table-grid').innerHTML =
      DATA.tables.map(function (t) {
        return tile({
          value: t.id, on: !!cur && cur.id === t.id, icon: ICON_TABLE, name: t.name || t.code,
          sub: t.mergedInto ? 'Ghép · ' + esc(t.mergedIntoName || '') : (t.busy ? 'Đang phục vụ' : 'Trống'),
          cls: t.mergedInto ? 'border-amber-300 bg-amber-50 text-amber-700 hover:border-amber-400' : t.busy ? 'border-red-200 bg-red-50 text-red-700 hover:border-red-400' : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-400',
        });
      }).join('');
  }

  function toggleTableMenu(open) {
    var m = $('#table-menu');
    var on = open === undefined ? m.classList.contains('hidden') : open;
    show(m, on);
    $('#table-btn').setAttribute('aria-expanded', String(on));
    $('#table-caret').style.transform = on ? 'rotate(180deg)' : '';
    if (on) renderTables();
  }

  function renderCart(bumpId) {
    $('#cart').innerHTML = state.cart.map(function (l) {
      var p = products[l.id];
      return '<li class="rounded-xl border border-slate-100 bg-white p-3 ' + (l.id === bumpId ? 'pop' : '') + '">' +
        '<div class="flex items-center gap-3"><span class="text-2xl" aria-hidden="true">' + emojiOf(p) + '</span>' +
          '<span class="min-w-0 flex-1"><span class="block truncate text-base font-bold text-dark">' + esc(p.name) + '</span>' +
          '<span class="block text-sm text-slate-500 tnum">' + fmt(p.price) + ' / món</span></span>' +
          '<button type="button" data-del="' + l.id + '" aria-label="Xóa ' + esc(p.name) + '" class="-mr-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-600 active:scale-90">' +
          '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>' +
        '<div class="mt-2 flex items-center justify-between"><span class="flex items-center rounded-xl bg-slate-100">' +
          '<button type="button" data-dec="' + l.id + '" aria-label="Giảm ' + esc(p.name) + '" class="flex h-12 w-12 items-center justify-center rounded-xl text-2xl font-bold text-navy hover:bg-slate-200 active:scale-90">−</button>' +
          '<span class="w-10 text-center text-xl font-bold tnum">' + l.qty + '</span>' +
          '<button type="button" data-inc="' + l.id + '" aria-label="Tăng ' + esc(p.name) + '" class="flex h-12 w-12 items-center justify-center rounded-xl text-2xl font-bold text-navy hover:bg-slate-200 active:scale-90">+</button>' +
        '</span><span class="text-xl font-bold text-navy-darker tnum">' + fmt(p.price * l.qty) + '</span></div></li>';
    }).join('');
    show($('#cart-empty'), state.cart.length === 0);

    var t = totals();
    $('#subtotal').textContent = fmt(t.subtotal);
    $('#discount').textContent = t.discount ? '−' + fmt(t.discount) : '0đ';
    $('#tax').textContent = fmt(t.vat);
    show($('#tax-row'), VAT_RATE > 0);
    $('#total').textContent = fmt(t.due);
    $('#total-label').textContent = t.prepaid ? 'Còn phải thu' : 'Tổng thanh toán';
    $('#prepaid').textContent = '−' + fmt(t.prepaid);
    var pr = $('#prepaid-row'); show(pr, t.prepaid > 0); pr.classList.toggle('flex', t.prepaid > 0);
    $('#btn-pay').disabled = t.count === 0 || state.busy;
    $('#btn-prepay').disabled = t.count === 0 || state.busy;
    $('#btn-merge').disabled = state.busy || !state.tableId;
    $('#btn-split').disabled = state.busy || !state.orderId;
    $('#btn-hold').disabled = t.count === 0 || state.busy;
    $('#btn-reprint').disabled = !state.lastPaid;
    $('#order-code').textContent = (state.orderCode || 'Đơn mới') + (t.count ? ' · ' + t.count + ' món' : '');
  }

  function renderZalo() {
    $('#zalo-count').textContent = DATA.drafts.length;
    show($('#zalo-banner'), DATA.drafts.length > 0);
    $('#zalo-banner').classList.toggle('flex', DATA.drafts.length > 0);
    $('#zalo-list').innerHTML = DATA.drafts.map(function (d) {
      return '<li class="flex items-center justify-between rounded-xl border border-slate-200 p-4">' +
        '<span><span class="block text-base font-bold">' + esc(d.code || 'Đơn nháp') + '</span>' +
        '<span class="block text-sm text-slate-500">' + (d.chatType === 'group' ? 'Nhóm Zalo' : 'Chat riêng') + (d.at ? ' · ' + new Date(d.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '') + '</span></span>' +
        '<span class="text-lg font-bold text-navy tnum">' + fmt(d.total) + '</span></li>';
    }).join('') || '<li class="text-slate-500">Không có đơn nào.</li>';
  }

  /* ------------------------------------------------------------------ cart actions */
  function add(id, qty) {
    if (!products[id]) return;
    var line = state.cart.filter(function (l) { return l.id === id; })[0];
    if (line) line.qty = Math.min(99, line.qty + (qty || 1));
    else state.cart.push({ id: id, qty: qty || 1 });
    state.dirty = true;
    renderCart(id); renderGrid();
  }
  function change(id, delta) {
    state.cart = state.cart.map(function (l) { return l.id === id ? { id: l.id, qty: Math.min(99, l.qty + delta) } : l; })
                           .filter(function (l) { return l.qty > 0; });
    state.dirty = true;
    renderCart(delta > 0 ? id : null); renderGrid();
  }
  function remove(id) { state.cart = state.cart.filter(function (l) { return l.id !== id; }); state.dirty = true; renderCart(); renderGrid(); }

  function resetOrder() {
    state.cart = []; state.discount = 0; state.note = ''; state.orderId = null; state.orderCode = null;
    state.prepaid = 0; state.orderItems = []; state.merged = []; state.dirty = false;
    $('#note-label').textContent = 'Ghi chú';
    renderCart(); renderGrid();
  }

  /** Loads the open order into the cart (items, prepayment, merged tables). */
  function loadOrder(orderId, label) {
    state.busy = true; renderCart();
    return fetch('/admin/pos/orders/' + orderId, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.message);
        state.cart = j.order.items.filter(function (i) { return products[i.productId]; }).map(function (i) { return { id: i.productId, qty: i.qty }; });
        state.orderId = j.order.id; state.orderCode = j.order.code; state.note = j.order.note || '';
        state.prepaid = j.order.prepaid || 0; state.orderItems = j.order.items; state.merged = j.order.merged || []; state.dirty = false;
        if (j.order.tableId) state.tableId = j.order.tableId;     // a merged table opens its group's primary table
        $('#note-label').textContent = state.note ? 'Có ghi chú' : 'Ghi chú';
        if (label) toast('Đã mở đơn ' + j.order.code + ' của ' + label);
      })
      .catch(function (e) { toast(e.message || 'Không mở được đơn của bàn.', 'bad'); })
      .then(function () { state.busy = false; renderCart(); renderGrid(); renderTables(); });
  }

  /** Picking a busy table loads its open order, so items are added to it and paid together. */
  function selectTable(value) {
    state.tableId = value ? Number(value) : null;
    toggleTableMenu(false);
    var t = currentTable();
    if (!t || !t.busy || !t.orderId) {
      if (state.orderId) resetOrder(); else renderCart();
      renderTables();
      return;
    }
    loadOrder(t.orderId, t.name || t.code);
  }

  function payload(extra) {
    var body = {
      table_id: state.orderId ? null : state.tableId,
      order_id: state.orderId,
      items: state.cart.map(function (l) { return { product_id: l.id, quantity: l.qty }; }),
      note: state.note,
    };
    for (var k in extra) body[k] = extra[k];
    return body;
  }

  function markTable(id, busy, orderId) {
    DATA.tables.forEach(function (t) {
      if (String(t.id) === String(id)) { t.busy = busy; t.orderId = orderId || null; }
      else if (!busy && String(t.mergedInto) === String(id)) { t.busy = false; t.orderId = null; t.mergedInto = null; }   // merged tables are freed with their primary
    });
    renderTables();
  }

  function hold() {
    if (state.busy || !state.cart.length) return;
    var tableId = state.tableId;
    state.busy = true; renderCart();
    post('/admin/pos/hold', payload({}))
      .then(function (j) {
        if (tableId) markTable(tableId, true, j.order.id);
        DATA.temps = j.temps || DATA.temps; renderTemps();
        toast(j.message, 'ok');
        state.tableId = null; resetOrder(); renderTables();
      })
      .catch(function (e) { toast(e.message, 'bad'); })
      .then(function () { state.busy = false; renderCart(); });
  }

  /* ------------------------------------------------------------------ saved orders without a table (đơn tạm) */
  function renderTemps() {
    $('#temp-count').textContent = DATA.temps.length;
    $('#temp-list').innerHTML = DATA.temps.map(function (o) {
      return '<li class="flex items-center gap-3 rounded-xl border border-slate-200 p-3"><span class="min-w-0 flex-1"><span class="block text-base font-bold">' + esc(o.code) + '</span>' +
        '<span class="block truncate text-sm text-slate-500">' + o.count + ' món' + (o.at ? ' · ' + new Date(o.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '') + (o.note ? ' · ' + esc(o.note) : '') + '</span></span>' +
        '<span class="text-lg font-bold text-navy tnum">' + fmt(o.total) + '</span>' +
        '<button type="button" data-temp-open="' + o.id + '" class="h-12 rounded-xl bg-navy px-4 text-base font-semibold text-white hover:bg-navy-accent">Mở</button>' +
        '<button type="button" data-temp-cancel="' + o.id + '" aria-label="Hủy đơn" class="flex h-12 w-12 items-center justify-center rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-600">🗑</button></li>';
    }).join('') || '<li class="py-6 text-center text-slate-500">Chưa có đơn tạm nào.</li>';
  }
  function openTemp(id) {
    if (state.busy) return;
    if (state.cart.length && state.dirty) { toast('Đơn hiện tại chưa lưu. Bấm “Lưu tạm” hoặc thanh toán trước khi mở đơn khác.', 'bad'); return; }
    $('#temp-dialog').close();
    state.tableId = null; renderTables();
    loadOrder(id, 'đơn tạm');
  }
  function cancelTemp(id) {
    if (state.busy || !window.confirm('Hủy đơn tạm này? Tiền trả trước (nếu có) sẽ được ghi hoàn lại.')) return;
    state.busy = true;
    post('/admin/pos/cancel', { order_id: id })
      .then(function (j) {
        DATA.tables = j.tables; DATA.temps = j.temps; toast(j.message, 'ok');
        if (state.orderId === id) { state.tableId = null; resetOrder(); }
        renderTemps(); renderTables();
      })
      .catch(function (e) { toast(e.message, 'bad'); })
      .then(function () { state.busy = false; renderCart(); });
  }

  /* ------------------------------------------------------------------ prompt dialog */
  function ask(title, value, type, cb) {
    var d = $('#prompt-dialog'), input = $('#prompt-input');
    $('#prompt-title').textContent = title;
    input.type = type || 'text'; input.value = value || '';
    if (type === 'number') { input.setAttribute('inputmode', 'numeric'); input.min = '0'; input.step = '1000'; } else { input.removeAttribute('inputmode'); }
    d.returnValue = '';
    d.onclose = function () { if (d.returnValue === 'ok') cb(input.value.trim()); };
    d.showModal();
    setTimeout(function () { input.focus(); input.select(); }, 30);
  }

  /* ------------------------------------------------------------------ payment */
  function openPay() {
    var t = totals();
    if (!t.count || state.busy) return;
    state.given = 0; $('#given-input').value = '';
    $('#pay-total').textContent = fmt(t.due);
    var cur = currentTable();
    $('#pay-sub').textContent = (cur ? (cur.name || cur.code) : 'Mang đi') + ' · ' + t.count + ' món' + (t.prepaid ? ' · đã trả trước ' + fmt(t.prepaid) : '');
    var opts = [t.due, Math.ceil(t.due / 50000) * 50000, Math.ceil(t.due / 100000) * 100000, Math.ceil(t.due / 100000) * 100000 + 100000, 500000]
      .filter(function (v, i, a) { return v >= t.due && a.indexOf(v) === i; }).slice(0, 4);
    $('#quick-cash').innerHTML = opts.map(function (v, i) {
      return '<button type="button" data-given="' + v + '" class="h-12 rounded-xl border border-slate-200 text-base font-bold tnum hover:border-navy-accent hover:text-navy-accent">' + (i === 0 ? 'Đủ tiền' : fmt(v)) + '</button>';
    }).join('');
    show($('#pay-error'), false);
    setMethod('cash');
    $('#pay-dialog').showModal();
  }
  function setMethod(m) {
    state.method = m;
    $$('.method').forEach(function (b) {
      var on = b.getAttribute('data-method') === m;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on));
      b.className = 'method h-14 rounded-xl border-2 text-lg font-bold transition ' + (on ? 'border-navy-accent bg-navy-50 text-navy' : 'border-slate-200 text-slate-600 hover:border-slate-300');
    });
    show($('#cash-box'), m === 'cash');
    show($('#transfer-box'), m === 'transfer');
    if (m === 'transfer') loadTransferQr();
    updateChange();
  }
  /** VietQR for what is still due: scanned by the customer's banking app, confirmed by the cashier. */
  var qrSeq = 0;
  function loadTransferQr() {
    var box = $('#transfer-qr'), t = totals(), seq = ++qrSeq;
    if (!t.due) { box.innerHTML = '<p class="text-base text-slate-500">Không còn khoản nào phải thu.</p>'; return; }
    box.innerHTML = '<p class="py-10 text-base text-slate-500">Đang tạo mã QR…</p>';
    var cur = currentTable();
    var memo = state.orderCode || ('POS ' + (cur ? (cur.name || cur.code) : 'mang di'));
    fetch('/admin/pos/transfer-qr?amount=' + Math.round(t.due) + '&memo=' + encodeURIComponent(memo), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (seq !== qrSeq) return;                                   // the method or the amount changed meanwhile
        if (!j.ok) throw new Error(j.message || 'Không tạo được mã QR.');
        box.innerHTML = '<div class="h-[260px] w-[260px] [&>svg]:h-full [&>svg]:w-full">' + j.svg + '</div>' +
          '<p class="mt-2 text-lg font-bold text-navy-darker">' + esc(j.bankName) + ' · <span class="tnum">' + esc(j.account) + '</span></p>' +
          (j.holder ? '<p class="text-base font-semibold text-slate-700">' + esc(j.holder) + '</p>' : '') +
          '<p class="text-sm text-slate-500">Số tiền <b class="tnum">' + fmt(j.amount) + '</b> · Nội dung <b>' + esc(j.memo) + '</b></p>' +
          '<p class="mt-1 text-sm text-slate-500">Khi tiền về tài khoản, bấm “Xác nhận thanh toán”.</p>';
      })
      .catch(function (e) { if (seq === qrSeq) box.innerHTML = '<p class="text-base text-amber-700">' + esc(e.message) + ' Vẫn có thể xác nhận thủ công nếu khách đã chuyển.</p>'; });
  }
  function updateChange() {
    var t = totals();
    var short = state.given && state.given < t.due;                  // typed less than what is due: show what is missing
    $('#change-label').textContent = short ? 'Còn thiếu' : 'Tiền thối';
    $('#change').textContent = state.given ? fmt(short ? t.due - state.given : state.given - t.due) : '—';
    $('#change').className = 'text-3xl font-bold tnum ' + (short ? 'text-red-600' : 'text-emerald-600');
    $$('[data-given]').forEach(function (b) {
      var on = Number(b.getAttribute('data-given')) === state.given;
      b.classList.toggle('border-navy-accent', on); b.classList.toggle('bg-navy-50', on);
    });
  }
  function confirmPay() {
    if (state.busy) return;
    var t = totals();
    var tableId = state.tableId;
    state.busy = true;
    $('#pay-confirm').disabled = true; $('#pay-confirm').textContent = 'Đang xử lý…';
    post('/admin/pos/checkout', payload({ method: state.method, discount: t.discount || undefined, tendered: state.method === 'cash' && state.given ? state.given : undefined }))
      .then(function (j) {
        $('#pay-dialog').close();
        toast(j.message + (j.change ? ' Thối ' + fmt(j.change) + '.' : ''), 'ok');
        if (tableId) markTable(tableId, false, null);
        DATA.temps = DATA.temps.filter(function (o) { return o.id !== j.order.id; }); renderTemps();
        state.lastPaid = { id: j.order.id, given: state.method === 'cash' && state.given ? state.given : 0 };
        if (PRINTER.autoPrint) printReceipt(state.lastPaid);
        state.tableId = null;
        resetOrder(); renderTables();
      })
      .catch(function (e) { $('#pay-error').textContent = e.message; show($('#pay-error'), true); })
      .then(function () {
        state.busy = false;
        $('#pay-confirm').disabled = false; $('#pay-confirm').textContent = 'XÁC NHẬN THANH TOÁN';
        renderCart();
      });
  }

  /** Print the receipt (80mm by default) through a hidden same-origin iframe: no pop-up to block. */
  function printReceipt(p) {
    if (!p) return;
    $('#print-frame').src = '/admin/pos/receipt/' + p.id + '?print=1' + (p.given ? '&given=' + p.given : '') + '&t=' + Date.now();
  }

  /* ------------------------------------------------------------------ prepayment (thanh toán trước) */
  function applyTables(j) { if (j.tables) { DATA.tables = j.tables; } renderTables(); }

  function setPrepayMethod(m) {
    state.pmethod = m;
    $$('.pmethod').forEach(function (b) {
      var on = b.getAttribute('data-pmethod') === m;
      b.className = 'pmethod h-12 rounded-xl border-2 text-base font-bold transition ' + (on ? 'border-navy-accent bg-navy-50 text-navy' : 'border-slate-200 text-slate-600 hover:border-slate-300');
    });
  }
  function openPrepay() {
    var t = totals();
    if (!t.count || state.busy) return;
    var cur = currentTable();
    var left = Math.max(0, t.total - state.prepaid);
    $('#prepay-sub').textContent = (cur ? (cur.name || cur.code) : 'Mang đi') + (state.orderCode ? ' · ' + state.orderCode : '');
    $('#prepay-total').textContent = fmt(t.total);
    $('#prepay-paid').textContent = fmt(state.prepaid);
    $('#prepay-left').textContent = fmt(left);
    $('#prepay-amount').value = left ? String(left) : '';
    $('#prepay-quick').innerHTML = [['Một nửa', Math.round(left / 2 / 1000) * 1000], ['Còn lại', left], ['100.000đ', 100000]].filter(function (q) { return q[1] > 0 && q[1] <= left; })
      .map(function (q) { return '<button type="button" data-prepay-amount="' + q[1] + '" class="h-11 rounded-xl border border-slate-200 text-sm font-bold tnum hover:border-navy-accent hover:text-navy-accent">' + q[0] + '</button>'; }).join('');
    show($('#prepay-error'), false);
    setPrepayMethod('cash');
    $('#prepay-dialog').showModal();
    setTimeout(function () { $('#prepay-amount').select(); }, 30);
  }
  function confirmPrepay() {
    if (state.busy) return;
    var amount = Math.round(Number(String($('#prepay-amount').value).replace(/[^\d]/g, '')) || 0);
    if (amount < 1) { $('#prepay-error').textContent = 'Nhập số tiền khách trả trước.'; show($('#prepay-error'), true); return; }
    state.busy = true; $('#prepay-confirm').disabled = true; $('#prepay-confirm').textContent = 'Đang xử lý…';
    post('/admin/pos/prepay', payload({ method: state.pmethod, amount: amount }))
      .then(function (j) {
        $('#prepay-dialog').close();
        toast(j.message, 'ok');
        state.orderId = j.order.id; state.orderCode = j.order.code; state.prepaid = j.prepaid; state.dirty = false;
        DATA.tables = j.tables; DATA.temps = j.temps || DATA.temps; renderTemps();
        loadOrder(j.order.id);
      })
      .catch(function (e) { $('#prepay-error').textContent = e.message; show($('#prepay-error'), true); })
      .then(function () { state.busy = false; $('#prepay-confirm').disabled = false; $('#prepay-confirm').textContent = 'NHẬN TIỀN TRẢ TRƯỚC'; renderCart(); });
  }

  /* ------------------------------------------------------------------ merge / split tables */
  /** A tile in the merge / split pickers. */
  function pickTile(t, on, attr) {
    var sub = t.mergedInto ? 'Ghép · ' + esc(t.mergedIntoName || '') : (t.busy ? 'Có đơn' : 'Trống');
    var cls = t.busy ? 'border-red-200 bg-red-50 text-red-700 hover:border-red-400' : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-400';
    return '<button type="button" ' + attr + '="' + t.id + '" aria-pressed="' + on + '" class="relative flex aspect-[4/3] flex-col items-center justify-center rounded-2xl border-2 p-2 text-center transition active:scale-95 ' + cls + (on ? ' border-navy-accent ring-4 ring-navy-accent/30' : '') + '">' +
      '<span class="block text-lg font-bold leading-tight">' + esc(t.name || t.code) + '</span><span class="block text-sm">' + sub + '</span>' +
      (on ? '<span class="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-navy-accent text-sm font-bold text-white">✓</span>' : '') + '</button>';
  }
  /** Tables that can be picked next to the current one: not itself, not already in its group, not merged elsewhere. */
  function otherTables() {
    var cur = currentTable();
    return DATA.tables.filter(function (t) { return cur && t.id !== cur.id && !t.mergedInto; });
  }
  function guardSaved() {
    if (state.dirty || !state.orderId) { toast('Bấm “Giữ đơn” để lưu đơn của bàn trước.', 'bad'); return false; }
    return true;
  }

  function renderMerge() {
    var cur = currentTable();
    $('#merge-sub').textContent = 'Bàn chính: ' + (cur ? (cur.name || cur.code) : '') + (state.orderCode ? ' · ' + state.orderCode : '');
    var joined = $('#merge-current');
    show(joined, state.merged.length > 0);
    joined.innerHTML = state.merged.length ? '<p class="mb-2 text-base font-semibold text-slate-600">Đang ghép cùng</p><div class="flex flex-wrap gap-2">' + state.merged.map(function (m) {
      return '<span class="flex items-center gap-2 rounded-xl bg-amber-50 py-1 pl-4 pr-1 text-base font-bold text-amber-800 ring-1 ring-amber-200">' + esc(m.name) +
        '<button type="button" data-unmerge="' + m.id + '" class="h-10 rounded-lg bg-white px-3 text-sm font-bold text-red-600 ring-1 ring-red-200 hover:bg-red-50">Tách ra</button></span>';
    }).join('') + '</div>' : '';
    $('#merge-grid').innerHTML = otherTables().map(function (t) { return pickTile(t, state.mergePick === t.id, 'data-mergepick'); }).join('') || '<p class="col-span-full text-slate-500">Không còn bàn nào để ghép.</p>';
    $('#merge-confirm').disabled = !state.mergePick || state.busy;
    show($('#merge-error'), false);
  }
  function openMerge() {
    if (state.busy || !state.tableId) return;
    if (!guardSaved()) return;
    state.mergePick = null; renderMerge(); $('#merge-dialog').showModal();
  }
  function confirmMerge() {
    if (state.busy || !state.mergePick) return;
    state.busy = true; renderMerge();
    post('/admin/pos/tables/merge', { primary_table_id: state.tableId, other_table_id: state.mergePick })
      .then(function (j) {
        applyTables(j); toast(j.message, 'ok'); state.mergePick = null;
        return loadOrder(j.orderId).then(renderMerge);
      })
      .catch(function (e) { $('#merge-error').textContent = e.message; show($('#merge-error'), true); })
      .then(function () { state.busy = false; $('#merge-confirm').disabled = !state.mergePick; renderCart(); });
  }
  function unmerge(id) {
    if (state.busy) return;
    state.busy = true;
    post('/admin/pos/tables/unmerge', { table_id: id })
      .then(function (j) { applyTables(j); toast(j.message, 'ok'); return loadOrder(state.orderId).then(renderMerge); })
      .catch(function (e) { $('#merge-error').textContent = e.message; show($('#merge-error'), true); })
      .then(function () { state.busy = false; renderCart(); });
  }

  function splitCount() { return Object.keys(state.split.qty).reduce(function (n, k) { return n + state.split.qty[k]; }, 0); }
  function renderSplit() {
    var cur = currentTable();
    $('#split-sub').textContent = (cur ? (cur.name || cur.code) : 'Đơn') + (state.orderCode ? ' · ' + state.orderCode : '') + (state.prepaid ? ' · đã trả trước ' + fmt(state.prepaid) + ' (giữ ở đơn gốc)' : '');
    $('#split-items').innerHTML = state.orderItems.map(function (i) {
      var q = state.split.qty[i.id] || 0;
      return '<li class="flex items-center gap-2 rounded-xl border border-slate-100 bg-white p-2"><span class="min-w-0 flex-1"><span class="block truncate text-base font-bold text-dark">' + esc(i.name) + '</span>' +
        '<span class="block text-sm text-slate-500 tnum">' + fmt(i.price) + ' · có ' + i.qty + '</span></span>' +
        '<span class="flex items-center rounded-xl bg-slate-100"><button type="button" data-sdec="' + i.id + '" aria-label="Bớt" class="flex h-11 w-11 items-center justify-center rounded-xl text-2xl font-bold text-navy hover:bg-slate-200 active:scale-90">−</button>' +
        '<span class="w-8 text-center text-lg font-bold tnum">' + q + '</span>' +
        '<button type="button" data-sinc="' + i.id + '" aria-label="Thêm" class="flex h-11 w-11 items-center justify-center rounded-xl text-2xl font-bold text-navy hover:bg-slate-200 active:scale-90">+</button></span></li>';
    }).join('');
    $('#split-grid').innerHTML = otherTables().map(function (t) { return pickTile(t, state.split.target === t.id, 'data-splittarget'); }).join('') || '<p class="col-span-full text-slate-500">Không có bàn nào để chuyển món sang.</p>';
    $('#split-confirm').disabled = !splitCount() || !state.split.target || state.busy;
    show($('#split-error'), false);
  }
  function openSplit() {
    if (state.busy || !state.orderId) return;
    if (!guardSaved()) return;
    state.split = { qty: {}, target: null }; renderSplit(); $('#split-dialog').showModal();
  }
  function splitStep(id, d) {
    var item = state.orderItems.filter(function (i) { return i.id === id; })[0]; if (!item) return;
    var q = Math.max(0, Math.min(item.qty, (state.split.qty[id] || 0) + d));
    if (q) state.split.qty[id] = q; else delete state.split.qty[id];
    renderSplit();
  }
  function confirmSplit() {
    if (state.busy || !splitCount() || !state.split.target) return;
    var items = Object.keys(state.split.qty).map(function (k) { return { item_id: Number(k), quantity: state.split.qty[k] }; });
    state.busy = true; renderSplit();
    post('/admin/pos/split', { order_id: state.orderId, target_table_id: state.split.target, items: items })
      .then(function (j) {
        $('#split-dialog').close(); applyTables(j); toast(j.message, 'ok');
        return loadOrder(j.sourceOrderId);
      })
      .catch(function (e) { $('#split-error').textContent = e.message; show($('#split-error'), true); })
      .then(function () { state.busy = false; $('#split-confirm').disabled = !splitCount() || !state.split.target; renderCart(); });
  }

  /* ------------------------------------------------------------------ order history */
  var METHOD_VN = { cash: 'Tiền mặt', transfer: 'Chuyển khoản', card: 'Thẻ', other: 'Khác' };
  var STATUS_VN = { open: ['Đang mở', 'bg-amber-100 text-amber-800'], completed: ['Hoàn tất', 'bg-emerald-100 text-emerald-800'], cancelled: ['Đã hủy', 'bg-slate-200 text-slate-600'] };
  var hhmm = function (d) { return d ? new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : ''; };
  var today = function () { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
  var historySeq = 0;

  function getJson(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) {
      if ((r.headers.get('content-type') || '').indexOf('application/json') === -1) throw new Error('Phiên đăng nhập đã hết hạn. Tải lại trang để đăng nhập lại.');
      return r.json();
    }).then(function (j) { if (!j.ok) throw new Error(j.message || 'Không tải được dữ liệu.'); return j; });
  }

  function loadHistory() {
    var seq = ++historySeq, list = $('#history-list');
    list.innerHTML = '<li class="py-8 text-center text-slate-500">Đang tải…</li>';
    var q = '?day=' + encodeURIComponent($('#history-day').value || today()) + '&status=' + encodeURIComponent($('#history-status').value) + '&q=' + encodeURIComponent($('#history-q').value.trim());
    getJson('/admin/pos/history' + q).then(function (j) {
      if (seq !== historySeq) return;
      var sum = j.orders.filter(function (o) { return o.status === 'completed'; }).reduce(function (s, o) { return s + o.total; }, 0);
      $('#history-sub').textContent = j.orders.length + ' đơn · hoàn tất ' + fmt(sum);
      list.innerHTML = j.orders.map(function (o) {
        var st = STATUS_VN[o.status] || [o.status, 'bg-slate-100'];
        return '<li class="rounded-xl border border-slate-200" data-order="' + o.id + '"><button type="button" data-history-open="' + o.id + '" class="flex w-full items-center gap-3 p-3 text-left">' +
          '<span class="min-w-0 flex-1"><span class="block text-base font-bold tnum">' + esc(o.code) + '</span>' +
          '<span class="block truncate text-sm text-slate-500">' + hhmm(o.at) + ' · ' + (o.table ? 'Bàn ' + esc(o.table) : 'Mang đi') + ' · ' + o.count + ' món' + (o.method ? ' · ' + esc(METHOD_VN[o.method] || o.method) : '') + '</span></span>' +
          '<span class="rounded-md px-2 py-0.5 text-xs font-bold ' + st[1] + '">' + st[0] + (o.status === 'completed' && !o.paid ? ' · nợ' : '') + '</span>' +
          '<span class="w-28 text-right text-lg font-bold text-navy tnum">' + fmt(o.total) + '</span></button><div class="hidden border-t border-slate-100 p-3" data-detail></div></li>';
      }).join('') || '<li class="py-8 text-center text-slate-500">Không có đơn nào.</li>';
    }).catch(function (e) { if (seq === historySeq) list.innerHTML = '<li class="py-8 text-center text-red-600">' + esc(e.message) + '</li>'; });
  }
  function openHistoryDialog() {
    if (!$('#history-day').value) $('#history-day').value = today();
    loadHistory(); $('#history-dialog').showModal();
  }
  function toggleHistoryOrder(id) {
    var li = $('#history-list [data-order="' + id + '"]'); if (!li) return;
    var box = $('[data-detail]', li);
    if (!box.classList.contains('hidden')) { show(box, false); return; }
    show(box, true); box.innerHTML = '<p class="text-slate-500">Đang tải…</p>';
    getJson('/admin/pos/history/' + id).then(function (j) {
      var o = j.order;
      box.innerHTML = '<ul class="space-y-1 text-base">' + o.items.map(function (i) {
        return '<li class="flex justify-between gap-3"><span>' + i.qty + ' × ' + esc(i.name) + (i.note ? ' <span class="text-sm text-slate-500">(' + esc(i.note) + ')</span>' : '') + '</span><span class="tnum">' + fmt(i.total) + '</span></li>';
      }).join('') + '</ul>' +
        (o.discount ? '<p class="mt-2 flex justify-between text-slate-600"><span>Giảm giá</span><span class="tnum">−' + fmt(o.discount) + '</span></p>' : '') +
        '<p class="mt-1 flex justify-between text-lg font-bold"><span>Tổng</span><span class="tnum">' + fmt(o.total) + '</span></p>' +
        (o.payments.length ? '<div class="mt-2 rounded-lg bg-slate-50 p-2 text-sm text-slate-600">' + o.payments.map(function (p) {
          return '<p class="flex justify-between"><span>' + esc(p.label) + (p.reference ? ' · ' + esc(p.reference) : '') + '</span><span class="tnum">' + (p.amount < 0 ? '−' : '') + fmt(Math.abs(p.amount)) + '</span></p>';
        }).join('') + '</div>' : '') +
        (o.note ? '<p class="mt-2 text-sm italic text-slate-500">Ghi chú: ' + esc(o.note) + '</p>' : '') +
        (o.status === 'completed' ? '<button type="button" data-history-print="' + o.id + '" class="mt-3 h-12 rounded-xl bg-navy px-5 text-base font-semibold text-white hover:bg-navy-accent">🖨 In lại hóa đơn</button>' : '');
    }).catch(function (e) { box.innerHTML = '<p class="text-red-600">' + esc(e.message) + '</p>'; });
  }

  /* ------------------------------------------------------------------ chốt ca (close the shift) */
  var shiftState = { closed: null, data: null };
  var dt = function (d) { return new Date(d).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }); };
  var digits = function (el) { return Math.round(Number(String(el.value).replace(/\D/g, '')) || 0); };

  function renderShiftDiff() {
    var s = shiftState.data; if (!s) return;
    var expected = digits($('#shift-opening')) + s.pay.cash, counted = digits($('#shift-counted')), diff = counted - expected;
    $('#shift-expected').textContent = fmt(expected);
    var el = $('#shift-diff');
    if (!$('#shift-counted').value) { el.textContent = '—'; el.className = 'text-2xl font-bold text-slate-400 tnum'; return; }
    el.textContent = diff === 0 ? 'Khớp' : (diff > 0 ? 'Thừa ' : 'Thiếu ') + fmt(Math.abs(diff));
    el.className = 'text-2xl font-bold tnum ' + (diff === 0 ? 'text-emerald-600' : diff > 0 ? 'text-amber-600' : 'text-red-600');
  }
  function openShift() {
    shiftState.closed = null;
    $('#shift-body').innerHTML = '<p class="py-8 text-center text-slate-500">Đang tính…</p>';
    show($('#shift-error'), false); $('#shift-confirm').disabled = true; $('#shift-confirm').textContent = 'CHỐT CA';
    $('#shift-dialog').showModal();
    getJson('/admin/pos/shift').then(function (j) {
      var s = shiftState.data = j.shift, t = s.totals;
      $('#shift-sub').textContent = 'Từ ' + dt(s.from) + ' đến ' + dt(s.to);
      var card = function (label, val, cls) { return '<div class="rounded-xl p-3 ' + (cls || 'bg-slate-50') + '"><p class="text-xs text-slate-500">' + label + '</p><p class="text-lg font-bold tnum">' + val + '</p></div>'; };
      $('#shift-body').innerHTML =
        '<div class="grid grid-cols-2 gap-2 sm:grid-cols-4">' + card('Doanh thu', fmt(t.revenue), 'bg-navy-50') + card('Số đơn', t.orders) + card('Giảm giá', fmt(t.discount)) + card('Đã hủy', t.cancelled) + '</div>' +
        '<p class="mb-1 mt-4 text-base font-semibold text-slate-600">Tiền thu theo hình thức</p>' +
        '<div class="grid grid-cols-3 gap-2">' + card('💵 Tiền mặt', fmt(s.pay.cash)) + card('🏦 Chuyển khoản', fmt(s.pay.transfer)) + card('💳 Thẻ', fmt(s.pay.card)) + '</div>' +
        (t.unpaid ? '<p class="mt-2 text-sm text-slate-600">Ghi nợ chưa thu trong ca: <b class="tnum">' + fmt(t.unpaid) + '</b></p>' : '') +
        (t.open ? '<p class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Còn <b>' + t.open + '</b> đơn đang mở (' + fmt(t.openAmount) + '), chưa tính vào ca này. Đơn sẽ được tính khi thanh toán.</p>' : '') +
        '<p class="mb-1 mt-5 text-base font-semibold text-slate-600">Đối chiếu tiền mặt</p>' +
        '<label class="block text-sm text-slate-500" for="shift-opening">Tiền đầu ca (đ)</label>' +
        '<input id="shift-opening" inputmode="numeric" autocomplete="off" value="' + (s.suggestedOpening ? s.suggestedOpening.toLocaleString('vi-VN') : '') + '" placeholder="0" class="h-12 w-full select-text rounded-xl border border-slate-200 px-4 text-xl font-bold tnum focus:border-navy-accent focus:outline-none">' +
        '<p class="mt-2 flex justify-between text-base"><span class="text-slate-600">Tiền mặt phải có (đầu ca + thu tiền mặt)</span><b class="tnum" id="shift-expected">0đ</b></p>' +
        '<label class="mt-2 block text-sm text-slate-500" for="shift-counted">Tiền mặt đếm được trong két (đ)</label>' +
        '<input id="shift-counted" inputmode="numeric" autocomplete="off" placeholder="Nhập số tiền thực tế" class="h-14 w-full select-text rounded-xl border border-slate-200 px-4 text-2xl font-bold tnum focus:border-navy-accent focus:outline-none">' +
        '<p class="mt-2 flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 text-base"><span class="font-semibold text-slate-600">Chênh lệch</span><span id="shift-diff"></span></p>' +
        '<label class="mt-3 block text-sm text-slate-500" for="shift-note">Ghi chú (nếu có)</label>' +
        '<input id="shift-note" maxlength="255" autocomplete="off" class="h-12 w-full select-text rounded-xl border border-slate-200 px-4 text-base focus:border-navy-accent focus:outline-none">' +
        (s.recent.length ? '<p class="mb-1 mt-5 text-sm font-semibold text-slate-500">Các ca đã chốt</p><ul class="space-y-1 text-sm">' + s.recent.map(function (r) {
          return '<li class="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"><span>#' + r.id + ' · ' + dt(r.period_to) + ' · ' + esc(r.closed_by_name || '') + '</span><span class="tnum">' + fmt(Number(r.revenue)) + '</span>' +
            '<button type="button" data-shift-print="' + r.id + '" class="rounded-md px-2 py-1 font-semibold text-navy-accent hover:bg-navy-50">In</button></li>';
        }).join('') + '</ul>' : '');
      ['#shift-opening', '#shift-counted'].forEach(function (sel) {
        $(sel).addEventListener('input', function (e) { var n = digits(e.target); e.target.value = n ? n.toLocaleString('vi-VN') : ''; renderShiftDiff(); });
      });
      renderShiftDiff(); $('#shift-confirm').disabled = false;
    }).catch(function (e) { $('#shift-body').innerHTML = '<p class="py-6 text-center text-red-600">' + esc(e.message) + '</p>'; });
  }
  function confirmShift() {
    if (shiftState.closed) { printFrameUrl('/admin/pos/shift/' + shiftState.closed + '/print?print=1'); return; }
    if (state.busy || !shiftState.data) return;
    if (!$('#shift-counted').value && !window.confirm('Chưa nhập tiền mặt đếm được. Vẫn chốt ca với số 0?')) return;
    state.busy = true; $('#shift-confirm').disabled = true;
    post('/admin/pos/shift/close', { opening_cash: digits($('#shift-opening')), counted_cash: digits($('#shift-counted')), note: $('#shift-note').value })
      .then(function (j) {
        shiftState.closed = j.shiftId;
        toast(j.message + (j.difference ? (j.difference > 0 ? ' Thừa ' : ' Thiếu ') + fmt(Math.abs(j.difference)) + '.' : ' Tiền mặt khớp.'), j.difference ? 'info' : 'ok');
        $('#shift-body').innerHTML = '<div class="py-10 text-center"><p class="text-5xl" aria-hidden="true">✅</p><p class="mt-3 text-xl font-bold text-navy-darker">Đã chốt ca #' + j.shiftId + '</p><p class="mt-1 text-slate-500">Bấm nút bên dưới để in phiếu chốt ca.</p></div>';
        $('#shift-confirm').textContent = '🖨 IN PHIẾU CHỐT CA';
      })
      .catch(function (e) { $('#shift-error').textContent = e.message; show($('#shift-error'), true); })
      .then(function () { state.busy = false; $('#shift-confirm').disabled = false; });
  }
  /** Loads a printable page in the hidden iframe (receipt, shift report). */
  function printFrameUrl(url) { $('#print-frame').src = url + (url.indexOf('t=') === -1 ? '&t=' + Date.now() : ''); }

  /* ------------------------------------------------------------------ events */
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#table-menu') && !e.target.closest('#table-btn')) toggleTableMenu(false);
    var t = e.target.closest('button'); if (!t) return;
    if (t.hasAttribute('data-cat')) { state.cat = t.getAttribute('data-cat'); renderCategories(); renderGrid(); return; }
    if (t.hasAttribute('data-add')) { add(Number(t.getAttribute('data-add'))); return; }
    if (t.hasAttribute('data-inc')) { change(Number(t.getAttribute('data-inc')), 1); return; }
    if (t.hasAttribute('data-dec')) { change(Number(t.getAttribute('data-dec')), -1); return; }
    if (t.hasAttribute('data-del')) { remove(Number(t.getAttribute('data-del'))); return; }
    if (t.hasAttribute('data-given')) { state.given = Number(t.getAttribute('data-given')); $('#given-input').value = state.given.toLocaleString('vi-VN'); updateChange(); return; }
    if (t.hasAttribute('data-method')) { setMethod(t.getAttribute('data-method')); return; }
    if (t.hasAttribute('data-close')) { t.closest('dialog').close(); return; }
    if (t.hasAttribute('data-table')) { selectTable(t.getAttribute('data-table')); return; }
    if (t.hasAttribute('data-temp-open')) { openTemp(Number(t.getAttribute('data-temp-open'))); return; }
    if (t.hasAttribute('data-temp-cancel')) { cancelTemp(Number(t.getAttribute('data-temp-cancel'))); return; }
    if (t.hasAttribute('data-history-open')) { toggleHistoryOrder(Number(t.getAttribute('data-history-open'))); return; }
    if (t.hasAttribute('data-history-print')) { printFrameUrl('/admin/pos/receipt/' + t.getAttribute('data-history-print') + '?print=1'); return; }
    if (t.hasAttribute('data-shift-print')) { printFrameUrl('/admin/pos/shift/' + t.getAttribute('data-shift-print') + '/print?print=1'); return; }
    if (t.hasAttribute('data-pmethod')) { setPrepayMethod(t.getAttribute('data-pmethod')); return; }
    if (t.hasAttribute('data-prepay-amount')) { $('#prepay-amount').value = t.getAttribute('data-prepay-amount'); return; }
    if (t.hasAttribute('data-mergepick')) { state.mergePick = Number(t.getAttribute('data-mergepick')); renderMerge(); return; }
    if (t.hasAttribute('data-unmerge')) { unmerge(Number(t.getAttribute('data-unmerge'))); return; }
    if (t.hasAttribute('data-splittarget')) { state.split.target = Number(t.getAttribute('data-splittarget')); renderSplit(); return; }
    if (t.hasAttribute('data-sinc')) { splitStep(Number(t.getAttribute('data-sinc')), 1); return; }
    if (t.hasAttribute('data-sdec')) { splitStep(Number(t.getAttribute('data-sdec')), -1); return; }
    switch (t.id) {
      case 'btn-pay': openPay(); break;
      case 'btn-hold': hold(); break;
      case 'btn-history': openHistoryDialog(); break;
      case 'btn-shift': openShift(); break;
      case 'shift-confirm': confirmShift(); break;
      case 'btn-temps': renderTemps(); $('#temp-dialog').showModal(); break;
      case 'btn-prepay': openPrepay(); break;
      case 'btn-merge': openMerge(); break;
      case 'btn-split': openSplit(); break;
      case 'prepay-confirm': confirmPrepay(); break;
      case 'merge-confirm': confirmMerge(); break;
      case 'split-confirm': confirmSplit(); break;
      case 'btn-reprint': printReceipt(state.lastPaid); break;
      case 'table-btn': toggleTableMenu(); break;
      case 'pay-confirm': confirmPay(); break;
      case 'zalo-banner': $('#zalo-dialog').showModal(); break;
      case 'btn-note': ask('Ghi chú cho đơn', state.note, 'text', function (v) { state.note = v.slice(0, 255); $('#note-label').textContent = v ? 'Có ghi chú' : 'Ghi chú'; }); break;
      case 'btn-discount': ask('Giảm giá (đ)', state.discount || '', 'number', function (v) { state.discount = Math.max(0, Math.round(Number(v) || 0)); renderCart(); }); break;
    }
  });
  // Any amount the customer hands over (digits only; shown with thousand separators)
  $('#given-input').addEventListener('input', function (e) {
    var n = Math.min(99999999999, Number(String(e.target.value).replace(/\D/g, '')) || 0);
    state.given = n;
    e.target.value = n ? n.toLocaleString('vi-VN') : '';
    updateChange();
  });
  $('#given-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); confirmPay(); } });
  ['#history-day', '#history-status'].forEach(function (sel) { $(sel).addEventListener('change', loadHistory); });
  var historyTimer;
  $('#history-q').addEventListener('input', function () { clearTimeout(historyTimer); historyTimer = setTimeout(loadHistory, 300); });
  $('#search').addEventListener('input', function (e) { state.q = e.target.value; renderGrid(); });

  document.addEventListener('keydown', function (e) {
    var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    var dialogOpen = document.querySelector('dialog[open]');
    if (e.key === 'Enter' && !typing) {
      if ($('#pay-dialog').open) { e.preventDefault(); confirmPay(); }
      else if (!dialogOpen) { e.preventDefault(); openPay(); }
    } else if (e.key === '/' && !typing && !dialogOpen) {
      e.preventDefault(); $('#search').focus();
    } else if (e.key === 'Escape' && !$('#table-menu').classList.contains('hidden')) {
      toggleTableMenu(false);
    } else if (e.key === 'Escape' && document.activeElement === $('#search')) {
      $('#search').value = ''; state.q = ''; renderGrid(); $('#search').blur();
    }
  });

  /* ------------------------------------------------------------------ clock + boot */
  function tick() {
    var now = new Date();
    $('#clock').textContent = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    $('#date').textContent = now.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit' });
  }
  DATA.temps = DATA.temps || [];
  renderCategories(); renderGrid(); renderTables(); renderCart(); renderZalo(); renderTemps(); tick();
  setInterval(tick, 15000);
})();
