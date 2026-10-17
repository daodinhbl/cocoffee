const { withTransaction } = require('../config/db');
const { AppError } = require('../utils/httpError');
const orderModel = require('../models/orderModel');
const tableModel = require('../models/tableModel');
const productModel = require('../models/productModel');
const inventoryService = require('./inventoryService');
const customerModel = require('../models/customerModel');
const taxService = require('./taxService');
const auditModel = require('../models/auditModel');
const env = require('../config/env');
const logger = require('../utils/logger');

const MAX_QTY = 99;
const MAX_CASHIER_DISCOUNT_PCT = env.business.maxCashierDiscountPct;   // % of the subtotal; admins are not limited

// ------------------------------------------------------------------ helpers
async function getWithItems(orderId, conn) {
  const order = await orderModel.getById(orderId, conn);
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  return { ...order, items: await orderModel.getItems(orderId, conn) };
}

/** Optional line note ("ít đá"): a string up to 255 characters (the column size), '' / null = none. */
function lineNote(note) {
  if (note === undefined || note === null || note === '') return null;
  if (typeof note !== 'string' || note.trim().length > 255) throw new AppError(400, 'VALIDATION', 'note must be a string up to 255 chars');
  return note.trim() || null;
}

/** Validate [{product_id, quantity, note}] against live product rows and snapshot name/price. */
async function priceLines(conn, items) {
  if (!Array.isArray(items)) throw new AppError(400, 'VALIDATION', 'items must be an array');
  const ids = [...new Set(items.map((i) => Number(i?.product_id)))];
  const products = new Map((await productModel.getManyByIds(ids, conn)).map((p) => [p.id, p]));
  return items.map((i) => {
    if (!i || typeof i !== 'object') throw new AppError(400, 'VALIDATION', 'items must be objects');
    const qty = Number(i.quantity);
    const product = products.get(Number(i.product_id));
    if (!product || !product.is_active) throw new AppError(422, 'PRODUCT_UNAVAILABLE', `Product ${i.product_id} is not available`);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new AppError(400, 'VALIDATION', `quantity must be 1..${MAX_QTY}`);
    return { product_id: product.id, product_name: product.name, unit_price: product.price, quantity: qty, note: lineNote(i.note) };
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
  try {
    await taxService.snapshotOrder(conn, order);                // tax group / rates / net revenue per line + today's rollup (rev_daily)
  } catch (err) {                                              // a sale must never fail because of bookkeeping; scripts/rollup.js repairs it
    logger.error(`Tax snapshot of order ${order.id} failed`, err);
  }
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
    const lines = await priceLines(conn, items);
    const prepaid = await orderModel.paidTotal(orderId, conn);
    if (prepaid > 0 && lines.reduce((s, l) => s + Number(l.unit_price) * l.quantity, 0) < prepaid) {
      throw new AppError(422, 'BELOW_PREPAID', 'Order total would drop below the amount already prepaid');
    }
    await orderModel.replaceItems(orderId, lines, conn);
    return getWithItems(orderId, conn);
  });
}

// ------------------------------------------------------------------ prepayment / merge / split (POS)
/** Thanh toán trước: takes money on an open order. The final payment then only collects what is left. */
async function prepayOrder(orderId, { method, amount, reference, userId }) {
  return withTransaction(async (conn) => {
    const order = await orderModel.getById(orderId, conn, { forUpdate: true });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    if (order.status !== 'open') throw new AppError(409, 'ORDER_NOT_OPEN', `Order is ${order.status}`);
    const amt = Number(amount);
    if (!(amt > 0)) throw new AppError(400, 'VALIDATION', 'amount must be > 0');
    const paid = await orderModel.paidTotal(orderId, conn);
    const left = Number(order.total) - paid;
    if (amt > left) throw new AppError(422, 'PREPAY_TOO_MUCH', `Prepayment exceeds what is left to pay (${left})`);
    const ref = ['Trả trước', reference].filter(Boolean).join(' · ').slice(0, 100);
    await orderModel.insertPayment({ orderId, method, amount: amt, reference: ref, userId }, conn);
    return { order: await getWithItems(orderId, conn), prepaid: paid + amt };
  });
}

/** Locks an open order sitting on `table`, or throws. */
async function openOrderOf(conn, table) {
  if (!table.current_order_id) throw new AppError(409, 'TABLE_HAS_NO_ORDER', 'Table has no open order');
  const order = await orderModel.getById(table.current_order_id, conn, { forUpdate: true });
  if (!order || order.status !== 'open') throw new AppError(409, 'ORDER_NOT_OPEN', 'Order is not open');
  return order;
}

/**
 * Ghép bàn: `otherTableId` joins the order of `primaryTableId`. A free table is just attached; a table with its own
 * open order has its lines, payments and note moved onto the primary order (that order is then cancelled, empty).
 */
