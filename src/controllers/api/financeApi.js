const expenseModel = require('../../models/expenseModel');
const mediaModel = require('../../models/mediaModel');
const taxModel = require('../../models/taxModel');
const expenseService = require('../../services/expenseService');
const taxService = require('../../services/taxService');
const taxExportService = require('../../services/taxExportService');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { parseDay, shopDay } = require('../../utils/shopTime');

/**
 * Expense book, tax estimate and tax-book exports for the app (admin only; mounted in routes/apiFinanceRoutes.js).
 * JSON is snake_case like the rest of /api. Money is a plain number in VND. Dates are "YYYY-MM-DD" (shop calendar).
 */
const day = (d) => String(d).slice(0, 10);
const optionalStr = (x) => (typeof x === 'string' && x.trim() !== '' ? x : undefined);

const categoryView = (c) => ({ id: c.id, code: c.code, name: c.name, tax_treatment: c.tax_treatment, ledger_code: c.ledger_code || null, is_active: Boolean(c.is_active) });

function expenseView(e) {
  return {
    id: e.id, date: day(e.expense_date), category_id: e.category_id, category: e.category_name, tax_treatment: e.tax_treatment,
    amount: Number(e.amount), vat_included: Boolean(e.vat_included), payee: e.payee || '', doc_no: e.doc_no || '', note: e.note || '',
    source: e.source, status: e.status, void_reason: e.void_reason || null, has_receipt: Boolean(e.receipt_media_id),
    purchase_receipt_id: e.purchase_receipt_id || null, purchase_receipt_code: e.receipt_code || null, created_by: e.user_name || null, created_at: e.created_at,
  };
}

// ------------------------------------------------------------------ categories & expenses
/** GET /api/expense-categories[?all=1] -> { categories } */
async function categories(req, res) {
  const rows = await expenseModel.listCategories({ activeOnly: req.query.all !== '1' });
  res.json({ categories: rows.map(categoryView) });
}

/**
 * GET /api/expenses?from=&to=&cat=&src=manual|purchase&q=&void=1&before_id=&limit=30
 *   -> { items, next_before_id (null at the end), totals: { count, amount, purchases, manual, deductible } }
 * Newest first by id; pass next_before_id as before_id for the next page. totals follow the same filters.
 */
async function listExpenses(req, res) {
  const q = req.query;
  const filter = {
    q: optionalStr(q.q) && String(q.q).trim().slice(0, 40),
    categoryId: Number(q.cat) || undefined,
    from: parseDay(String(q.from || '')) || undefined,
    to: parseDay(String(q.to || '')) || undefined,
    source: ['manual', 'purchase'].includes(q.src) ? q.src : undefined,
    status: q.void === '1' ? undefined : 'posted',
  };
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 30));
  const beforeId = Number(q.before_id) || undefined;
  const [rows, sums] = await Promise.all([expenseModel.listPage({ ...filter, beforeId, limit: limit + 1 }), expenseModel.totals(filter)]);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(expenseView);
  res.json({
    items, next_before_id: more ? items[items.length - 1].id : null,
    totals: { count: sums.n, amount: sums.amount, purchases: sums.purchases, manual: sums.manual, deductible: sums.deductible },
  });
}

function fields(b) {
  return {
    expenseDate: v.str(b.expense_date, 'expense_date', { max: 10 }),
    categoryId: v.id(b.category_id, 'category_id'),
    amount: v.num(b.amount, 'amount', { min: 1 }),
    vatIncluded: b.vat_included === true || b.vat_included === 1 || b.vat_included === '1',
    payee: v.str(optionalStr(b.payee), 'payee', { max: 120, required: false }) || '',
    docNo: v.str(optionalStr(b.doc_no), 'doc_no', { max: 40, required: false }) || '',
    note: v.str(optionalStr(b.note), 'note', { max: 255, required: false }) || '',
    imageData: typeof b.image_data === 'string' && b.image_data ? b.image_data : undefined,
  };
}

