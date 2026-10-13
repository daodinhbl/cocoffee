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
  const [rows] = await conn.query('SELECT id, name FROM customers WHERE id = ? FOR UPDATE', [customerId]);
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
    await lockCustomer(conn, customerId);
    await customerModel.addEntry({ customerId, type: 'adjust', amount: value, note: String(note).trim().slice(0, 255), userId }, conn);
    return { balance: await balanceOf(conn, customerId) };
  });
}

module.exports = { collect, adjust, settleOrders, METHODS };
