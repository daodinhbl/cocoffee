const { withTransaction } = require('../config/db');
const { AppError } = require('../utils/httpError');
const orderModel = require('../models/orderModel');
const customerModel = require('../models/customerModel');

/**
 * Debt collection (thu nợ) and manual adjustments on the customer ledger.
 *
 * The ledger records real money only: a collection writes ONE 'payment' row with the amount actually received
 * (partial payments allowed). Orders are then settled oldest first: an unpaid order becomes 'paid' as soon as the
 * customer's cumulative payments cover it (and every older debt order). Partial money stays as credit on the
 * ledger and counts towards the next collection.
 */
const METHODS = ['cash', 'transfer', 'card', 'other'];

async function lockCustomer(conn, customerId) {
  const [rows] = await conn.query('SELECT id, name, zalo_user_id FROM customers WHERE id = ? FOR UPDATE', [customerId]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy khách hàng.');
  return rows[0];
}

async function balanceOf(conn, customerId) {
  const [[row]] = await conn.query('SELECT COALESCE(SUM(amount), 0) AS balance FROM customer_ledger WHERE customer_id = ?', [customerId]);
  return Number(row.balance);
}

/**
 * Mark debt orders paid, oldest first, while the customer's total payments cover them.
 * @returns {Promise<string[]>} codes of the orders that became paid now
 */
async function settleOrders(conn, customerId, method, userId) {
  const [[paid]] = await conn.query(
    "SELECT COALESCE(-SUM(amount), 0) AS total FROM customer_ledger WHERE customer_id = ? AND entry_type = 'payment'",
    [customerId]
  );
  const [debts] = await conn.query(
    `SELECT o.id, o.order_code, o.total, o.payment_status
       FROM customer_ledger l JOIN orders o ON o.id = l.order_id
      WHERE l.customer_id = ? AND l.entry_type = 'debt'
      ORDER BY COALESCE(o.completed_at, o.created_at), o.id
      FOR UPDATE`,
    [customerId]
  );
  let pool = Number(paid.total);
  const settled = [];
  for (const o of debts) {
    const total = Number(o.total);
    if (pool < total) break;                                // oldest-first: stop at the first one not covered
    pool -= total;
    if (o.payment_status === 'paid') continue;              // paid earlier (e.g. from the order page)
    await orderModel.insertPayment({ orderId: o.id, method, amount: total, reference: 'Thu nợ khách hàng', userId }, conn);
    await orderModel.markPaid(o.id, method, conn);
    settled.push(o.order_code);
  }
  return settled;
}

/** Collect money from a customer. amount <= current balance. */
async function collect(customerId, { amount, method, note, userId }) {
  if (!METHODS.includes(method)) throw new AppError(400, 'VALIDATION', 'Hình thức thanh toán không hợp lệ.');
  const value = Math.round(Number(amount));
  if (!(value > 0)) throw new AppError(400, 'VALIDATION', 'Số tiền thu phải lớn hơn 0.');
  return withTransaction(async (conn) => {
    await lockCustomer(conn, customerId);
    const balance = await balanceOf(conn, customerId);
    if (balance <= 0) throw new AppError(409, 'NO_DEBT', 'Khách hàng này không còn nợ.');
    if (value > balance) throw new AppError(400, 'VALIDATION', `Số tiền thu lớn hơn số nợ hiện tại (${balance.toLocaleString('vi-VN')}đ).`);
    await customerModel.addEntry({ customerId, type: 'payment', amount: -value, method, note: note || 'Thu nợ', userId }, conn);
    const settled = await settleOrders(conn, customerId, method, userId);
    return { amount: value, balance: balance - value, settled };
  });
}

/** Manual correction (+ adds debt, - removes it), always with a reason. */
async function adjust(customerId, { amount, note, userId }) {
  const value = Math.round(Number(amount));
  if (!value) throw new AppError(400, 'VALIDATION', 'Số tiền điều chỉnh phải khác 0.');
  if (Math.abs(value) > 1e9) throw new AppError(400, 'VALIDATION', 'Số tiền điều chỉnh quá lớn.');
  if (!note || !String(note).trim()) throw new AppError(400, 'VALIDATION', 'Ghi rõ lý do điều chỉnh.');
  return withTransaction(async (conn) => {
    const customer = await lockCustomer(conn, customerId);
    const cleanNote = String(note).trim().slice(0, 255);
    await customerModel.addEntry({ customerId, type: 'adjust', amount: value, note: cleanNote, userId }, conn);
    return { balance: await balanceOf(conn, customerId), amount: value, note: cleanNote, customer };
  });
}

/**
 * "Ghi công nợ" for a Zalo order that is not on any customer's ledger (the customer was not in the list when they
 * confirmed it, or was never linked): puts the order on a customer's debt.
 *   - the customer is an existing one (customerId) or a new one (newCustomer { name, phone? }); a new customer takes the
 *     order's Zalo id, so their next Zalo orders go to the ledger on their own;
 *   - linkZalo (default true): an existing customer without a Zalo id gets the order's Zalo id, unless another customer
 *     already owns it;
 *   - one transaction under the order lock: the order is linked, ONE 'debt' ledger row of the order total is written
 *     (the (order, 'debt') pair is unique, so a double click cannot count it twice). The order stays completed + unpaid:
 *     it is paid later with "Thu tiền" / "Thu nợ" like any debt order.
 * @returns {Promise<{ order: object, customer: object, amount: number, balance: number, note: string, linkedZalo: boolean, createdCustomer: boolean }>}
 */
async function recordOrderDebt(orderId, { customerId, newCustomer, linkZalo = true, userId } = {}) {
  if (!customerId && !(newCustomer && String(newCustomer.name || '').trim())) {
    throw new AppError(400, 'VALIDATION', 'Chọn khách hàng có sẵn hoặc nhập tên khách mới.');
  }
  return withTransaction(async (conn) => {
    const order = await orderModel.getById(orderId, conn, { forUpdate: true });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng.');
    if (order.source !== 'zalo' || order.status !== 'completed') throw new AppError(409, 'NOT_APPLICABLE', 'Chỉ đơn Zalo đã hoàn tất mới ghi công nợ được.');
    if (order.payment_status !== 'unpaid') throw new AppError(409, 'ORDER_NOT_PAYABLE', 'Đơn đã thanh toán, không ghi công nợ được.');
    if (order.customer_id) throw new AppError(409, 'ALREADY_ON_LEDGER', 'Đơn này đã được ghi công nợ cho một khách hàng.');
    const total = Math.round(Number(order.total));
    if (!(total > 0)) throw new AppError(409, 'VALIDATION', 'Đơn 0đ không có công nợ để ghi.');

    let id = customerId ? Number(customerId) : null;
    let createdCustomer = false;
    let linkedZalo = false;
    if (!id) {
      const owner = order.zalo_user_id ? await customerModel.findByZaloUser(order.zalo_user_id, conn) : null;
      if (owner) {
        id = owner.id;                                          // the Zalo account already belongs to a customer: use them
      } else {
        id = await customerModel.create({
          name: String(newCustomer.name).trim().slice(0, 120),
          phone: String(newCustomer.phone || '').trim().slice(0, 20) || null,
          zalo_user_id: order.zalo_user_id || null,
          note: `Tạo khi ghi nợ đơn ${order.order_code}`,
        }, conn);
        createdCustomer = true;
        linkedZalo = Boolean(order.zalo_user_id);
      }
    }
    const customer = await lockCustomer(conn, id);
    if (linkZalo && !createdCustomer && !customer.zalo_user_id && order.zalo_user_id) {
      const owner = await customerModel.findByZaloUser(order.zalo_user_id, conn);
      if (!owner) {
        await customerModel.update(id, { zalo_user_id: order.zalo_user_id }, conn);
        customer.zalo_user_id = order.zalo_user_id;
        linkedZalo = true;
      }
    }
    const note = `Nợ đơn ${order.order_code}`;
    await customerModel.linkOrder(orderId, id, conn);
    await customerModel.addEntry({ customerId: id, orderId, type: 'debt', amount: total, note, userId }, conn);
    return {
      order: { ...order, customer_id: id },
      customer: { id, name: customer.name, zalo_user_id: customer.zalo_user_id || null },
      amount: total,
      balance: await balanceOf(conn, id),
      note,
      linkedZalo,
      createdCustomer,
    };
  });
}

module.exports = { collect, adjust, recordOrderDebt, settleOrders, METHODS };
