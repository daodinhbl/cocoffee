const ExcelJS = require('exceljs');
const { AppError } = require('../utils/httpError');

/**
 * Excel import/export for the ingredient list (Web Admin > Nguyên liệu).
 *   exportWorkbook(items)  -> .xlsx buffer: styled header, frozen header row, filter, number formats, columns auto-fitted
 *   templateWorkbook()     -> .xlsx buffer: the import columns with sample rows and instructions
 *   parseSheet(buffer)     -> rows read from the first sheet (header names are matched loosely, accents/case ignored)
 *   plan(rows, existing)   -> what an import would do: creates / updates / stock counts / unchanged / errors
 * The export can be re-imported as it is: unknown columns (Giá trị tồn, Tình trạng "Đủ"...) are ignored.
 */
const MAX_ROWS = 2000;
const MAX_BYTES = 5 * 1024 * 1024;
const NAVY = 'FF1E3A8A';
const MILK = 'FFFAF8F5';

const COLUMNS = [
  { key: 'sku', header: 'SKU' },
  { key: 'name', header: 'Tên nguyên liệu' },
  { key: 'unit', header: 'Đơn vị' },
  { key: 'quantity', header: 'Tồn kho' },
  { key: 'min_stock', header: 'Tồn tối thiểu' },
  { key: 'cost', header: 'Giá vốn BQ (đ)' },
  { key: 'value', header: 'Giá trị tồn (đ)' },
  { key: 'status', header: 'Tình trạng' },
];

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Header text (folded) -> field. Several spellings so the export, the template and hand-made files all import.
const ALIASES = new Map([
  ['sku', 'sku'], ['ma', 'sku'], ['ma sku', 'sku'], ['ma hang', 'sku'], ['ma nguyen lieu', 'sku'],
  ['ten', 'name'], ['ten nguyen lieu', 'name'], ['ten hang', 'name'], ['ten mat hang', 'name'], ['name', 'name'],
  ['don vi', 'unit'], ['dvt', 'unit'], ['unit', 'unit'],
  ['ton kho', 'quantity'], ['ton thuc te', 'quantity'], ['so luong', 'quantity'], ['ton', 'quantity'], ['quantity', 'quantity'],
  ['ton toi thieu', 'min_stock'], ['toi thieu', 'min_stock'], ['min', 'min_stock'], ['min stock', 'min_stock'],
  ['gia von', 'cost'], ['gia von bq', 'cost'], ['gia von bq d', 'cost'], ['gia von d don vi', 'cost'], ['don gia', 'cost'], ['cost', 'cost'],
  ['tinh trang', 'status'], ['trang thai', 'status'], ['status', 'status'],
]);

// ---------------------------------------------------------------------------------------------- styling helpers
const isInt = (n) => Math.abs(n - Math.round(n)) < 1e-9;
const fmtQty = (n) => (isInt(n) ? '#,##0' : '#,##0.000');
const fmtVnd = '#,##0" đ"';

/** Display length of a cell as Excel will show it (used to size the column). */
function shownLength(value, numFmt) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') {
    const decimals = numFmt && /0\.0+/.test(numFmt) ? 3 : 0;
    const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return text.length + (value < 0 ? 1 : 0) + (numFmt && numFmt.includes('đ') ? 2 : 0);
  }
  return String(value).length;
}

/** Fit every column to its widest cell (+ padding), within sane limits. Header text counts too. */
function autofit(sheet, { min = 10, max = 52, pad = 3 } = {}) {
  sheet.columns.forEach((col, idx) => {
    let widest = 0;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value && typeof cell.value === 'object' && 'result' in cell.value ? cell.value.result : cell.value;
      const bold = cell.font && cell.font.bold ? 1.12 : 1;
      widest = Math.max(widest, shownLength(v, cell.numFmt) * bold);
    });
    sheet.getColumn(idx + 1).width = Math.min(max, Math.max(min, Math.ceil(widest * 1.1) + pad));
  });
}

function styleHeader(row) {
  row.height = 28;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border = { top: { style: 'thin', color: { argb: NAVY } }, bottom: { style: 'thin', color: { argb: NAVY } }, left: { style: 'thin', color: { argb: 'FF3B5BB0' } }, right: { style: 'thin', color: { argb: 'FF3B5BB0' } } };
  });
}

const thin = { style: 'thin', color: { argb: 'FFE0DBD2' } };
const bodyBorder = { top: thin, bottom: thin, left: thin, right: thin };

function newWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Cò Coffee';
  wb.created = new Date();
  return wb;
}

