/**
 * CoCoffee POS front-office (tablet at the counter). Vanilla JS, no framework.
 * Data comes from <script id="pos-data"> (rendered by controllers/admin/pos.js). The cart lives here;
 * checkout / hold send it to /admin/pos/* where orderService re-prices it from the database, deducts
 * stock (BOM) and records the payment. Prices shown here are for display only.
 */
(function () {
  'use strict';

  var DATA = JSON.parse(document.getElementById('pos-data').textContent);
  var VAT_RATE = 0.08;                      // prices include VAT; shown as "of which VAT"
  var TAKEAWAY = '';                        // <select> value for "no table"

  var state = { cat: 'all', q: '', cart: [], discount: 0, note: '', method: 'cash', given: 0, orderId: null, orderCode: null, busy: false };

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
    return { subtotal: subtotal, discount: discount, total: total, vat: total - total / (1 + VAT_RATE), count: state.cart.reduce(function (s, l) { return s + l.qty; }, 0) };
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
  function renderTables() {
    $('#table').innerHTML = '<option value="' + TAKEAWAY + '">🥡 Mang đi</option>' + DATA.tables.map(function (t) {
      return '<option value="' + t.id + '">' + (t.busy ? '🔴 ' : '🟢 ') + esc(t.name || t.code) + (t.busy ? ' — Đang phục vụ' : ' — Trống') + '</option>';
    }).join('');
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
    $('#total').textContent = fmt(t.total);
    $('#btn-pay').disabled = t.count === 0 || state.busy;
    $('#btn-hold').disabled = t.count === 0 || state.busy || $('#table').value === TAKEAWAY;
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
    renderCart(id); renderGrid();
  }
  function change(id, delta) {
    state.cart = state.cart.map(function (l) { return l.id === id ? { id: l.id, qty: Math.min(99, l.qty + delta) } : l; })
                           .filter(function (l) { return l.qty > 0; });
    renderCart(delta > 0 ? id : null); renderGrid();
  }
  function remove(id) { state.cart = state.cart.filter(function (l) { return l.id !== id; }); renderCart(); renderGrid(); }

  function resetOrder() {
    state.cart = []; state.discount = 0; state.note = ''; state.orderId = null; state.orderCode = null;
    $('#note-label').textContent = 'Ghi chú';
    renderCart(); renderGrid();
  }

  /** Picking a busy table loads its open order, so items are added to it and paid together. */
  function onTableChange() {
    var t = DATA.tables.filter(function (x) { return String(x.id) === $('#table').value; })[0];
    if (!t || !t.busy || !t.orderId) {
      if (state.orderId) resetOrder(); else renderCart();
      return;
    }
    state.busy = true; renderCart();
    fetch('/admin/pos/orders/' + t.orderId, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.message);
        state.cart = j.order.items.filter(function (i) { return products[i.productId]; }).map(function (i) { return { id: i.productId, qty: i.qty }; });
        state.orderId = j.order.id; state.orderCode = j.order.code; state.note = j.order.note || '';
        $('#note-label').textContent = state.note ? 'Có ghi chú' : 'Ghi chú';
        toast('Đã mở đơn ' + j.order.code + ' của ' + (t.name || t.code));
      })
      .catch(function (e) { toast(e.message || 'Không mở được đơn của bàn.', 'bad'); })
      .then(function () { state.busy = false; renderCart(); renderGrid(); });
  }

  function payload(extra) {
    var tableId = $('#table').value;
    var body = {
      table_id: state.orderId ? null : (tableId || null),
      order_id: state.orderId,
      items: state.cart.map(function (l) { return { product_id: l.id, quantity: l.qty }; }),
      note: state.note,
    };
    for (var k in extra) body[k] = extra[k];
    return body;
  }

  function markTable(id, busy, orderId) {
    DATA.tables.forEach(function (t) { if (String(t.id) === String(id)) { t.busy = busy; t.orderId = orderId || null; } });
    var keep = $('#table').value; renderTables(); $('#table').value = keep;
  }

  function hold() {
    if (state.busy || !state.cart.length) return;
    var tableId = $('#table').value;
    state.busy = true; renderCart();
    post('/admin/pos/hold', payload({}))
      .then(function (j) {
        markTable(tableId, true, j.order.id);
        toast(j.message, 'ok');
        $('#table').value = TAKEAWAY; resetOrder();
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
    state.given = 0;
    $('#pay-total').textContent = fmt(t.total);
    $('#pay-sub').textContent = $('#table').selectedOptions[0].textContent.replace(/^\S+\s/, '') + ' · ' + t.count + ' món';
    var opts = [t.total, Math.ceil(t.total / 50000) * 50000, Math.ceil(t.total / 100000) * 100000, Math.ceil(t.total / 100000) * 100000 + 100000, 500000]
      .filter(function (v, i, a) { return v >= t.total && a.indexOf(v) === i; }).slice(0, 4);
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
    updateChange();
  }
  function updateChange() {
    var t = totals();
    $('#change').textContent = state.given ? fmt(Math.max(0, state.given - t.total)) : '—';
    $$('[data-given]').forEach(function (b) {
      var on = Number(b.getAttribute('data-given')) === state.given;
      b.classList.toggle('border-navy-accent', on); b.classList.toggle('bg-navy-50', on);
    });
  }
  function confirmPay() {
    if (state.busy) return;
    var t = totals();
    var tableId = $('#table').value;
    state.busy = true;
    $('#pay-confirm').disabled = true; $('#pay-confirm').textContent = 'Đang xử lý…';
    post('/admin/pos/checkout', payload({ method: state.method, discount: t.discount || undefined, tendered: state.method === 'cash' && state.given ? state.given : undefined }))
      .then(function (j) {
        $('#pay-dialog').close();
        toast(j.message + (j.change ? ' Thối ' + fmt(j.change) + '.' : ''), 'ok');
        if (tableId) markTable(tableId, false, null);
        $('#table').value = TAKEAWAY;
        resetOrder();
      })
      .catch(function (e) { $('#pay-error').textContent = e.message; show($('#pay-error'), true); })
      .then(function () {
        state.busy = false;
        $('#pay-confirm').disabled = false; $('#pay-confirm').textContent = 'XÁC NHẬN THANH TOÁN';
        renderCart();
      });
  }

  /* ------------------------------------------------------------------ events */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.hasAttribute('data-cat')) { state.cat = t.getAttribute('data-cat'); renderCategories(); renderGrid(); return; }
    if (t.hasAttribute('data-add')) { add(Number(t.getAttribute('data-add'))); return; }
    if (t.hasAttribute('data-inc')) { change(Number(t.getAttribute('data-inc')), 1); return; }
    if (t.hasAttribute('data-dec')) { change(Number(t.getAttribute('data-dec')), -1); return; }
    if (t.hasAttribute('data-del')) { remove(Number(t.getAttribute('data-del'))); return; }
    if (t.hasAttribute('data-given')) { state.given = Number(t.getAttribute('data-given')); updateChange(); return; }
    if (t.hasAttribute('data-method')) { setMethod(t.getAttribute('data-method')); return; }
    if (t.hasAttribute('data-close')) { t.closest('dialog').close(); return; }
    switch (t.id) {
      case 'btn-pay': openPay(); break;
      case 'btn-hold': hold(); break;
      case 'pay-confirm': confirmPay(); break;
      case 'zalo-banner': $('#zalo-dialog').showModal(); break;
      case 'btn-note': ask('Ghi chú cho đơn', state.note, 'text', function (v) { state.note = v.slice(0, 255); $('#note-label').textContent = v ? 'Có ghi chú' : 'Ghi chú'; }); break;
      case 'btn-discount': ask('Giảm giá (đ)', state.discount || '', 'number', function (v) { state.discount = Math.max(0, Math.round(Number(v) || 0)); renderCart(); }); break;
    }
  });
  $('#table').addEventListener('change', onTableChange);
  $('#search').addEventListener('input', function (e) { state.q = e.target.value; renderGrid(); });

  document.addEventListener('keydown', function (e) {
    var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    var dialogOpen = document.querySelector('dialog[open]');
    if (e.key === 'Enter' && !typing) {
      if ($('#pay-dialog').open) { e.preventDefault(); confirmPay(); }
      else if (!dialogOpen) { e.preventDefault(); openPay(); }
    } else if (e.key === '/' && !typing && !dialogOpen) {
      e.preventDefault(); $('#search').focus();
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
  renderCategories(); renderGrid(); renderTables(); renderCart(); renderZalo(); tick();
  setInterval(tick, 15000);
})();
