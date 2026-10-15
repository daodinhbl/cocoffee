const categoryModel = require('../models/categoryModel');
const productModel = require('../models/productModel');
const tableModel = require('../models/tableModel');
const adminModel = require('../models/adminModel');
const printerSettings = require('./printerSettings');
const orderService = require('./orderService');
const orderModel = require('../models/orderModel');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');
const logger = require('../utils/logger');

/**
 * POS front office, shared by the Web Admin POS screen and the app (/api/pos/*). Pricing, stock deduction (BOM)
 * and COGS stay in orderService: client prices are display-only.
 */
const METHODS = ['cash', 'transfer', 'card'];

/** Everything the POS screen loads once: menu, tables, live Zalo drafts, printer options. */
async function bootstrap() {
  const [categories, products, tables, drafts, printer] = await Promise.all([
    categoryModel.list(), productModel.list(), tableModel.list(), adminModel.zaloPendingDrafts(20), printerSettings.get(),
  ]);
  return { categories, products, tables, drafts, printer };
}

/** body: { table_id?, order_id?, items:[{product_id, quantity, note?}], note? } -> validated cart. */
function readCart(body = {}) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new AppError(400, 'VALIDATION', 'Đơn chưa có món nào.');
  if (items.length > 100) throw new AppError(400, 'VALIDATION', 'Đơn quá nhiều dòng.');
  return {
    tableId: body.table_id ? v.id(body.table_id, 'Bàn') : null,
    orderId: body.order_id ? v.id(body.order_id, 'Đơn') : null,
    items: items.map((i) => {
      const line = { product_id: v.id(i?.product_id, 'Món'), quantity: i?.quantity };
      const note = v.str(i?.note, 'Ghi chú món', { max: 255, required: false });
      if (note) line.note = note;                         // only when given: orderService snapshots it on the line
      return line;
    }),
    note: v.str(typeof body.note === 'string' && body.note.trim() ? body.note : undefined, 'Ghi chú', { max: 255, required: false }),
  };
}

/** Create the order (or update the table's open one) without taking payment. */
async function saveOpen(cart, userId) {
  if (cart.orderId) return { order: await orderService.replaceOpenOrderItems(cart.orderId, cart.items), created: false };
  return { order: await orderService.createPosOrder({ table_id: cart.tableId, items: cart.items, note: cart.note, userId }), created: true };
}

/** Keep the order on its table (pay later). Needs a table or an existing open order. */
async function hold(cart, userId) {
  if (!cart.tableId && !cart.orderId) throw new AppError(400, 'VALIDATION', 'Chọn bàn để giữ đơn.');
  return saveOpen(cart, userId);
}

/** Payment fields of a checkout body. Only cash / transfer / card at the counter. */
function readPayment(body = {}) {
  const blank = (x) => (x === '' || x == null ? undefined : x);
  const reference = v.str(blank(body.reference), 'Mã tham chiếu', { max: 100, required: false });
  return {
    method: v.oneOf(body.method, 'Hình thức thanh toán', METHODS),
    discount: v.num(blank(body.discount), 'Giảm giá', { min: 0, required: false }),
    tendered: v.num(blank(body.tendered), 'Tiền khách đưa', { min: 0, required: false }),
    ...(reference ? { reference } : {}),          // card / transfer reference, kept out of the object when absent
  };
}

/**
 * Save + pay in one step. A just-created order whose payment fails is cancelled, so a failed or dropped checkout
 * never leaves a half-done sale behind.
 * @returns {Promise<{ order: object, change: number }>} order with items
 */
async function checkout(cart, { method, discount, tendered, reference }, userId, isAdmin = false) {
  const { order, created } = await saveOpen(cart, userId);
  try {
    const result = await orderService.payOrder(order.id, { method, tendered, ...(reference ? { reference } : {}), discount, userId, isAdmin });
    return { order: result.order, change: Number(result.change) || 0 };
  } catch (err) {
    if (created) await orderService.cancelOrder(order.id).catch((e) => logger.warn('POS: could not cancel unpaid order', e));
    throw err;
  }
}

/** VAT included in a total, as printed on the receipt (null when the VAT line is off). */
const vatOf = (total, printer) => (printer.showVat && printer.vatRate > 0 ? Number(total) - Number(total) / (1 + printer.vatRate / 100) : null);

/** Data of a printable receipt. Draft and cancelled orders are not printable. */
async function receipt(orderId) {
  const order = await orderService.getWithItems(orderId);
  if (order.status === 'cancelled' || order.status === 'draft') throw new AppError(409, 'NOT_PRINTABLE', 'Đơn này chưa hoàn tất nên không in hóa đơn.');
  const [payments, printer] = await Promise.all([orderModel.getPayments(order.id), printerSettings.get()]);
  return { order, payments, printer, vat: vatOf(order.total, printer) };
}

module.exports = { bootstrap, readCart, readPayment, saveOpen, hold, checkout, receipt, vatOf, METHODS };
