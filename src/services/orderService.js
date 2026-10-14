const { withTransaction } = require('../config/db');
const { AppError } = require('../utils/httpError');
const orderModel = require('../models/orderModel');
const tableModel = require('../models/tableModel');
const productModel = require('../models/productModel');
const inventoryService = require('./inventoryService');
const customerModel = require('../models/customerModel');

const MAX_QTY = 99;

// ------------------------------------------------------------------ helpers
async function getWithItems(orderId, conn) {
  const order = await orderModel.getById(orderId, conn);
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  return { ...order, items: await orderModel.getItems(orderId, conn) };
}

/** Validate [{product_id, quantity, note}] against live product rows and snapshot name/price. */
async function priceLines(conn, items) {
  if (!Array.isArray(items)) throw new AppError(400, 'VALIDATION', 'items must be an array');
  const ids = [...new Set(items.map((i) => Number(i.product_id)))];
  const products = new Map((await productModel.getManyByIds(ids, conn)).map((p) => [p.id, p]));
  return items.map((i) => {
    const qty = Number(i.quantity);
    const product = products.get(Number(i.product_id));
    if (!product || !product.is_active) throw new AppError(422, 'PRODUCT_UNAVAILABLE', `Product ${i.product_id} is not available`);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new AppError(400, 'VALIDATION', `quantity must be 1..${MAX_QTY}`);
    return { product_id: product.id, product_name: product.name, unit_price: product.price, quantity: qty, note: i.note };
  });
}

/**
 * Shared "finalize" step (POS payment AND Zalo confirmation):
 * deduct inventory (BOM / direct), fix COGS per line + total, mark completed, free the table.
 * Runs inside the caller's transaction; any throw rolls the whole thing back.
 */
async function finalizeOrder(conn, order) {
  const items = await orderModel.getItems(order.id, conn);
  if (!items.length) throw new AppError(422, 'EMPTY_ORDER', 'Order has no items');
  const { cogsTotal, lines } = await inventoryService.consumeForOrder(conn, order, items);
  for (const l of lines) await orderModel.setItemCogs(l.itemId, l.unitCogs, l.lineCogs, conn);
  await orderModel.markCompleted(order.id, cogsTotal, conn);
  if (order.table_id) await tableModel.release(order.table_id, conn);
}

// ------------------------------------------------------------------ POS flow
async function createPosOrder({ table_id, items = [], note, userId }) {
  return withTransaction(async (conn) => {
    if (table_id) {
      const table = await tableModel.getById(table_id, conn, { forUpdate: true });
      if (!table || !table.is_active) throw new AppError(404, 'NOT_FOUND', 'Table not found');
      if (table.status === 'serving') {
        throw new AppError(409, 'TABLE_OCCUPIED', 'Table already has an active order', { current_order_id: table.current_order_id });
      }
    }
    const lines = await priceLines(conn, items);
    const orderId = await orderModel.insert({ tableId: table_id || null, source: 'pos', status: 'open', note, createdBy: userId }, conn);
    await orderModel.replaceItems(orderId, lines, conn);
    if (table_id) await tableModel.setServing(table_id, orderId, conn);
    return getWithItems(orderId, conn);
  });
}

async function replaceOpenOrderItems(orderId, items) {
  return withTransaction(async (conn) => {
    const order = await orderModel.getById(orderId, conn, { forUpdate: true });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    if (order.status !== 'open') throw new AppError(409, 'ORDER_NOT_OPEN', `Order is ${order.status}`);
    await orderModel.replaceItems(orderId, await priceLines(conn, items), conn);
    return getWithItems(orderId, conn);
  });
}

/**
 * Take payment. Two legal entry states:
 *  - open      (POS)  -> finalize (deduct stock, COGS) + record payment
 *  - completed & unpaid (Zalo order, stock already deducted at confirmation) -> record payment only
 */
async function payOrder(orderId, { method, tendered, reference, discount, userId }) {
  return withTransaction(async (conn) => {
    let order = await orderModel.getById(orderId, conn, { forUpdate: true });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');

    if (order.status === 'open') {
      if (discount !== undefined && discount !== null) {
        if (!(Number(discount) >= 0)) throw new AppError(400, 'VALIDATION', 'discount must be >= 0');
        if (Number(discount) > Number(order.subtotal)) throw new AppError(400, 'VALIDATION', 'Giảm giá không được lớn hơn tạm tính của đơn.');
        await orderModel.setDiscount(orderId, Number(discount), conn);
        order = await orderModel.getById(orderId, conn, { forUpdate: true });
      }
      await finalizeOrder(conn, order);
    } else if (!(order.status === 'completed' && order.payment_status === 'unpaid')) {
      throw new AppError(409, 'ORDER_NOT_PAYABLE', `Order is ${order.status}/${order.payment_status}`);
    }

    const total = order.total;
    const given = tendered === undefined || tendered === null ? total : Number(tendered);
    if (!(given >= total)) throw new AppError(422, 'INSUFFICIENT_PAYMENT', `Tendered amount is less than total (${total})`);

    await orderModel.insertPayment({ orderId, method, amount: total, reference, userId }, conn);
    await orderModel.markPaid(orderId, method, conn);
    if (order.customer_id && order.status === 'completed') {          // was on the customer's debt: settle it
      await customerModel.addEntry({ customerId: order.customer_id, orderId, type: 'payment', amount: -Number(total), method, note: `Thu nợ đơn ${order.order_code}`, userId }, conn);
    }
    return { order: await getWithItems(orderId, conn), change: given - total };
  });
}

