const env = require('../config/env');
const orderModel = require('../models/orderModel');
const orderService = require('../services/orderService');
const orderQuery = require('../services/orderQueryService');
const posService = require('../services/posService');
const receiptService = require('../services/receiptService');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');
const { parseDay, dayBounds } = require('../utils/shopTime');

const METHODS = ['cash', 'transfer', 'card', 'other'];
const CASHIER_METHODS = ['cash', 'transfer', 'card'];      // 'other' (and debt settlement) is for admins

async function create(req, res) {
  const order = await orderService.createPosOrder({
    table_id: req.body.table_id ? v.id(req.body.table_id, 'table_id') : null,
    items: req.body.items || [],
    note: v.str(req.body.note, 'note', { required: false }),
    userId: req.user.id,
  });
  res.status(201).json({ order });
}

/** A query value given once (a repeated key arrives as an array). */
const single = (value, name) => {
  if (Array.isArray(value) || (value !== undefined && typeof value !== 'string')) v.fail(`${name} must be given once`);
  return value;
};

/** Optional shop day 'YYYY-MM-DD'. */
function dayParam(value, name) {
  if (single(value, name) === undefined || value === '') return undefined;
  const day = parseDay(value);
  if (!day) v.fail(`${name} must be a date YYYY-MM-DD`);
  return day;
}

/** Optional ISO-8601 timestamp (e.g. the newest updated_at the app has seen). */
function timestampParam(value, name) {
  if (single(value, name) === undefined || value === '') return undefined;
  const at = value.length <= 40 ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) v.fail(`${name} must be an ISO-8601 timestamp`);
  return at;
}

/**
 * GET /orders. Filters: status, source, payment (unpaid|paid), table_id, q (order code), date_from/date_to (shop days,
 * inclusive), from/to (raw DATETIME bounds, kept for older clients), updated_after.
 * Paging: page (+ page_size, default 25), or the older limit/offset. Always answers
 * { orders, total, page, pages, page_size, counts }.
 */
async function list(req, res) {
  const q = req.query;
  const dateFrom = dayParam(q.date_from, 'date_from');
  const dateTo = dayParam(q.date_to, 'date_to');
  let from = v.str(single(q.from, 'from'), 'from', { max: 30, required: false });
  let to = v.str(single(q.to, 'to'), 'to', { max: 30, required: false });
  if (dateFrom || dateTo) ({ from, to } = dayBounds(dateFrom || dateTo, dateTo || dateFrom));
  const search = single(q.q, 'q');
  const filter = {
    status: v.oneOf(single(q.status, 'status'), 'status', orderQuery.STATUSES, { required: false }),
    source: v.oneOf(single(q.source, 'source'), 'source', orderQuery.SOURCES, { required: false }),
    payment: v.oneOf(single(q.payment, 'payment'), 'payment', orderQuery.PAYMENTS, { required: false }),
    tableId: q.table_id ? v.id(single(q.table_id, 'table_id'), 'table_id') : undefined,
    q: search ? search.trim().slice(0, 30) : undefined,
    from, to,
    updatedAfter: timestampParam(q.updated_after, 'updated_after'),
  };

  if (q.page !== undefined) {
    const page = v.num(single(q.page, 'page'), 'page', { min: 1, max: 10000, integer: true });
    const pageSize = q.page_size === undefined ? orderQuery.PAGE_SIZE : v.num(single(q.page_size, 'page_size'), 'page_size', { min: 1, max: 100, integer: true });
    const r = await orderQuery.page(filter, { page, pageSize });
    return res.json({ orders: r.orders, total: r.total, page: r.page, pages: r.pages, page_size: r.pageSize, counts: r.counts });
  }

  const limit = Math.max(1, Math.min(Math.floor(Number(q.limit)) || 50, 200));
  const offset = Math.max(0, Math.floor(Number(q.offset)) || 0);
  const where = orderQuery.toWhere(filter);
  const [orders, total, counts] = await Promise.all([
    orderModel.list({ ...where, limit, offset }), orderModel.count(where), orderModel.breakdown(where),
  ]);
  return res.json({ orders, total, page: Math.floor(offset / limit) + 1, pages: Math.max(1, Math.ceil(total / limit)), page_size: limit, counts });
}

/** GET /orders/:id[?include=payments] */
async function get(req, res) {
  const id = v.id(req.params.id);
  const order = await orderService.getWithItems(id);
  const include = typeof req.query.include === 'string' ? req.query.include.split(',').map((s) => s.trim()) : [];
  if (include.includes('payments')) return res.json({ order, payments: await orderModel.getPayments(id) });
  return res.json({ order });
}

/** GET /orders/:id/receipt: everything Android needs to print the receipt itself (ESC/POS). */
async function receipt(req, res) {
  const r = await posService.receipt(v.id(req.params.id));
  res.json({ order: r.order, payments: r.payments, printer: r.printer, shop_name: env.business.shopName, vat: r.vat });
}

/** Replace all lines of an OPEN order (tablet sends the full cart). */
async function replaceItems(req, res) {
  res.json({ order: await orderService.replaceOpenOrderItems(v.id(req.params.id), req.body.items) });
}

/**
 * Take payment. A cashier pays open POS orders and walk-in Zalo bills with cash / transfer / card; settling a
 * customer's debt order (completed + customer_id) is admin-only, checked by payOrder after locking the order.
 */
async function pay(req, res) {
  const paymentNotification = require('../services/zalo/paymentNotificationService');
  const isAdmin = req.user.role === 'admin';
  const result = await orderService.payOrder(v.id(req.params.id), {
    method: v.oneOf(req.body.method, 'method', isAdmin ? METHODS : CASHIER_METHODS),
    tendered: v.num(req.body.tendered, 'tendered', { required: false }),
    reference: v.str(req.body.reference, 'reference', { max: 100, required: false }),
    discount: v.num(req.body.discount, 'discount', { required: false }),
    userId: req.user.id,
    allowDebtSettlement: isAdmin,
    isAdmin,
  });
  // a paid Zalo order: the customer gets a confirmation on Zalo (waited for at most 4 s; `zalo_notify` says how it went)
  if (result.order && result.order.source === 'zalo') {
    res.json({ ...result, zalo_notify: await paymentNotification.notifyOrderPaidSoon(result.order.id) });
    return;
  }
  res.json(result);
}

async function cancel(req, res) {
  res.json({ order: await orderService.cancelOrder(v.id(req.params.id)) });
}

/** Retry the Zalo bill (e.g. after a Zalo outage). */
async function resendReceipt(req, res) {
  const id = v.id(req.params.id);
  const order = await orderModel.getById(id);
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  if (order.source !== 'zalo' || order.status !== 'completed') throw new AppError(409, 'NOT_APPLICABLE', 'Only completed Zalo orders have a Zalo receipt');
  res.json(await receiptService.sendReceipt(id));
}

/** Revenue / COGS / gross profit for completed orders. ?from=2026-10-01&to=2026-11-01 (to exclusive) */
async function summary(req, res) {
  const from = v.str(req.query.from, 'from', { max: 30 });
  const to = v.str(req.query.to, 'to', { max: 30 });
  res.json({ from, to, ...(await orderModel.summary(from, to)) });
}

module.exports = { create, list, get, receipt, replaceItems, pay, cancel, resendReceipt, summary };
