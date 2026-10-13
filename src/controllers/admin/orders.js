const orderModel = require('../../models/orderModel');
const orderService = require('../../services/orderService');
const receiptService = require('../../services/receiptService');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { parseDay, dayBounds } = require('../../utils/shopTime');
const { render, optional } = require('./common');

const PAGE_SIZE = 25;
const STATUSES = ['draft', 'open', 'completed', 'cancelled'];
const METHODS = ['cash', 'transfer', 'card', 'other'];

const pick = (value, allowed) => (allowed.includes(value) ? value : undefined);

/** Normalise ?status=&source=&payment=&from=&to=&q=&page= (anything invalid is simply ignored). */
function readFilters(query) {
  return {
    status: pick(query.status, STATUSES),
    source: pick(query.source, ['pos', 'zalo']),
    payment: pick(query.payment, ['unpaid', 'paid']),
    from: parseDay(query.from) || '',
    to: parseDay(query.to) || '',
    q: typeof query.q === 'string' ? query.q.trim().slice(0, 30) : '',
    page: Math.max(1, Math.min(10000, parseInt(query.page, 10) || 1)),
  };
}

async function list(req, res) {
  const f = readFilters(req.query);
  const bounds = f.from || f.to ? dayBounds(f.from || f.to, f.to || f.from) : {};
  const where = {
    status: f.status, source: f.source, paymentStatus: f.payment, q: f.q || undefined,
    // "Chưa thu" means money still to collect: cancelled orders and unconfirmed Zalo drafts never will be.
    excludeStatuses: f.payment === 'unpaid' && !f.status ? ['cancelled', 'draft'] : undefined,
    from: bounds.from, to: bounds.to,
  };
  const total = await orderModel.count(where);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const orders = await orderModel.list({ ...where, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

  const params = new URLSearchParams();
  for (const k of ['status', 'source', 'payment', 'from', 'to', 'q']) if (f[k]) params.set(k, f[k]);
  const pageUrl = (n) => {
    const p = new URLSearchParams(params);
    if (n > 1) p.set('page', n);
    const s = p.toString();
    return `/admin/orders${s ? `?${s}` : ''}`;
  };

  await render(res, 'orders', {
    title: 'Đơn hàng', activeMenu: 'orders', breadcrumbs: [{ label: 'Vận hành', href: '#' }, { label: 'Đơn hàng' }],
  }, { orders, filters: f, total, page, pages, pageSize: PAGE_SIZE, pageUrl, hasFilter: [...params.keys()].length > 0 });
}

async function detail(req, res) {
  const id = v.id(req.params.id);
  const order = await orderService.getWithItems(id);
  const payments = await orderModel.getPayments(id);
  await render(res, 'order_detail', {
    title: order.order_code || `Đơn #${id}`, activeMenu: 'orders',
    breadcrumbs: [{ label: 'Đơn hàng', href: '/admin/orders' }, { label: order.order_code || `#${id}` }],
  }, { order, payments });
}

async function cancel(req) {
  const order = await orderService.cancelOrder(v.id(req.params.id));
  return { message: `Đã hủy đơn ${order.order_code}.` };
}

async function pay(req) {
  const id = v.id(req.params.id);
  const result = await orderService.payOrder(id, {
    method: v.oneOf(req.body.method, 'Hình thức thanh toán', METHODS),
    reference: v.str(optional(req.body.reference), 'Mã tham chiếu', { max: 100, required: false }),
    discount: v.num(optional(req.body.discount), 'Giảm giá', { required: false }),
    userId: req.user.id,
  });
  return { message: `Đã ghi nhận thanh toán đơn ${result.order.order_code}.` };
}

async function resendReceipt(req) {
  const id = v.id(req.params.id);
  const order = await orderModel.getById(id);
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng.');
  if (order.source !== 'zalo' || order.status !== 'completed') throw new AppError(409, 'NOT_APPLICABLE', 'Chỉ đơn Zalo đã hoàn tất mới có bill Zalo.');
  const r = await receiptService.sendReceipt(id);
  if (!r.sent) throw new AppError(502, 'ZALO_FAILED', `Gửi bill thất bại: ${r.error}`);
  return { message: `Đã gửi lại bill ${order.order_code} qua Zalo.` };
}

module.exports = { list, detail, cancel, pay, resendReceipt, readFilters, PAGE_SIZE };