async function cancelOrder(orderId) {
  return withTransaction(async (conn) => {
    const order = await orderModel.getById(orderId, conn, { forUpdate: true });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    if (!['draft', 'open'].includes(order.status)) throw new AppError(409, 'ORDER_NOT_CANCELLABLE', `Order is ${order.status}`);
    await orderModel.markCancelled(orderId, conn);
    if (order.table_id) await tableModel.release(order.table_id, conn);
    return getWithItems(orderId, conn);
  });
}

// ------------------------------------------------------------------ Zalo flow
/**
 * Create or update the draft behind a Zalo session. Caller holds the session row lock.
 * mode 'replace' (default) rebuilds the draft from this message; 'append' ("them ...") adds to it.
 * @param items [{ productId, quantity, note? }]  same product with another note = another line ("ít đường")
 * @returns {Promise<number>} draft order id
 */
async function upsertZaloDraft(conn, { session, chatType, chatId, userId, items, mode = 'replace' }) {
  const products = new Map(
    (await productModel.getManyByIds([...new Set(items.map((i) => i.productId))], conn)).map((p) => [p.id, p])
  );

  let order = null;
  if (session.draft_order_id) {
    const existing = await orderModel.getById(session.draft_order_id, conn, { forUpdate: true });
    if (existing && existing.status === 'draft') order = existing;
  }

  const lines = new Map(); // "product_id|note" -> line
  const lineKey = (productId, note) => `${productId}|${note || ''}`;
  if (order && mode === 'append') {
    for (const l of await orderModel.getItems(order.id, conn)) {
      lines.set(lineKey(l.product_id, l.note), { product_id: l.product_id, product_name: l.product_name, unit_price: l.unit_price, quantity: l.quantity, note: l.note || null });
    }
  }
  for (const { productId, quantity, note } of items) {
    const product = products.get(productId);
    if (!product || !product.is_active) continue; // deactivated since the catalog cache was built
    const key = lineKey(productId, note);
    const line = lines.get(key) || { product_id: product.id, product_name: product.name, unit_price: product.price, quantity: 0, note: note || null };
    line.quantity = Math.min(MAX_QTY, line.quantity + quantity);
    lines.set(key, line);
  }
  if (!lines.size) throw new AppError(422, 'PRODUCT_UNAVAILABLE', 'No available products in this message');

  const orderId = order
    ? order.id
    : await orderModel.insert({ source: 'zalo', status: 'draft', zaloUserId: userId, zaloChatType: chatType, zaloChatId: chatId }, conn);
  await orderModel.replaceItems(orderId, [...lines.values()], conn);
  return orderId;
}

/** Draft -> Completed. Caller owns the transaction (and rolls back on throw). */
async function confirmDraft(conn, orderId) {
  const order = await orderModel.getById(orderId, conn, { forUpdate: true });
  if (!order || order.source !== 'zalo' || order.status !== 'draft') {
    throw new AppError(409, 'ORDER_NOT_DRAFT', 'Order is not a pending Zalo draft');
  }
  await finalizeOrder(conn, order);
  const customer = await customerModel.findByZaloUser(order.zalo_user_id, conn);
  if (customer) {
    const done = await orderModel.getById(orderId, conn);
    await customerModel.linkOrder(orderId, customer.id, conn);
    await customerModel.addEntry({ customerId: customer.id, orderId, type: 'debt', amount: Number(done.total), note: `Nợ đơn ${done.order_code}` }, conn);
  }
  return order;
}

async function cancelDraft(conn, orderId) {
  const order = await orderModel.getById(orderId, conn, { forUpdate: true });
  if (order && order.status === 'draft') await orderModel.markCancelled(orderId, conn);
}

module.exports = {
  getWithItems, createPosOrder, replaceOpenOrderItems, payOrder, cancelOrder,
  upsertZaloDraft, confirmDraft, cancelDraft, finalizeOrder,
};