async function mergeTables({ primaryTableId, otherTableId }) {
  return withTransaction(async (conn) => {
    if (primaryTableId === otherTableId) throw new AppError(400, 'VALIDATION', 'Choose two different tables');
    const [first, second] = primaryTableId < otherTableId ? [primaryTableId, otherTableId] : [otherTableId, primaryTableId];
    const locked = new Map();
    for (const id of [first, second]) locked.set(id, await tableModel.getById(id, conn, { forUpdate: true }));
    const primary = locked.get(primaryTableId);
    const other = locked.get(otherTableId);
    if (!primary || !primary.is_active || !other || !other.is_active) throw new AppError(404, 'NOT_FOUND', 'Table not found');
    if (primary.merged_into) throw new AppError(409, 'TABLE_MERGED', 'Primary table is itself merged into another table');
    if (other.merged_into) throw new AppError(409, 'TABLE_MERGED', 'Table is already merged');
    if ((await tableModel.mergedInto(other.id, conn)).length) throw new AppError(409, 'TABLE_HAS_MERGED', 'Table already leads a merged group');
    const target = await openOrderOf(conn, primary);

    if (other.status === 'serving') {
      const moved = await openOrderOf(conn, other);
      await orderModel.moveAllItems(moved.id, target.id, conn);
      await orderModel.movePayments(moved.id, target.id, conn);
      await orderModel.recalcTotals(target.id, conn);
      await orderModel.recalcTotals(moved.id, conn);
      if (moved.note) await orderModel.setNote(target.id, [target.note, moved.note].filter(Boolean).join('; '), conn);
      await orderModel.setNote(moved.id, `Ghép vào ${target.order_code}`, conn);
      await orderModel.markCancelled(moved.id, conn);
    }
    await tableModel.setMerged(other.id, primary.id, conn);
    return getWithItems(target.id, conn);
  });
}

/** Tách bàn (1): a merged table leaves its group and becomes free again. */
async function unmergeTable(tableId) {
  return withTransaction(async (conn) => {
    const table = await tableModel.getById(tableId, conn, { forUpdate: true });
    if (!table) throw new AppError(404, 'NOT_FOUND', 'Table not found');
    if (!table.merged_into) throw new AppError(409, 'TABLE_NOT_MERGED', 'Table is not merged');
    await tableModel.release(tableId, conn);
    return { tableId };
  });
}

/**
 * Tách bàn (2): moves part of an open order to another table's order (a new one when that table is free).
 * items: [{ item_id, quantity }] - quantity of a line may be partial. The source order keeps at least one item and
 * must still cover what was prepaid on it.
 */
async function splitOrder({ orderId, targetTableId, items, userId }) {
  return withTransaction(async (conn) => {
    const order = await orderModel.getById(orderId, conn, { forUpdate: true });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    if (order.status !== 'open') throw new AppError(409, 'ORDER_NOT_OPEN', `Order is ${order.status}`);
    if (!Array.isArray(items) || !items.length) throw new AppError(400, 'VALIDATION', 'Choose the items to move');

    const rows = await orderModel.getItems(orderId, conn);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const want = new Map();
    for (const i of items) {
      const id = Number(i?.item_id);
      const qty = Number(i?.quantity);
      if (!byId.has(id)) throw new AppError(400, 'VALIDATION', 'Item does not belong to this order');
      if (!Number.isInteger(qty) || qty < 1) throw new AppError(400, 'VALIDATION', 'quantity must be a whole number >= 1');
      want.set(id, (want.get(id) || 0) + qty);
    }
    let movedQty = 0;
    for (const [id, qty] of want) {
      if (qty > byId.get(id).quantity) throw new AppError(400, 'VALIDATION', 'Cannot move more than the ordered quantity');
      movedQty += qty;
    }
    if (movedQty >= rows.reduce((s, r) => s + r.quantity, 0)) throw new AppError(422, 'SPLIT_ALL', 'Leave at least one item on the original order');

    const target = await tableModel.getById(targetTableId, conn, { forUpdate: true });
    if (!target || !target.is_active) throw new AppError(404, 'NOT_FOUND', 'Table not found');
    if (target.id === order.table_id) throw new AppError(400, 'VALIDATION', 'Choose another table');
    if (target.merged_into) throw new AppError(409, 'TABLE_MERGED', 'Target table is merged into another table');
    let targetOrderId;
    if (target.status === 'serving') {
      targetOrderId = (await openOrderOf(conn, target)).id;
    } else {
      targetOrderId = await orderModel.insert({ tableId: target.id, source: 'pos', status: 'open', createdBy: userId }, conn);
      await tableModel.setServing(target.id, targetOrderId, conn);
    }

    for (const [id, qty] of want) {
      const row = byId.get(id);
      if (qty === row.quantity) {
        await orderModel.moveItem(id, targetOrderId, conn);
      } else {
        await orderModel.setItemQuantity(id, row.quantity - qty, conn);
        await orderModel.insertItemCopy(row, targetOrderId, qty, conn);
      }
    }
    await orderModel.recalcTotals(orderId, conn);
    await orderModel.recalcTotals(targetOrderId, conn);

    const left = await orderModel.getById(orderId, conn, { forUpdate: true });
    if (Number(left.subtotal) < await orderModel.paidTotal(orderId, conn)) {
      throw new AppError(422, 'BELOW_PREPAID', 'The remaining order would be worth less than what was prepaid on it');
    }
    return { source: await getWithItems(orderId, conn), target: await getWithItems(targetOrderId, conn) };
  });
}

