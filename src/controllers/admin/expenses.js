const expenseModel = require('../../models/expenseModel');
const mediaModel = require('../../models/mediaModel');
const expenseService = require('../../services/expenseService');
const supplierModel = require('../../models/supplierModel');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { parseDay, shopDay } = require('../../utils/shopTime');
const { render, formFlag, optional } = require('./common');

const PAGE_SIZE = 20;
const TREATMENTS = [
  { code: 'deductible', label: 'Được trừ khi tính thuế' },
  { code: 'non_deductible', label: 'Không được trừ' },
  { code: 'capex', label: 'Tài sản / thiết bị (khấu hao)' },
];

/** Sổ chi phí. ?from= &to= (default: this month) &all=1 &cat= &src=manual|purchase &q= &void=1 &page= */
async function list(req, res) {
  const today = shopDay();
  const monthStart = `${today.slice(0, 8)}01`;
  const all = req.query.all === '1';
  const from = all ? '' : (parseDay(req.query.from) || (req.query.to ? '' : monthStart));
  const to = all ? '' : (parseDay(req.query.to) || (req.query.from ? '' : today));
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';
  const categoryId = Number(req.query.cat) || 0;
  const source = ['manual', 'purchase'].includes(req.query.src) ? req.query.src : '';
  const showVoid = req.query.void === '1';
  const filter = { q: q || undefined, categoryId: categoryId || undefined, from: from || undefined, to: to || undefined, source: source || undefined, status: showVoid ? undefined : 'posted' };

  const [categories, sums, split] = await Promise.all([
    expenseModel.listCategories({ activeOnly: true }),
    expenseModel.totals(filter),
    from || to ? expenseModel.byCategory({ from: from || '2000-01-01', to: to || '2999-12-31' }) : expenseModel.byCategory({ from: '2000-01-01', to: '2999-12-31' }),
  ]);
  const pages = Math.max(1, Math.ceil(sums.n / PAGE_SIZE));
  const pageNo = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const rows = await expenseModel.list({ ...filter, limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE });

  const url = (n, over = {}) => {
    const f = { all, from, to, cat: categoryId, src: source, q, void: showVoid, ...over };
    const p = new URLSearchParams();
    if (f.all) p.set('all', '1'); else { if (f.from && f.from !== monthStart) p.set('from', f.from); if (f.to && f.to !== today) p.set('to', f.to); }
    if (f.cat) p.set('cat', f.cat);
    if (f.src) p.set('src', f.src);
    if (f.q) p.set('q', f.q);
    if (f.void) p.set('void', '1');
    if (n > 1) p.set('page', n);
    const s = p.toString();
    return `/admin/expenses${s ? `?${s}` : ''}`;
  };
  await render(res, 'expenses', {
    title: 'Sổ chi phí', activeMenu: 'expenses', breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Sổ chi phí' }],
  }, {
    rows, sums, split, categories, suppliers: await supplierModel.options(), treatments: TREATMENTS,
    from, to, all, q, categoryId, source, showVoid, today, monthStart, total: sums.n, page: pageNo, pages, pageSize: PAGE_SIZE,
    pageUrl: (n) => url(n), linkTo: (over) => url(1, over),
  });
}

function readFields(b) {
  return {
    expenseDate: v.str(b.expense_date, 'Ngày chi', { max: 10 }),
    categoryId: v.id(b.category_id, 'Danh mục'),
    amount: v.num(b.amount, 'Số tiền', { min: 1 }),
    vatIncluded: formFlag(b.vat_included) === 1,
    payee: v.str(optional(b.payee), 'Người nhận / nơi chi', { max: 120, required: false }) || '',
    docNo: v.str(optional(b.doc_no), 'Số chứng từ', { max: 40, required: false }) || '',
    note: v.str(optional(b.note), 'Ghi chú', { max: 255, required: false }) || '',
    imageData: typeof b.image_data === 'string' && b.image_data ? b.image_data : undefined,
  };
}

