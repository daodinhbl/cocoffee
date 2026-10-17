const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const env = require('../config/env');
const taxModel = require('../models/taxModel');
const expenseModel = require('../models/expenseModel');
const taxService = require('./taxService');
const { AppError } = require('../utils/httpError');
const { parseDay, addDays, shopDay } = require('../utils/shopTime');
const logger = require('../utils/logger');

/**
 * Tax books as Excel files, built OUT of the request: a request only queues a row in tax_exports and answers at once;
 * a single worker (one job at a time) writes the file with exceljs' streaming writer, so memory stays flat whatever
 * the number of rows, then the app shows the job as done and the file can be downloaded for 7 days.
 *   revenue_book  Sổ doanh thu (per day, per tax group)       expense_book  Sổ chi phí (every posted expense)
 *   declaration   Bảng kê tờ khai (estimate of the period)    bundle        all three sheets in one workbook
 * Everything is an ESTIMATE to prepare the declaration; every sheet says so.
 */
const KINDS = ['revenue_book', 'expense_book', 'declaration', 'bundle'];
const KIND_LABEL = { revenue_book: 'so-doanh-thu', expense_book: 'so-chi-phi', declaration: 'bang-ke-to-khai', bundle: 'so-thue' };
const MAX_DAYS = 366;
const POLL_MS = 5000;
const NUM = '#,##0';
const TREATMENT = { deductible: 'Được trừ', non_deductible: 'Không được trừ', capex: 'Thiết bị (khấu hao)' };

// ------------------------------------------------------------------ queue
async function enqueue({ kind, from, to, userId }) {
  if (!KINDS.includes(kind)) throw new AppError(400, 'VALIDATION', 'Loại sổ không hợp lệ.');
  const a = parseDay(String(from || ''));
  const b = parseDay(String(to || ''));
  if (!a || !b || a > b) throw new AppError(400, 'VALIDATION', 'Khoảng ngày không hợp lệ.');
  if (b > shopDay()) throw new AppError(400, 'VALIDATION', 'Ngày kết thúc không được ở tương lai.');
  if (addDays(a, MAX_DAYS) < b) throw new AppError(400, 'VALIDATION', 'Mỗi lần xuất tối đa một năm.');
  const open = await taxModel.findOpenExport(kind, a, b);
  if (open) return { id: open.id, reused: true };                  // a second click returns the job already waiting
  return { id: await taxModel.insertExport({ kind, from: a, to: b, userId }), reused: false };
}

// ------------------------------------------------------------------ sheets
const dmy = (d) => String(d).slice(0, 10).split('-').reverse().join('/');

function header(ws, title, p, shop, period) {
  ws.addRow([shop.name.toUpperCase()]).font = { bold: true, size: 13 };
  ws.addRow([`Chủ hộ: ${shop.ownerName || '—'}   ·   MST: ${shop.taxCode || '—'}   ·   ĐKKD: ${shop.regNo || '—'}`]);
  ws.addRow([`Địa chỉ: ${shop.address || '—'}`]);
  ws.addRow([]);
  const t = ws.addRow([title]);
  t.font = { bold: true, size: 14 };
  ws.addRow([`Kỳ: ${dmy(period.from)} → ${dmy(period.to)}`]);
  ws.addRow([`Số liệu ƯỚC TÍNH để chuẩn bị kê khai. Kế toán xác nhận trước khi nộp. Lập ngày ${dmy(shopDay())}.`]).font = { italic: true, color: { argb: 'FF666666' } };
  ws.addRow([]);
  for (let i = 1; i <= 7; i += 1) ws.getRow(i).commit();
}

function headRow(ws, labels) {
  const r = ws.addRow(labels);
  r.font = { bold: true };
  r.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  r.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEA' } }; c.border = { bottom: { style: 'thin' } }; });
  r.commit();
}