// ---------------------------------------------------------------------------------------------- export
function statusText(i) {
  if (!i.is_active) return 'Ngừng dùng';
  const q = Number(i.quantity_on_hand), m = Number(i.min_stock);
  if (q <= 0) return 'Hết hàng';
  if (m > 0 && q <= m) return 'Sắp hết';
  return 'Đủ';
}

async function exportWorkbook(items) {
  const wb = newWorkbook();
  const sheet = wb.addWorksheet('Nguyên liệu', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key }));
  styleHeader(sheet.getRow(1));

  items.forEach((i, idx) => {
    const qty = Number(i.quantity_on_hand), min = Number(i.min_stock), cost = Number(i.avg_cost);
    const row = sheet.addRow({ sku: i.sku, name: i.name, unit: i.unit, quantity: qty, min_stock: min, cost: Math.round(cost * 100) / 100, value: null, status: statusText(i) });
    const r = row.number;
    row.getCell('value').value = { formula: `ROUND(D${r}*F${r},0)`, result: Math.round(qty * cost) };
    row.getCell('quantity').numFmt = fmtQty(qty);
    row.getCell('min_stock').numFmt = fmtQty(min);
    row.getCell('cost').numFmt = fmtVnd;
    row.getCell('value').numFmt = fmtVnd;
    row.eachCell((cell, col) => {
      cell.border = bodyBorder;
      cell.alignment = { vertical: 'middle', horizontal: [4, 5, 6, 7].includes(col) ? 'right' : (col === 8 ? 'center' : 'left') };
      if (idx % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MILK } };
    });
    const status = row.getCell('status');
    if (!i.is_active) { row.font = { color: { argb: 'FF8C8478' } }; }
    else if (status.value === 'Hết hàng') { status.font = { bold: true, color: { argb: 'FFB91C1C' } }; status.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }; }
    else if (status.value === 'Sắp hết') { status.font = { bold: true, color: { argb: 'FF92400E' } }; status.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } }; }
    else { status.font = { color: { argb: 'FF047857' } }; }
  });

  if (items.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: items.length + 1, column: COLUMNS.length } };
  autofit(sheet);

  // Summary sheet: totals computed by Excel from the list so they follow any edit.
  const sum = wb.addWorksheet('Tổng hợp');
  const last = items.length + 1;
  const active = items.filter((i) => i.is_active);
  sum.addRows([
    ['Báo cáo tồn kho', null],
    ['Xuất lúc', new Date()],
    [null, null],
    ['Số mặt hàng', { formula: `COUNTA('Nguyên liệu'!A2:A${Math.max(last, 2)})`, result: items.length }],
    ['Đang dùng', active.length],
    ['Sắp hết / hết hàng', items.filter((i) => ['Sắp hết', 'Hết hàng'].includes(statusText(i))).length],
    ['Tổng giá trị tồn (đ)', { formula: `SUM('Nguyên liệu'!G2:G${Math.max(last, 2)})`, result: Math.round(items.reduce((s, i) => s + Number(i.stock_value || 0), 0)) }],
  ]);
  sum.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
  sum.getCell('B2').numFmt = 'dd/mm/yyyy hh:mm';
  sum.getCell('B7').numFmt = fmtVnd;
  for (let r = 4; r <= 7; r++) { sum.getCell(`A${r}`).font = { bold: true }; sum.getCell(`B${r}`).alignment = { horizontal: 'right' }; }
  sum.getCell('A7').font = { bold: true, color: { argb: NAVY } };
  autofit(sum, { min: 14, max: 40 });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------------------------- template
