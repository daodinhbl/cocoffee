const orderModel = require('../models/orderModel');
const orderService = require('../services/orderService');
const receiptService = require('../services/receiptService');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');

const METHODS = ['cash', 'transfer', 'card', 'other'];

async function create(req, res) {
  const order = await orderService.createPosOrder({
    table_id: req.body.table_id ? v.id(req.body.table_id, 'table_id') : null,
    items: req.body.items || [],
    note: v.str(req.body.note, 'note', { required: false }),
    userId: req.user.id,
  });
  res.status(201).json({ order });
}

async function list(req, res) {
  res.json({
    orders: await orderModel.list({
      status: v.oneOf(req.query.status, 'status', ['draft', 'open', 'completed', 'cancelled'], { required: false }),
      source: v.oneOf(req.query.source, 'source', ['pos', 'zalo'], { required: false }),
      tableId: req.query.table_id ? v.id(req.query.table_id, 'table_id') : undefined,
      from: req.query.from, to: req.query.to,
      limit: req.query.limit, offset: req.query.offset,
    }),
  });
}

async function get(req, res) {
  res.json({ order: await orderService.getWithItems(v.id(req.params.id)) });
}

/** Replace all lines of an OPEN order (tablet sends the full cart). */
async function replaceItems(req, res) {
  res.json({ order: await orderService.replaceOpenOrderItems(v.id(req.params.id), req.body.items) });
}

async function pay(req, res) {
  const result = await orderService.payOrder(v.id(req.params.id), {
    method: v.oneOf(req.body.method, 'method', METHODS),
    tendered: v.num(req.body.tendered, 'tendered', { required: false }),
    reference: v.str(req.body.reference, 'reference', { max: 100, required: false }),
    discount: v.num(req.body.discount, 'discount', { required: false }),
    userId: req.user.id,
  });
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

module.exports = { create, list, get, replaceItems, pay, cancel, resendReceipt, summary };
