const supplierModel = require('../../models/supplierModel');
const purchaseModel = require('../../models/purchaseModel');
const purchaseService = require('../../services/purchaseService');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render, formFlag, optional } = require('./common');

const PAGE_SIZE = 20;

/** Suppliers: what we bought from each, what is paid, what is still owed. ?q= &debt=1 &page= */
async function page(req, res) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';
  const onlyDebt = req.query.debt === '1';
  const total = await supplierModel.count({ q, onlyDebt });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageNo = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const [rows, totals] = await Promise.all([
    supplierModel.list({ q, onlyDebt, limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE }),
    supplierModel.totals(),
  ]);
  const url = (n, debt) => {
    const p = new URLSearchParams();
    if (debt) p.set('debt', '1');
    if (q) p.set('q', q);
    if (n > 1) p.set('page', n);
    const s = p.toString();
    return `/admin/suppliers${s ? `?${s}` : ''}`;
  };
  await render(res, 'suppliers', {
    title: 'Nhà cung cấp', activeMenu: 'suppliers', breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Nhà cung cấp' }],
  }, { rows, totals, q, onlyDebt, total, page: pageNo, pages, pageSize: PAGE_SIZE, pageUrl: (n) => url(n, onlyDebt), tabUrl: (debt) => url(1, debt) });
}

/** One supplier: summary, its receipts, its payments, and the "Trả nợ" form. */
async function detail(req, res) {
  const id = v.id(req.params.id);
  const supplier = await supplierModel.getById(id);
  if (!supplier) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nhà cung cấp.');
  const [receipts, payments] = await Promise.all([purchaseModel.listReceipts({ supplierId: id, limit: 50 }), purchaseModel.supplierPayments(id, 30)]);
  await render(res, 'supplier_detail', {
    title: supplier.name, activeMenu: 'suppliers',
    breadcrumbs: [{ label: 'Nhà cung cấp', href: '/admin/suppliers' }, { label: supplier.name }],
  }, { supplier, receipts, payments, methods: purchaseService.METHODS });
}

function readFields(b) {
  return {
    name: v.str(b.name, 'Tên nhà cung cấp', { max: 120 }),
    phone: v.str(optional(b.phone), 'Điện thoại', { max: 30, required: false }) || '',
    address: v.str(optional(b.address), 'Địa chỉ', { max: 200, required: false }) || '',
    tax_code: v.str(optional(b.tax_code), 'Mã số thuế', { max: 30, required: false }) || '',
    note: v.str(optional(b.note), 'Ghi chú', { max: 255, required: false }) || '',
  };
}

async function create(req) {
  const fields = readFields(req.body);
  const existing = await supplierModel.findByName(fields.name);
  if (existing) throw new AppError(409, 'DUPLICATE', 'Đã có nhà cung cấp tên này.');
  await supplierModel.create(fields);
  return { message: `Đã thêm nhà cung cấp ${fields.name}.` };
}

async function update(req) {
  const id = v.id(req.params.id);
  if (!(await supplierModel.getById(id))) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nhà cung cấp.');
  const fields = readFields(req.body);
  const same = await supplierModel.findByName(fields.name);
  if (same && same.id !== id) throw new AppError(409, 'DUPLICATE', 'Đã có nhà cung cấp tên này.');
  await supplierModel.update(id, { ...fields, is_active: formFlag(req.body.is_active) });
  return { message: 'Đã cập nhật nhà cung cấp.' };
}

/** Trả nợ: oldest receipts first (or one receipt when receipt_id is given). */
async function pay(req) {
  const id = v.id(req.params.id);
  const receiptId = optional(req.body.receipt_id) ? v.id(req.body.receipt_id, 'Phiếu nhập') : null;
  const r = await purchaseService.payDebt({
    supplierId: id, receiptId, amount: v.num(req.body.amount, 'Số tiền trả', { min: 1 }),
    method: v.oneOf(optional(req.body.method), 'Hình thức', purchaseService.METHODS, { required: false }) || 'cash',
    note: v.str(optional(req.body.note), 'Ghi chú', { max: 255, required: false }) || null, userId: req.user.id,
  });
  return { message: `Đã ghi nhận trả ${Math.round(r.amount).toLocaleString('vi-VN')}đ${r.debtLeft > 0 ? `, còn nợ ${Math.round(r.debtLeft).toLocaleString('vi-VN')}đ` : ', hết nợ'}.` };
}

module.exports = { page, detail, create, update, pay };