async function create(req) {
  const f = readFields(req.body);
  const supplierId = optional(req.body.supplier_id) ? v.id(req.body.supplier_id, 'Nhà cung cấp') : null;
  const id = await expenseService.create({ ...f, supplierId, userId: req.user.id });
  return { message: `Đã ghi khoản chi #${id}: ${Math.round(f.amount).toLocaleString('vi-VN')}đ.` };
}

async function update(req) {
  const id = v.id(req.params.id);
  const b = req.body;
  if (b.source === 'purchase' || (optional(b.expense_date) === undefined && optional(b.amount) === undefined)) {      // purchase rows: category + note only
    await expenseService.update(id, { categoryId: v.id(b.category_id, 'Danh mục'), note: v.str(optional(b.note), 'Ghi chú', { max: 255, required: false }) || '', userId: req.user.id });
  } else {
    await expenseService.update(id, { ...readFields(b), removeImage: b.image_remove === '1', userId: req.user.id });
  }
  return { message: 'Đã cập nhật khoản chi.' };
}

async function voidOne(req) {
  await expenseService.voidExpense(v.id(req.params.id), { reason: req.body.reason, userId: req.user.id });
  return { message: 'Đã hủy khoản chi.' };
}

/** The invoice photo: admins only (it is a financial document, so it is not on the public /media route). */
async function receipt(req, res) {
  const e = await expenseModel.getById(v.id(req.params.id));
  if (!e || !e.receipt_media_id) throw new AppError(404, 'NOT_FOUND', 'Khoản chi này chưa có ảnh chứng từ.');
  const row = await mediaModel.get(e.receipt_media_id);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy ảnh.');
  res.set({ 'Content-Type': row.mime, 'Content-Length': String(row.bytes.length), 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.end(row.bytes);
}

// ------------------------------------------------------------------ categories
async function categories(_req, res) {
  await render(res, 'expense_categories', {
    title: 'Danh mục chi phí', activeMenu: 'expenses', breadcrumbs: [{ label: 'Sổ chi phí', href: '/admin/expenses' }, { label: 'Danh mục' }],
  }, { rows: await expenseModel.listCategories(), treatments: TREATMENTS });
}

function readCategory(b) {
  return {
    name: v.str(b.name, 'Tên danh mục', { max: 100 }),
    taxTreatment: v.oneOf(b.tax_treatment, 'Cách xử lý thuế', TREATMENTS.map((t) => t.code)),
    ledgerCode: v.str(optional(b.ledger_code), 'Mã sổ', { max: 20, required: false }) || '',
    sortOrder: v.num(optional(b.sort_order), 'Thứ tự', { min: -1000, max: 1000, integer: true, required: false }) ?? 0,
  };
}

async function createCategory(req) {
  const f = readCategory(req.body);
  const code = v.str(req.body.code, 'Mã danh mục', { max: 40 }).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!code) throw new AppError(400, 'VALIDATION', 'Mã danh mục chỉ gồm chữ không dấu, số và dấu gạch ngang.');
  if (await expenseModel.categoryByCode(code)) throw new AppError(409, 'DUPLICATE', 'Mã danh mục này đã có.');
  await expenseModel.createCategory({ code, ...f });
  return { message: `Đã thêm danh mục ${f.name}.` };
}

async function updateCategory(req) {
  const id = v.id(req.params.id);
  const cur = await expenseModel.getCategory(id);
  if (!cur) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy danh mục.');
  const f = readCategory(req.body);
  const isActive = formFlag(req.body.is_active);
  if (cur.is_system && isActive === 0 && cur.code === 'nguyen-vat-lieu') throw new AppError(409, 'SYSTEM_CATEGORY', 'Danh mục này nhận chi phí từ phiếu nhập kho nên không thể ẩn.');
  await expenseModel.updateCategory(id, { ...f, isActive });
  return { message: 'Đã cập nhật danh mục.' };
}

module.exports = { list, create, update, voidOne, receipt, categories, createCategory, updateCategory, TREATMENTS };