async function templateWorkbook() {
  const wb = newWorkbook();
  const sheet = wb.addWorksheet('Nhập nguyên liệu', { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = [
    { key: 'sku', header: 'SKU' }, { key: 'name', header: 'Tên nguyên liệu' }, { key: 'unit', header: 'Đơn vị' },
    { key: 'quantity', header: 'Tồn kho' }, { key: 'min_stock', header: 'Tồn tối thiểu' }, { key: 'cost', header: 'Giá vốn (đ/đơn vị)' }, { key: 'status', header: 'Trạng thái' },
  ];
  sheet.columns = cols.map((c) => ({ header: c.header, key: c.key }));
  styleHeader(sheet.getRow(1));
  [['RM-COFFEE', 'Cà phê rang xay', 'g', 5000, 1000, 280, 'Đang dùng'], ['RM-MILK', 'Sữa tươi', 'ml', 3000, 500, 30, 'Đang dùng'], ['RM-OLD', 'Nguyên liệu ngừng bán', 'g', 0, 0, null, 'Ngừng dùng']].forEach((r) => {
    const row = sheet.addRow(r);
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.border = bodyBorder;
      cell.alignment = { vertical: 'middle', horizontal: [4, 5, 6].includes(col) ? 'right' : 'left' };
      cell.font = { italic: true, color: { argb: 'FF6B737A' } };
    });
    row.getCell(4).numFmt = '#,##0'; row.getCell(5).numFmt = '#,##0'; row.getCell(6).numFmt = fmtVnd;
  });
  autofit(sheet);

  const help = wb.addWorksheet('Hướng dẫn');
  help.addRows([
    ['Cách nhập nguyên liệu bằng Excel'],
    [null],
    ['1. Mỗi dòng là một nguyên liệu, nhận diện theo cột SKU (không phân biệt hoa thường).'],
    ['2. SKU đã có trong hệ thống: cập nhật tên, đơn vị, tồn tối thiểu, trạng thái; nếu "Tồn kho" khác số hiện tại thì ghi một lần kiểm kê.'],
    ['3. SKU chưa có: tạo nguyên liệu mới. Nếu có "Tồn kho" > 0 thì bắt buộc nhập "Giá vốn" để ghi tồn đầu kỳ.'],
    ['4. Cột "Giá vốn" chỉ dùng cho nguyên liệu mới. Muốn đổi giá vốn bình quân của hàng đã có, hãy dùng chức năng Nhập kho.'],
    ['5. Cột "Trạng thái": ghi "Ngừng dùng" để ẩn nguyên liệu, để trống hoặc "Đang dùng" để giữ hoạt động.'],
    ['6. Hệ thống cho xem trước kết quả và báo lỗi từng dòng trước khi áp dụng. Tối đa ' + MAX_ROWS + ' dòng, file không quá 5 MB.'],
    ['7. File xuất từ trang này nhập lại được ngay: các cột tính toán (Giá trị tồn, Tình trạng) được bỏ qua.'],
  ]);
  help.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
  autofit(help, { min: 20, max: 120 });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------------------------- import
const cellValue = (cell) => {
  let v = cell && cell.value;
  if (v && typeof v === 'object') {
    if ('result' in v) v = v.result;
    else if ('richText' in v) v = v.richText.map((p) => p.text).join('');
    else if ('text' in v) v = v.text;
    else if (v instanceof Date) v = v.toISOString();
  }
  return v === undefined ? null : v;
};

/** Number from a cell: real numbers as they are; text like "1.234,5", "1,234.5" or "5 000" is understood. NaN when not a number. */
function toNumber(v) {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/[\s  đ₫]/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return NaN;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma) === lastDot ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    s = /,\d{3}$/.test(s) && s.split(',').length > 1 && !/^\d+,\d{1,2}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

async function parseSheet(buffer) {
  if (!buffer || !buffer.length) throw new AppError(400, 'VALIDATION', 'File trống.');
  if (buffer.length > MAX_BYTES) throw new AppError(413, 'TOO_LARGE', 'File quá lớn (tối đa 5 MB).');
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new AppError(400, 'VALIDATION', 'Đây không phải file Excel .xlsx. Hãy lưu file ở định dạng .xlsx.');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (_) { throw new AppError(400, 'VALIDATION', 'Không đọc được file Excel. Hãy dùng file .xlsx hợp lệ.'); }
  const sheet = wb.worksheets[0];
  if (!sheet) throw new AppError(400, 'VALIDATION', 'File không có trang tính nào.');

  // Header row: the first of the first 10 rows that names both SKU and name.
  let headerRow = 0; let map = null;
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const m = {};
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => { const f = ALIASES.get(fold(cellValue(cell))); if (f && !(f in m)) m[f] = col; });
    if (m.sku && m.name) { headerRow = r; map = m; break; }
  }
  if (!map) throw new AppError(400, 'VALIDATION', 'Không tìm thấy dòng tiêu đề. File cần có cột "SKU" và "Tên nguyên liệu" (tải file mẫu để xem định dạng).');

  const rows = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const get = (f) => (map[f] ? cellValue(row.getCell(map[f])) : null);
    const rec = { row: r, sku: get('sku'), name: get('name'), unit: get('unit'), quantity: get('quantity'), min_stock: get('min_stock'), cost: get('cost'), status: get('status'), has: { quantity: Boolean(map.quantity), min_stock: Boolean(map.min_stock), cost: Boolean(map.cost), unit: Boolean(map.unit), status: Boolean(map.status) } };
    const blank = [rec.sku, rec.name, rec.unit, rec.quantity, rec.min_stock, rec.cost].every((v) => v === null || String(v).trim() === '');
    if (blank) continue;
    rows.push(rec);
    if (rows.length > MAX_ROWS) throw new AppError(400, 'VALIDATION', `File có quá nhiều dòng (tối đa ${MAX_ROWS}).`);
  }
  if (!rows.length) throw new AppError(400, 'VALIDATION', 'File không có dòng dữ liệu nào.');
  return rows;
}

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const sameNum = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0005;