async function revenueSheet(wb, period, shop) {
  const ws = wb.addWorksheet('Sổ doanh thu');
  const cats = (await taxModel.categories()).filter((c) => c.code !== 'none');
  const allRows = await taxModel.revenueRows(period.from, period.to);
  header(ws, 'SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ', {}, shop, period);
  headRow(ws, ['Ngày', 'Số dòng bán', ...cats.map((c) => `Doanh thu thuần: ${c.name}`), 'Giảm giá đã cho', 'Doanh thu thuần', 'GTGT ước tính', 'TNCN ước tính (theo tỷ lệ)']);
  const byDay = new Map();
  for (const r of allRows) {
    const d = byDay.get(r.day) || { lines: 0, discount: 0, net: 0, vat: 0, pit: 0, cat: new Map() };
    d.lines += r.lines; d.discount += r.discount; d.net += r.net; d.vat += r.vat; d.pit += r.pit;
    d.cat.set(r.categoryId, (d.cat.get(r.categoryId) || 0) + r.net);
    byDay.set(r.day, d);
  }
  const tot = { lines: 0, discount: 0, net: 0, vat: 0, pit: 0, cat: new Map() };
  for (const [day, d] of [...byDay].sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = ws.addRow([dmy(day), d.lines, ...cats.map((c) => d.cat.get(c.id) || 0), d.discount, d.net, Math.round(d.vat), Math.round(d.pit)]);
    row.eachCell((c, i) => { if (i > 1) c.numFmt = NUM; });
    row.commit();
    tot.lines += d.lines; tot.discount += d.discount; tot.net += d.net; tot.vat += d.vat; tot.pit += d.pit;
    for (const c of cats) tot.cat.set(c.id, (tot.cat.get(c.id) || 0) + (d.cat.get(c.id) || 0));
  }
  const total = ws.addRow(['Cộng', tot.lines, ...cats.map((c) => tot.cat.get(c.id) || 0), tot.discount, tot.net, Math.round(tot.vat), Math.round(tot.pit)]);
  total.font = { bold: true };
  total.eachCell((c, i) => { if (i > 1) c.numFmt = NUM; c.border = { top: { style: 'thin' } }; });
  total.commit();
  ws.addRow(['Thuế ở sổ này là thuế tính trên toàn bộ doanh thu; phần được miễn theo ngưỡng doanh thu năm xem ở “Bảng kê tờ khai”.']).commit();
  ws.columns.forEach((col, i) => { col.width = i === 0 ? 14 : 18; });
  await ws.commit();
}

async function expenseSheet(wb, period, shop) {
  const ws = wb.addWorksheet('Sổ chi phí');
  header(ws, 'SỔ CHI PHÍ SẢN XUẤT, KINH DOANH', {}, shop, period);
  headRow(ws, ['STT', 'Ngày', 'Danh mục', 'Mã sổ', 'Cách xử lý thuế', 'Người nhận / nơi chi', 'Số chứng từ', 'Số tiền', 'Đã gồm VAT', 'Nguồn', 'Ghi chú']);
  let after = 0;
  let n = 0;
  const totals = { deductible: 0, non_deductible: 0, capex: 0 };
  for (;;) {
    const rows = await expenseModel.exportBatch({ from: period.from, to: period.to, afterId: after, limit: 1000 });
    if (!rows.length) break;
    for (const e of rows) {
      n += 1;
      totals[e.tax_treatment] = (totals[e.tax_treatment] || 0) + Number(e.amount);
      const row = ws.addRow([n, dmy(e.expense_date), e.category_name, e.ledger_code || '', TREATMENT[e.tax_treatment] || e.tax_treatment, e.payee || '', e.doc_no || '', Number(e.amount), e.vat_included ? 'Có' : '', e.source === 'purchase' ? 'Phiếu nhập kho' : 'Nhập tay', e.note || '']);
      row.getCell(8).numFmt = NUM;
      row.commit();
    }
    after = rows[rows.length - 1].id;
    if (rows.length < 1000) break;
  }
  ws.addRow([]).commit();
  for (const [key, label] of [['deductible', 'Cộng chi phí được trừ'], ['non_deductible', 'Cộng chi phí không được trừ'], ['capex', 'Cộng thiết bị (khấu hao)']]) {
    const r = ws.addRow(['', '', '', '', label, '', '', totals[key]]);
    r.font = { bold: true }; r.getCell(8).numFmt = NUM; r.commit();
  }
  ws.columns.forEach((col, i) => { col.width = [6, 12, 28, 10, 22, 26, 14, 16, 11, 16, 36][i] || 16; });
  await ws.commit();
}

