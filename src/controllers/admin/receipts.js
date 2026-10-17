const purchaseModel = require('../../models/purchaseModel');
const supplierModel = require('../../models/supplierModel');
const purchaseService = require('../../services/purchaseService');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { parseDay, dayBounds, shopDay } = require('../../utils/shopTime');
const { render, optional } = require('./common');

const PAGE_SIZE = 20;

/** Lịch sử nhập kho: ?supplier= &from= &to= &q= &debt=1 &page= */
async function list(req, res) {
  const supplierId = Number(req.query.supplier) || 0;
  const from = parseDay(req.query.from) || '';
  const to = parseDay(req.query.to) || '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';
  const onlyDebt = req.query.debt === '1';
  const bounds = from || to ? dayBounds(from || to, to || from) : {};
  const filter = { supplierId: supplierId || undefined, from: bounds.from, to: bounds.to, q: q || undefined, onlyDebt };

  const [sums, suppliers] = await Promise.all([purchaseModel.countReceipts(filter), supplierModel.options()]);
  const pages = Math.max(1, Math.ceil(sums.n / PAGE_SIZE));
  const pageNo = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const rows = await purchaseModel.listReceipts({ ...filter, limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE });

  const url = (n, over = {}) => {
    const p = new URLSearchParams();
    const f = { supplier: supplierId, from, to, q, debt: onlyDebt, ...over };
    if (f.supplier) p.set('supplier', f.supplier);
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    if (f.q) p.set('q', f.q);
    if (f.debt) p.set('debt', '1');
    if (n > 1) p.set('page', n);
    const s = p.toString();
    return `/admin/receipts${s ? `?${s}` : ''}`;
  };
  await render(res, 'receipts', {
    title: 'Lịch sử nhập kho', activeMenu: 'receipts', breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Phiếu nhập' }],
  }, {
    rows, sums, suppliers, supplierId, from, to, q, onlyDebt, total: sums.n, page: pageNo, pages, pageSize: PAGE_SIZE,
    pageUrl: (n) => url(n), debtUrl: (debt) => url(1, { debt }), today: shopDay(), monthStart: `${shopDay().slice(0, 8)}01`,
  });
}

async function detail(req, res) {
  const id = v.id(req.params.id);
  const receipt = await purchaseModel.getReceipt(id);
  if (!receipt) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy phiếu nhập.');
  const [lines, payments] = await Promise.all([purchaseModel.getLines(id), purchaseModel.receiptPayments(id)]);
  await render(res, 'receipt_detail', {
    title: receipt.receipt_code || `Phiếu nhập #${id}`, activeMenu: 'receipts',
    breadcrumbs: [{ label: 'Phiếu nhập', href: '/admin/receipts' }, { label: receipt.receipt_code || `#${id}` }],
  }, { receipt, lines, payments, methods: purchaseService.METHODS });
}

/** Trả nợ cho một phiếu. */
async function pay(req) {
  const id = v.id(req.params.id);
  const receipt = await purchaseModel.getReceipt(id);
  if (!receipt) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy phiếu nhập.');
  if (!receipt.supplier_id) throw new AppError(409, 'NO_SUPPLIER', 'Phiếu mua lẻ không có nhà cung cấp nên không có công nợ.');
  const r = await purchaseService.payDebt({
    supplierId: receipt.supplier_id, receiptId: id, amount: v.num(req.body.amount, 'Số tiền trả', { min: 1 }),
    method: v.oneOf(optional(req.body.method), 'Hình thức', purchaseService.METHODS, { required: false }) || 'cash',
    note: v.str(optional(req.body.note), 'Ghi chú', { max: 255, required: false }) || null, userId: req.user.id,
  });
  return { message: `Đã ghi nhận trả ${Math.round(r.amount).toLocaleString('vi-VN')}đ cho ${receipt.receipt_code}${r.debtLeft > 0 ? `, còn nợ ${Math.round(r.debtLeft).toLocaleString('vi-VN')}đ` : ', đã trả đủ'}.` };
}

module.exports = { list, detail, pay };