/**
 * Compare the file with the current items. `existing` = inventoryModel.listAll(). Nothing is written here.
 * @returns {{ creates: object[], updates: object[], counts: object[], unchanged: number, errors: {row:number,message:string}[], summary: object }}
 */
function plan(rows, existing) {
  const bySku = new Map(existing.map((i) => [String(i.sku).toLowerCase(), i]));
  const seen = new Map();
  const out = { creates: [], updates: [], counts: [], unchanged: 0, errors: [] };
  const err = (row, message) => out.errors.push({ row, message });

  for (const r of rows) {
    const sku = text(r.sku); const key = sku.toLowerCase();
    if (!sku) { err(r.row, 'Thiếu SKU.'); continue; }
    if (sku.length > 40) { err(r.row, 'SKU quá dài (tối đa 40 ký tự).'); continue; }
    if (seen.has(key)) { err(r.row, `SKU "${sku}" trùng với dòng ${seen.get(key)}.`); continue; }
    seen.set(key, r.row);

    const name = text(r.name), unit = text(r.unit);
    const num = {};
    let bad = false;
    for (const [f, label] of [['quantity', 'Tồn kho'], ['min_stock', 'Tồn tối thiểu'], ['cost', 'Giá vốn']]) {
      const n = toNumber(r[f]);
      if (Number.isNaN(n)) { err(r.row, `${label} "${text(r[f])}" không phải là số.`); bad = true; } else if (n !== null && n < 0) { err(r.row, `${label} không được âm.`); bad = true; } else num[f] = n;
    }
    if (bad) continue;
    if (name.length > 150) { err(r.row, 'Tên quá dài (tối đa 150 ký tự).'); continue; }
    if (unit.length > 20) { err(r.row, 'Đơn vị quá dài (tối đa 20 ký tự).'); continue; }
    const statusRaw = fold(r.status);
    const active = r.has.status && statusRaw ? !/^(ngung|khong|inactive|off|0|an)/.test(statusRaw) : null;   // null = leave as it is

    const cur = bySku.get(key);
    if (!cur) {
      if (!name) { err(r.row, `SKU mới "${sku}" cần có Tên nguyên liệu.`); continue; }
      if (!unit) { err(r.row, `SKU mới "${sku}" cần có Đơn vị.`); continue; }
      if ((num.quantity || 0) > 0 && !(num.cost > 0)) { err(r.row, `SKU mới "${sku}" có tồn kho nên cần nhập Giá vốn (đ/đơn vị).`); continue; }
      out.creates.push({ row: r.row, sku, name, unit, min_stock: num.min_stock || 0, quantity: num.quantity || 0, cost: num.cost || 0, is_active: active === null ? 1 : (active ? 1 : 0) });
      continue;
    }

    const changes = [];
    const patch = {};
    if (name && name !== cur.name) { patch.name = name; changes.push(`tên: ${cur.name} → ${name}`); }
    if (unit && unit !== cur.unit) { patch.unit = unit; changes.push(`đơn vị: ${cur.unit} → ${unit}`); }
    if (r.has.min_stock && num.min_stock !== null && !sameNum(num.min_stock, cur.min_stock)) { patch.min_stock = num.min_stock; changes.push(`tối thiểu: ${cur.min_stock} → ${num.min_stock}`); }
    if (active !== null && active !== Boolean(cur.is_active)) { patch.is_active = active ? 1 : 0; changes.push(active ? 'dùng lại' : 'ngừng dùng'); }
    let counted = false;
    if (r.has.quantity && num.quantity !== null && !sameNum(num.quantity, cur.quantity_on_hand)) {
      out.counts.push({ row: r.row, id: cur.id, sku: cur.sku, name: cur.name, from: Number(cur.quantity_on_hand), to: num.quantity });
      counted = true;
    }
    if (Object.keys(patch).length) out.updates.push({ row: r.row, id: cur.id, sku: cur.sku, name: cur.name, patch, changes });
    else if (!counted) out.unchanged += 1;
  }
  out.summary = { rows: rows.length, creates: out.creates.length, updates: out.updates.length, counts: out.counts.length, unchanged: out.unchanged, errors: out.errors.length };
  return out;
}

module.exports = { exportWorkbook, templateWorkbook, parseSheet, plan, toNumber, MAX_BYTES, MAX_ROWS };
