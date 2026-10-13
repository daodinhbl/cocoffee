const env = require('../../config/env');
const categoryModel = require('../../models/categoryModel');
const productModel = require('../../models/productModel');
const tableModel = require('../../models/tableModel');
const adminModel = require('../../models/adminModel');
const orderModel = require('../../models/orderModel');
const printerSettings = require('../../services/printerSettings');
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
  const [categories, products, tables, drafts, zalo, printer] = await Promise.all([
    categoryModel.list(), productModel.list(), tableModel.list(), adminModel.zaloPendingDrafts(20), zaloStatus(), printerSettings.get(),
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
      printer: { autoPrint: printer.autoPrint, vatRate: printer.showVat ? printer.vatRate : 0, paperMm: printer.paperMm },
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

const METHOD_LABEL = { cash: 'Tiền mặt', transfer: 'Chuyển khoản', card: 'Thẻ', other: 'Khác' };

/**
 * Printable receipt for a thermal printer (80mm by default, RECEIPT_PAPER_MM=58 for small printers).
 * ?print=1 prints on load (the POS loads it in a hidden iframe right after checkout); ?given= shows the
 * cash handed over and the change.
 */
function renderReceipt(req, res, { order, payments, printer, sample = false }) {
  const given = Number(req.query.given);
  const total = Number(order.total);
  // The POS prints from a same-origin iframe: allow framing by ourselves only (admin pages say 'none').
  const csp = res.getHeader('Content-Security-Policy');
  if (csp) res.setHeader('Content-Security-Policy', String(csp).replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
  res.render('receipt', {
    shopName: env.business.shopName,
    printer,
    paper: printer.paperMm,
    order,
    payments: payments.map((p) => ({ ...p, label: METHOD_LABEL[p.method] || p.method })),
    vat: printer.showVat && printer.vatRate > 0 ? total - total / (1 + printer.vatRate / 100) : null,
    cash: Number.isFinite(given) && given >= total ? { given, change: given - total } : null,
    autoPrint: req.query.print === '1',
    printedBy: req.user.full_name || req.user.username,
    sample,
  });
}

async function receipt(req, res) {
  const order = await orderService.getWithItems(v.id(req.params.id));
  if (order.status === 'cancelled' || order.status === 'draft') throw new AppError(409, 'NOT_PRINTABLE', 'Đơn này chưa hoàn tất nên không in hóa đơn.');
  const [payments, printer] = await Promise.all([orderModel.getPayments(order.id), printerSettings.get()]);
  renderReceipt(req, res, { order, payments, printer });
}

/** "In thử" from the settings page: a made-up order with the current printer settings. */
async function sampleReceipt(req, res) {
  const now = new Date();
  const items = [
    { product_name: 'Cà phê sữa đá', unit_price: 25000, quantity: 2, line_total: 50000, note: 'ít đá' },
    { product_name: 'Bạc xỉu', unit_price: 29000, quantity: 1, line_total: 29000, note: null },
  ];
  const order = {
    id: 0, order_code: 'IN-THU', source: 'pos', status: 'completed', table_name: 'Bàn mẫu', subtotal: 79000, discount: 4000, total: 75000,
    note: 'Hóa đơn in thử', created_at: now, completed_at: now, paid_at: now, items,
  };
  renderReceipt(req, res, { order, payments: [{ method: 'cash', received_by_name: req.user.full_name || req.user.username }], printer: await printerSettings.get(), sample: true });
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

module.exports = { page, openOrder, checkout, hold, receipt, sampleReceipt, json, readCart };
