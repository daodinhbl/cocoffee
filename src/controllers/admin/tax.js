const taxModel = require('../../models/taxModel');
const taxService = require('../../services/taxService');
const taxExportService = require('../../services/taxExportService');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { parseDay, shopDay } = require('../../utils/shopTime');
const { render, optional } = require('./common');

const KIND_TEXT = { month: 'Tháng', quarter: 'Quý', year: 'Năm' };
const EXPORT_TEXT = { s2a: 'Sổ doanh thu S2a-HKD', s2c: 'Sổ tồn kho S2c-HKD', revenue_book: 'Sổ doanh thu', expense_book: 'Sổ chi phí', declaration: 'Bảng kê tờ khai', bundle: 'Gói đủ các sổ' };

function params(req) {
  const kind = taxService.KINDS.includes(req.query.kind) ? req.query.kind : (taxService.KINDS.includes(req.body && req.body.kind) ? req.body.kind : 'month');
  const date = parseDay(String(req.query.date || (req.body && req.body.date) || '')) || shopDay();
  return { kind, date };
}

/** Thuế: ước tính theo kỳ, ngưỡng doanh thu, khóa kỳ, xuất sổ, cấu hình thuế suất. ?kind=month|quarter|year &date= */
async function page(req, res) {
  const { kind, date } = params(req);
  const [o, cfg, cats, rates, exportsList] = await Promise.all([
    taxService.overview(kind, date), taxService.getConfig(), taxModel.categories(), taxModel.rates(), taxModel.listExports(8),
  ]);
  const at = (p) => `/admin/tax?kind=${kind}&date=${p.from}`;
  const maxMonth = Math.max(1, ...o.months.map((m) => Math.max(m.revenue, m.expenses)));
  await render(res, 'tax', {
    title: 'Thuế', activeMenu: 'tax', breadcrumbs: [{ label: 'Phân tích', href: '#' }, { label: 'Thuế' }],
  }, {
    o, cfg, cats, rates, exports: exportsList, kind, date, kindText: KIND_TEXT, exportText: EXPORT_TEXT, exportKinds: taxExportService.KINDS,
    prevUrl: at(o.prev), nextUrl: at(o.next), kindUrl: (k) => `/admin/tax?kind=${k}&date=${o.period.from}`, maxMonth, today: shopDay(),
    canLock: o.period.to < shopDay(),
  });
}

async function lock(req) {
  const { kind, date } = params(req);
  const p = await taxService.lockPeriod(kind, date, req.user.id);
  return { message: `Đã khóa ${p.label}. Chi phí trong kỳ này không sửa được nữa cho đến khi mở khóa.`, to: `/admin/tax?kind=${kind}&date=${p.from}` };
}

async function unlock(req) {
  const { kind, date } = params(req);
  const p = await taxService.unlockPeriod(kind, date, req.user.id);
  return { message: `Đã mở khóa ${p.label}.`, to: `/admin/tax?kind=${kind}&date=${p.from}` };
}

async function filed(req) {
  const { kind, date } = params(req);
  const p = await taxService.markFiled(kind, date, req.body.ref, req.user.id);
  return { message: `Đã đánh dấu ${p.label} là đã nộp tờ khai.`, to: `/admin/tax?kind=${kind}&date=${p.from}` };
}

async function saveConfig(req) {
  await taxService.saveConfig({ exemptThreshold: req.body.exempt_threshold, pitMethod: req.body.pit_method, profitRate: Number(req.body.profit_rate_pct) / 100 }, req.user.id);
  return { message: 'Đã lưu cấu hình thuế.' };
}

async function addRate(req) {
  await taxService.addRate({
    categoryId: v.id(req.body.category_id, 'Nhóm thuế'), effectiveFrom: req.body.effective_from,
    vatRate: Number(req.body.vat_pct) / 100, pitRate: Number(req.body.pit_pct) / 100, legalBasis: optional(req.body.legal_basis), userId: req.user.id,
  });
  return { message: 'Đã thêm thuế suất. Đơn từ ngày hiệu lực trở đi dùng thuế suất mới; đơn cũ giữ nguyên.' };
}

/** Queue a book; the worker builds it in the background. */
async function createExport(req) {
  const kind = v.oneOf(req.body.export_kind, 'Loại sổ', taxExportService.KINDS);
  const r = await taxExportService.enqueue({ kind, from: req.body.from, to: req.body.to, userId: req.user.id });
  return { message: r.reused ? 'Sổ này đang được tạo, vui lòng chờ.' : `Đã xếp hàng tạo “${EXPORT_TEXT[kind]}”. Tải về ở danh sách bên dưới khi xong.` };
}

/** JSON for the page's polling while a job is running. */
async function exportsJson(_req, res) {
  const rows = await taxModel.listExports(8);
  res.set('Cache-Control', 'no-store');
  res.json({ exports: rows.map((e) => ({ id: e.id, kind: e.kind, status: e.status, error: e.error, bytes: e.file_bytes ? Number(e.file_bytes) : null, ready: e.status === 'done' && Boolean(e.file_name) })) });
}

async function download(req, res) {
  const e = await taxModel.getExport(v.id(req.params.id));
  const file = e && taxExportService.filePath(e);
  if (!file) throw new AppError(404, 'NOT_FOUND', 'File chưa sẵn sàng hoặc đã hết hạn lưu (7 ngày).');
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${e.file_name.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'Cache-Control': 'private, no-store' });
  res.sendFile(file);
}

module.exports = { page, lock, unlock, filed, saveConfig, addRate, createExport, exportsJson, download };
