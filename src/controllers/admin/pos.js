const env = require('../../config/env');
const categoryModel = require('../../models/categoryModel');
const productModel = require('../../models/productModel');
const tableModel = require('../../models/tableModel');
const adminModel = require('../../models/adminModel');
const orderService = require('../../services/orderService');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const logger = require('../../utils/logger');
const { zaloStatus, describeError } = require('./common');
const { versionOf } = require('../../middlewares/adminSecurity');

/**
 * POS front-office (tablet at the counter). One server-rendered page; the cart lives in the browser and
 * is sent once, at checkout. Pricing, stock deduction (BOM) and COGS stay in orderService — the client's
 * prices are display-only.
 */
const METHODS = ['cash', 'transfer', 'card'];

async function page(req, res) {
  const [categories, products, tables, drafts, zalo] = await Promise.all([
    categoryModel.list(), productModel.list(), tableModel.list(), adminModel.zaloPendingDrafts(20), zaloStatus(),
  ]);
  res.render('pos', {
    shopName: env.business.shopName,
    user: req.user,
    isAdmin: req.user.role === 'admin',
    zalo,
    posV: versionOf('pos/pos.js'),
    data: {
      categories: categories.map((c) => ({ id: c.id, code: c.code, name: c.name })),
      products: products.map((p) => ({ id: p.id, categoryId: p.category_id, name: p.name, price: Number(p.price), image: p.image_url || null })),
      tables: tables.map((t) => ({ id: t.id, code: t.code, name: t.name, busy: t.status === 'serving', orderId: t.current_order_id || null })),
      drafts: drafts.map((d) => ({ code: d.order_code, total: Number(d.total || 0), chatType: d.chat_type, at: d.last_activity_at })),
    },
  });
}

/** Items of the open order sitting on a busy table, so the cashier can add to it and take payment. */
async function openOrder(req, res) {
  try {
    const order = await orderService.getWithItems(v.id(req.params.id));
    if (order.status !== 'open') throw new AppError(409, 'ORDER_NOT_OPEN', 'Đơn này không còn mở.');
    res.json({
      ok: true,
      order: { id: order.id, code: order.order_code, note: order.note, items: order.items.map((i) => ({ productId: i.product_id, qty: i.quantity })) },
    });
  } catch (err) {
    sendError(res, err);
  }
}

/** body: { table_id?, order_id?, items:[{product_id, quantity}], note?, discount?, method, tendered? } */
function readCart(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new AppError(400, 'VALIDATION', 'Đơn chưa có món nào.');
  if (items.length > 100) throw new AppError(400, 'VALIDATION', 'Đơn quá nhiều dòng.');
  return {
    tableId: body.table_id ? v.id(body.table_id, 'Bàn') : null,
    orderId: body.order_id ? v.id(body.order_id, 'Đơn') : null,
    items: items.map((i) => ({ product_id: v.id(i?.product_id, 'Món'), quantity: i?.quantity })),
    note: v.str(typeof body.note === 'string' && body.note.trim() ? body.note : undefined, 'Ghi chú', { max: 255, required: false }),
  };
}

/** Create the order (or update the table's open one) without taking payment. */
async function saveOpen(cart, userId) {
  if (cart.orderId) return { order: await orderService.replaceOpenOrderItems(cart.orderId, cart.items), created: false };
  return { order: await orderService.createPosOrder({ table_id: cart.tableId, items: cart.items, note: cart.note, userId }), created: true };
}

/** Keep the order on its table (pay later). Needs a table. */
async function hold(req) {
  const cart = readCart(req.body);
  if (!cart.tableId && !cart.orderId) throw new AppError(400, 'VALIDATION', 'Chọn bàn để giữ đơn.');
  const { order } = await saveOpen(cart, req.user.id);
  return { message: `Đã lưu đơn ${order.order_code} cho bàn.`, order: { id: order.id, code: order.order_code, total: Number(order.total) } };
}

/** Save + pay in one step. A just-created order whose payment fails is cancelled, so nothing is left half-done. */
async function checkout(req) {
  const cart = readCart(req.body);
  const method = v.oneOf(req.body.method, 'Hình thức thanh toán', METHODS);
  const discount = v.num(req.body.discount === '' || req.body.discount == null ? undefined : req.body.discount, 'Giảm giá', { min: 0, required: false });
  const tendered = v.num(req.body.tendered === '' || req.body.tendered == null ? undefined : req.body.tendered, 'Tiền khách đưa', { min: 0, required: false });

  const { order, created } = await saveOpen(cart, req.user.id);
  try {
    const result = await orderService.payOrder(order.id, { method, tendered, discount, userId: req.user.id });
    return {
      message: `Đã thanh toán ${result.order.order_code}.`,
      order: { id: result.order.id, code: result.order.order_code, total: Number(result.order.total) },
      change: Number(result.change) || 0,
    };
  } catch (err) {
    if (created) await orderService.cancelOrder(order.id).catch((e) => logger.warn('POS: could not cancel unpaid order', e));
    throw err;
  }
}

// orderService speaks English to the API clients; the cashier gets Vietnamese.
const POS_MESSAGES = {
  TABLE_OCCUPIED: 'Bàn này đang có đơn mở. Tải lại trang để lấy đơn hiện tại của bàn.',
  PRODUCT_UNAVAILABLE: 'Có món vừa ngừng bán. Tải lại trang để cập nhật thực đơn.',
  INSUFFICIENT_PAYMENT: 'Tiền khách đưa chưa đủ.',
  ORDER_NOT_OPEN: 'Đơn không còn mở.',
  ORDER_NOT_PAYABLE: 'Đơn không còn ở trạng thái thanh toán được.',
  EMPTY_ORDER: 'Đơn chưa có món nào.',
};

function sendError(res, err) {
  const text = (err instanceof AppError && err.code !== 'INSUFFICIENT_STOCK' && POS_MESSAGES[err.code]) || describeError(err);
  if (!text) {
    logger.error('POS request failed', err);
    return res.status(500).json({ ok: false, message: 'Lỗi hệ thống, vui lòng thử lại.' });
  }
  return res.status(err.status && err.status < 500 ? err.status : 400).json({ ok: false, code: err.code, message: text });
}

/** JSON wrapper for POS actions: { ok:true, ...result } or { ok:false, message }. */
const json = (fn) => async (req, res) => {
  try {
    res.json({ ok: true, ...(await fn(req, res)) });
  } catch (err) {
    sendError(res, err);
  }
};

module.exports = { page, openOrder, checkout, hold, json, readCart };