/** POST /api/expenses { expense_date, category_id, amount, vat_included?, payee?, doc_no?, note?, supplier_id?, image_data? (JPEG/PNG data URL, <= 600 KB) } -> 201 { expense } */
async function createExpense(req, res) {
  const supplierId = req.body.supplier_id ? v.id(req.body.supplier_id, 'supplier_id') : null;
  const id = await expenseService.create({ ...fields(req.body), supplierId, userId: req.user.id });
  res.status(201).json({ expense: expenseView(await expenseModel.getById(id)) });
}

/** PUT /api/expenses/:id (same fields; remove_image: true drops the photo). Rows booked from a stock receipt only take category_id and note. -> { expense } */
async function updateExpense(req, res) {
  const id = v.id(req.params.id);
  const current = await expenseModel.getById(id);
  if (!current) throw new AppError(404, 'NOT_FOUND', 'Expense not found');
  if (current.source === 'purchase') {
    await expenseService.update(id, { categoryId: v.id(req.body.category_id, 'category_id'), note: v.str(optionalStr(req.body.note), 'note', { max: 255, required: false }) || '', userId: req.user.id });
  } else {
    await expenseService.update(id, { ...fields(req.body), removeImage: req.body.remove_image === true, userId: req.user.id });
  }
  res.json({ expense: expenseView(await expenseModel.getById(id)) });
}

/** POST /api/expenses/:id/void { reason } -> { expense } */
async function voidExpense(req, res) {
  const id = v.id(req.params.id);
  await expenseService.voidExpense(id, { reason: req.body.reason, userId: req.user.id });
  res.json({ expense: expenseView(await expenseModel.getById(id)) });
}

