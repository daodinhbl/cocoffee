/* Inventory > Nhập Excel: upload the .xlsx twice - first as a dry run (preview), then to apply. No innerHTML: file content is untrusted. */
(function () {
  'use strict';
  var form = document.querySelector('[data-xlsx-form]');
  if (!form) return;
  var fileInput = form.querySelector('#xlsx-file');
  var statusEl = form.querySelector('[data-xlsx-status]');
  var preview = form.querySelector('[data-xlsx-preview]');
  var applyBtn = form.querySelector('[data-xlsx-apply]');
  var csrf = form.querySelector('[name="_csrf"]').value;
  var file = null;
  var busy = false;

  form.addEventListener('submit', function (e) { e.preventDefault(); });

  function say(text, tone) {
    statusEl.textContent = text;
    statusEl.className = 'text-sm ' + (tone === 'bad' ? 'text-red-700' : tone === 'good' ? 'text-emerald-700' : 'text-milk-500');
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function clear() { while (preview.firstChild) preview.removeChild(preview.firstChild); }

  function chip(label, count, tone) {
    var cls = { good: 'border-emerald-200 bg-emerald-50 text-emerald-800', info: 'border-blue-200 bg-blue-50 text-blue-800', warn: 'border-amber-200 bg-amber-50 text-amber-800', bad: 'border-red-200 bg-red-50 text-red-800', neutral: 'border-milk-200 bg-milk-50 text-milk-500' }[tone];
    var c = el('div', 'rounded-lg border px-3 py-2 text-center ' + cls);
    c.appendChild(el('div', 'font-mono text-xl font-bold tnum', String(count)));
    c.appendChild(el('div', 'text-xs font-medium', label));
    return c;
  }
  function list(title, rows, line, open) {
    if (!rows || !rows.length) return;
    var d = el('details', 'rounded-lg border border-milk-200');
    if (open) d.open = true;
    d.appendChild(el('summary', 'cursor-pointer select-none px-3 py-2 text-sm font-semibold text-navy-darker', title + ' (' + rows.length + (rows.length >= 100 ? '+' : '') + ')'));
    var ul = el('ul', 'max-h-48 divide-y divide-milk-200 overflow-y-auto border-t border-milk-200 text-sm');
    rows.forEach(function (r) { ul.appendChild(el('li', 'px-3 py-1.5', line(r))); });
    d.appendChild(ul);
    preview.appendChild(d);
  }
  var n = function (v) { return Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 3 }); };

  function render(data) {
    clear();
    var s = data.summary || {};
    var grid = el('div', 'grid grid-cols-2 gap-2 sm:grid-cols-5');
    grid.appendChild(chip('Thêm mới', s.creates || 0, 'good'));
    grid.appendChild(chip('Cập nhật', s.updates || 0, 'info'));
    grid.appendChild(chip('Kiểm kê', s.counts || 0, 'warn'));
    grid.appendChild(chip('Không đổi', s.unchanged || 0, 'neutral'));
    grid.appendChild(chip('Lỗi', s.errors || 0, (s.errors || 0) ? 'bad' : 'neutral'));
    preview.appendChild(grid);
    list('Lỗi cần sửa trong file', data.errors, function (r) { return 'Dòng ' + r.row + ': ' + r.message; }, true);
    list('Nguyên liệu thêm mới', data.creates, function (r) { return 'Dòng ' + r.row + ' · ' + r.sku + ' · ' + r.name + ' (' + r.unit + ')' + (r.quantity ? ' · tồn đầu ' + n(r.quantity) : ''); });
    list('Thay đổi thông tin', data.updates, function (r) { return 'Dòng ' + r.row + ' · ' + r.sku + ' · ' + r.changes.join('; '); });
    list('Kiểm kê tồn kho', data.counts, function (r) { return 'Dòng ' + r.row + ' · ' + r.sku + ' · ' + r.name + ': ' + n(r.from) + ' → ' + n(r.to); });
  }

  function post(url) {
    return fetch(url, { method: 'POST', headers: { 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }, body: file })
      .then(function (res) { return res.json().catch(function () { return { ok: false, error: 'Máy chủ trả lời không hợp lệ.' }; }); });
  }

  fileInput.addEventListener('change', function () {
    file = fileInput.files && fileInput.files[0];
    applyBtn.disabled = true;
    clear();
    if (!file) { say(''); return; }
    if (!/\.xlsx$/i.test(file.name)) { say('Chỉ nhận file .xlsx (Excel). Hãy lưu lại file ở định dạng này.', 'bad'); file = null; return; }
    say('Đang đọc file…');
    busy = true;
    post('/admin/inventory/import?dry=1').then(function (data) {
      busy = false;
      if (!data.ok) { say(data.error || 'Không đọc được file.', 'bad'); return; }
      render(data);
      var s = data.summary, changes = s.creates + s.updates + s.counts;
      if (s.errors) say('File còn ' + s.errors + ' lỗi. Sửa trong Excel rồi chọn lại file.', 'bad');
      else if (!changes) say('Không có thay đổi nào so với dữ liệu hiện tại.');
      else { say('Xem lại rồi bấm “Áp dụng nhập”.', 'good'); applyBtn.disabled = false; }
    }).catch(function () { busy = false; say('Không kết nối được máy chủ.', 'bad'); });
  });

  applyBtn.addEventListener('click', function () {
    if (!file || busy) return;
    busy = true; applyBtn.disabled = true; say('Đang nhập…');
    post('/admin/inventory/import').then(function (data) {
      busy = false;
      if (!data.ok) { say(data.error || 'Không nhập được.', 'bad'); if (data.summary) render(data); return; }
      say(data.message || 'Đã nhập xong.', 'good');
      setTimeout(function () { window.location.reload(); }, 900);
    }).catch(function () { busy = false; say('Không kết nối được máy chủ.', 'bad'); applyBtn.disabled = false; });
  });

  var dlg = document.getElementById('xlsx-dialog');
  if (dlg) dlg.addEventListener('close', function () { fileInput.value = ''; file = null; clear(); say(''); applyBtn.disabled = true; });
})();