/** Audit trail of a discount, in the payment's own transaction. A failing audit write is logged and never blocks a sale. */
async function recordDiscount(conn, { userId, orderId, discountAmount, subtotal, isAdminApproved }) {
  const details = { orderId, discountAmount, subtotal, isAdminApproved, timestamp: new Date().toISOString() };
  logger.info(`Discount order=${orderId} user=${userId} amount=${discountAmount} subtotal=${subtotal} admin=${isAdminApproved}`);
  try {
    await auditModel.write(conn, { userId, action: 'order.discount', entity: `order:${orderId}`, details });
  } catch (err) {
    logger.error('Audit log write failed (discount)', err);
  }
}

/**
 * Take payment. Two legal entry states:
 *  - open      (POS)  -> finalize (deduct stock, COGS) + record payment
 *  - completed & unpaid (Zalo order, stock already deducted at confirmation) -> record payment only
 * A completed order linked to a customer is on that customer's debt ledger: paying it settles debt, which only an
 * admin may do (allowDebtSettlement). Checked after the row lock, so the order cannot change in between.
 */
async function payOrder(orderId, { method, tendered, reference, discount, userId, allowDebtSettlement = false, isAdmin = false }) {
  return withTransaction(async (conn) => {
    let order = await orderModel.getById(orderId, conn, { forUpdate: true });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    if (order.status === 'completed' && order.customer_id && !allowDebtSettlement) {
      throw new AppError(403, 'FORBIDDEN', 'Only an admin can settle a customer debt');
    }

    if (order.status === 'open') {
      if (discount !== undefined && discount !== null) {
        if (!(Number(discount) >= 0)) throw new AppError(400, 'VALIDATION', 'discount must be >= 0');
        if (Number(discount) > Number(order.subtotal)) throw new AppError(400, 'VALIDATION', 'Giảm giá không được lớn hơn tạm tính của đơn.');
        const amount = Number(discount);
        if (!isAdmin && amount > Number(order.subtotal) * MAX_CASHIER_DISCOUNT_PCT / 100) {
          throw new AppError(403, 'DISCOUNT_NEEDS_ADMIN', `Giảm giá vượt quá ${MAX_CASHIER_DISCOUNT_PCT}% cần quyền Quản trị viên`);
        }
        await orderModel.setDiscount(orderId, amount, conn);
        if (amount > 0) await recordDiscount(conn, { userId, orderId, discountAmount: amount, subtotal: Number(order.subtotal), isAdminApproved: Boolean(isAdmin) });
        order = await orderModel.getById(orderId, conn, { forUpdate: true });
      }
      await finalizeOrder(conn, order);
    } else if (!(order.status === 'completed' && order.payment_status === 'unpaid')) {
      throw new AppError(409, 'ORDER_NOT_PAYABLE', `Order is ${order.status}/${order.payment_status}`);
    }

    // Prepayments (thanh toán trước) already sit in `payments`: only the rest is collected now.
    const prepaid = await orderModel.paidTotal(orderId, conn);
    const total = prepaid ? Number(order.total) - prepaid : order.total;
    if (prepaid && total < 0) throw new AppError(409, 'PREPAID_EXCEEDS_TOTAL', 'Prepaid amount is larger than the order total');
    const given = tendered === undefined || tendered === null ? total : Number(tendered);
    if (!(given >= total)) throw new AppError(422, 'INSUFFICIENT_PAYMENT', `Tendered amount is less than total (${total})`);

    if (!(prepaid && total === 0)) await orderModel.insertPayment({ orderId, method, amount: total, reference, userId }, conn);
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
    for (const p of await orderModel.paidByMethod(orderId, conn)) {     // give prepayments back: a negative row nets the books to zero
      await orderModel.insertPayment({ orderId, method: p.method, amount: -p.amount, reference: 'Hoàn tiền trả trước' }, conn);
    }
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
  prepayOrder, mergeTables, unmergeTable, splitOrder,
  upsertZaloDraft, confirmDraft, cancelDraft, finalizeOrder,
};