/** GET /api/expenses/:id/receipt -> the photo (needs the bearer token, so the app loads it with the Authorization header) */
async function receipt(req, res) {
  const e = await expenseModel.getById(v.id(req.params.id));
  if (!e || !e.receipt_media_id) throw new AppError(404, 'NOT_FOUND', 'No receipt photo');
  const row = await mediaModel.get(e.receipt_media_id);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'No receipt photo');
  res.set({ 'Content-Type': row.mime, 'Content-Length': String(row.bytes.length), 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.end(row.bytes);
}

// ------------------------------------------------------------------ tax
const round = (n) => Math.round(Number(n) || 0);

function periodView(p) { return { kind: p.kind, from: p.from, to: p.to, label: p.label }; }

function estimateView(e) {
  return {
    from: e.from, to: e.to,
    categories: e.categories.map((c) => ({ id: c.categoryId, name: c.name, net_revenue: round(c.net), discount: round(c.discount), vat: round(c.vat), pit: round(c.pit) })),
    revenue: { gross: round(e.revenue.gross), discount: round(e.revenue.discount), net: round(e.revenue.net) },
    expenses: { deductible: round(e.expenses.deductible), non_deductible: round(e.expenses.non_deductible), capex: round(e.expenses.capex), total: round(e.expenses.total) },
    profit: round(e.profit),
    year: { before: round(e.year.before), through: round(e.year.through), threshold: round(e.year.threshold), exempt: e.year.exempt, remaining: round(e.year.remaining) },
    taxable_revenue: round(e.taxableRevenue),
    config: { exempt_threshold: round(e.config.exemptThreshold), pit_method: e.config.pitMethod, profit_rate: e.config.profitRate },
    vat: e.vat, pit: e.pit, tax: e.tax,
  };
}

/**
 * GET /api/finance/dashboard?kind=month|quarter|year&date=YYYY-MM-DD (default: this month)
 *   -> { period, prev, next, estimate, lock: null | { status, locked_at, filed_ref }, months: [{ month, revenue, expenses }], estimated: true }
 * Everything is read from the daily rollups, so it is cheap to call on every screen open.
 */
async function dashboard(req, res) {
  const kind = taxService.KINDS.includes(req.query.kind) ? req.query.kind : 'month';
  const o = await taxService.overview(kind, parseDay(String(req.query.date || '')) || shopDay());
  res.json({
    estimated: true, period: periodView(o.period), prev: periodView(o.prev), next: periodView(o.next), estimate: estimateView(o.estimate),
    lock: o.lock ? { status: o.lock.status, locked_at: o.lock.lockedAt, filed_ref: o.lock.filedRef } : null,
    months: o.months.map((m) => ({ month: m.month, revenue: round(m.revenue), expenses: round(m.expenses) })),
  });
}

function periodBody(req) {
  const kind = v.oneOf(req.body.kind, 'kind', taxService.KINDS);
  return { kind, date: parseDay(String(req.body.date || '')) || shopDay() };
}

/** POST /api/tax/periods/lock { kind, date }: a finished period only. -> { period } */
async function lockPeriod(req, res) {
  const { kind, date } = periodBody(req);
  res.json({ period: periodView(await taxService.lockPeriod(kind, date, req.user.id)) });
}

/** POST /api/tax/periods/unlock { kind, date } -> { period } (not after it was marked filed) */
async function unlockPeriod(req, res) {
  const { kind, date } = periodBody(req);
  res.json({ period: periodView(await taxService.unlockPeriod(kind, date, req.user.id)) });
}

/** POST /api/tax/periods/filed { kind, date, ref } -> { period } */
async function markFiled(req, res) {
  const { kind, date } = periodBody(req);
  res.json({ period: periodView(await taxService.markFiled(kind, date, req.body.ref, req.user.id)) });
}

/** GET /api/tax/rates -> { rates: [{ category, effective_from, effective_to, vat_rate, pit_rate, legal_basis }], config } */
async function rates(_req, res) {
  const [rows, cfg] = await Promise.all([taxModel.rates(), taxService.getConfig()]);
  res.json({
    rates: rows.map((r) => ({ category: r.category_name, code: r.code, effective_from: day(r.effective_from), effective_to: r.effective_to ? day(r.effective_to) : null, vat_rate: Number(r.vat_rate), pit_rate: Number(r.pit_rate), legal_basis: r.legal_basis || null })),
    config: { exempt_threshold: round(cfg.exemptThreshold), pit_method: cfg.pitMethod, profit_rate: cfg.profitRate },
  });
}

// ------------------------------------------------------------------ exports
function exportView(e) {
  return {
    id: e.id, kind: e.kind, from: day(e.period_from), to: day(e.period_to), status: e.status, file_name: e.file_name || null, file_bytes: e.file_bytes ? Number(e.file_bytes) : null,
    error: e.error || null, created_at: e.created_at, finished_at: e.finished_at || null, expires_at: e.expires_at || null, downloadable: e.status === 'done' && Boolean(e.file_name),
  };
}

/** POST /api/tax/exports { kind: revenue_book|expense_book|declaration|bundle, from, to } -> 202 { export } (reused: true when the same job is already waiting) */
async function createExport(req, res) {
  const kind = v.oneOf(req.body.kind, 'kind', taxExportService.KINDS);
  const r = await taxExportService.enqueue({ kind, from: req.body.from, to: req.body.to, userId: req.user.id });
  res.status(202).json({ export: exportView(await taxModel.getExport(r.id)), reused: r.reused });
}

/** GET /api/tax/exports -> { exports } newest first */
async function listExports(_req, res) {
  res.json({ exports: (await taxModel.listExports(20)).map(exportView) });
}

/** GET /api/tax/exports/:id -> { export } (poll until status is done / failed; every 3 s is plenty) */
async function getExport(req, res) {
  const e = await taxModel.getExport(v.id(req.params.id));
  if (!e) throw new AppError(404, 'NOT_FOUND', 'Export not found');
  res.json({ export: exportView(e) });
}

/** GET /api/tax/exports/:id/file -> the .xlsx (bearer token) */
async function exportFile(req, res) {
  const e = await taxModel.getExport(v.id(req.params.id));
  const file = e && taxExportService.filePath(e);
  if (!file) throw new AppError(404, 'NOT_FOUND', 'The file is not ready, or it has expired');
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${e.file_name.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'Cache-Control': 'private, no-store' });
  res.sendFile(file);
}

module.exports = {
  categories, listExpenses, createExpense, updateExpense, voidExpense, receipt,
  dashboard, lockPeriod, unlockPeriod, markFiled, rates, createExport, listExports, getExport, exportFile,
  expenseView, estimateView, exportView,
};