async function declarationSheet(wb, period, shop) {
  const ws = wb.addWorksheet('Bảng kê tờ khai');
  const est = await taxService.estimate(period.from, period.to);
  header(ws, 'BẢNG KÊ TÍNH THUẾ (TẠM TÍNH)', {}, shop, period);
  headRow(ws, ['Nhóm', 'Doanh thu thuần', 'GTGT (chưa trừ ngưỡng)', 'TNCN theo tỷ lệ (chưa trừ ngưỡng)']);
  for (const c of est.categories) {
    const r = ws.addRow([c.name, c.net, Math.round(c.vat), Math.round(c.pit)]);
    r.eachCell((cell, i) => { if (i > 1) cell.numFmt = NUM; });
    r.commit();
  }
  const kv = (label, value, bold = false) => {
    const r = ws.addRow([label, typeof value === 'number' ? value : String(value)]);
    if (typeof value === 'number') r.getCell(2).numFmt = NUM;
    if (bold) r.font = { bold: true };
    r.commit();
  };
  ws.addRow([]).commit();
  kv('Doanh thu thuần của kỳ', est.revenue.net);
  kv('Doanh thu lũy kế từ đầu năm (hết kỳ)', est.year.through);
  kv('Ngưỡng doanh thu không chịu thuế (cấu hình)', est.year.threshold);
  kv('Doanh thu chịu thuế của kỳ (phần vượt ngưỡng)', est.taxableRevenue);
  kv('Chi phí được trừ trong kỳ', est.expenses.deductible);
  kv('Chi phí không được trừ', est.expenses.non_deductible);
  kv('Thiết bị (khấu hao)', est.expenses.capex);
  kv('Cách tính TNCN', est.config.pitMethod === 'profit' ? `Theo lợi nhuận (${(est.config.profitRate * 100).toFixed(1)}%)` : 'Theo tỷ lệ trên doanh thu');
  ws.addRow([]).commit();
  kv('Thuế GTGT ước tính', est.vat, true);
  kv('Thuế TNCN ước tính', est.pit, true);
  kv('Tổng thuế ước tính', est.tax, true);
  ws.addRow([]).commit();
  ws.addRow(['Tỷ lệ và ngưỡng lấy từ cấu hình của cửa hàng (Quản lý > Thuế), không phải văn bản pháp luật. Cần kế toán xác nhận trước khi kê khai.']).commit();
  ws.columns.forEach((col, i) => { col.width = i === 0 ? 48 : 26; });
  await ws.commit();
}

// ------------------------------------------------------------------ worker
async function build(job) {
  const period = { from: String(job.period_from).slice(0, 10), to: String(job.period_to).slice(0, 10) };
  const profile = (await require('./shopProfile').get()).effective;
  const shop = { name: profile.name, ownerName: profile.ownerName, taxCode: profile.taxCode, regNo: profile.regNo, address: profile.address };
  await fs.promises.mkdir(env.taxExport.dir, { recursive: true });
  const fileName = `${job.id}-${KIND_LABEL[job.kind]}_${period.from}_${period.to}.xlsx`;
  const file = path.join(env.taxExport.dir, fileName);
  const tmp = `${file}.part`;
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: tmp, useStyles: true, useSharedStrings: false });
  wb.creator = 'CoCoffee POS';
  if (job.kind === 'revenue_book' || job.kind === 'bundle') await revenueSheet(wb, period, shop);
  if (job.kind === 'expense_book' || job.kind === 'bundle') await expenseSheet(wb, period, shop);
  if (job.kind === 'declaration' || job.kind === 'bundle') await declarationSheet(wb, period, shop);
  await wb.commit();
  await fs.promises.rename(tmp, file);                              // appears complete or not at all
  const { size } = await fs.promises.stat(file);
  return { fileName, fileBytes: size };
}

let running = false;
/** Takes the oldest queued job and builds it. @returns {Promise<boolean>} true when a job was processed */
async function processNext() {
  if (running) return false;
  running = true;
  let job = null;
  try {
    job = await taxModel.claimNextExport();
    if (!job) return false;
    const out = await build(job);
    await taxModel.finishExport(job.id, out);
    return true;
  } catch (err) {
    logger.error(`Tax export ${job ? job.id : '?'} failed`, err);
    if (job) await taxModel.failExport(job.id, err.message).catch(() => {});
    return !!job;
  } finally {
    running = false;
  }
}

async function cleanup() {
  for (const e of await taxModel.expiredExports()) {
    await fs.promises.rm(path.join(env.taxExport.dir, path.basename(e.file_name)), { force: true }).catch(() => {});
    await taxModel.clearExportFile(e.id);
  }
}

let timer = null;
let lastCleanup = 0;
function startWorker() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      await taxModel.requeueStale(5);
      while (await processNext()) { /* drain the queue, one job at a time */ }
      if (Date.now() - lastCleanup > 3600 * 1000) { lastCleanup = Date.now(); await cleanup(); }
    } catch (err) {
      logger.error('Tax export worker tick failed', err);
    }
  }, POLL_MS);
  timer.unref();
}

/** Absolute path of a finished export's file, or null. */
function filePath(job) {
  if (!job || job.status !== 'done' || !job.file_name) return null;
  const file = path.join(env.taxExport.dir, path.basename(job.file_name));
  return fs.existsSync(file) ? file : null;
}

module.exports = { KINDS, KIND_LABEL, enqueue, processNext, startWorker, cleanup, filePath, MAX_DAYS };
