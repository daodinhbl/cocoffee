const { pool } = require('../config/db');

/** Customers and their debt ledger (customer_ledger: + debt, - payment). */
const db = (conn) => conn || pool;

async function findByZaloUser(zaloUserId, conn) {
  if (!zaloUserId) return null;
  const [rows] = await db(conn).query('SELECT * FROM customers WHERE zalo_user_id = ? LIMIT 1', [zaloUserId]);
  return rows[0] || null;
}

async function linkOrder(orderId, customerId, conn) {
  await db(conn).query('UPDATE orders SET customer_id = ? WHERE id = ?', [customerId, orderId]);
}

/**
 * One ledger row. `amount` is signed: > 0 increases what the customer owes, < 0 reduces it.
 * (order_id, entry_type) is unique, so recording the same order's debt or payment twice is a no-op.
 */
async function addEntry({ customerId, orderId = null, type, amount, method = null, note = null, userId = null, at = null }, conn) {
  await db(conn).query(
    `INSERT IGNORE INTO customer_ledger (customer_id, order_id, entry_type, amount, method, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
    [customerId, orderId, type, amount, method, note, userId, at]
  );
}

/** Customers with a positive balance, biggest first. */
async function topBalances(limit = 6, conn) {
  const [rows] = await db(conn).query(
    `SELECT c.id, c.name, c.phone, c.zalo_user_id,
            SUM(l.amount) AS balance,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'completed' AND o.payment_status = 'unpaid') AS open_orders,
            MIN(CASE WHEN l.entry_type = 'debt' THEN l.created_at END) AS oldest
       FROM customer_ledger l JOIN customers c ON c.id = l.customer_id
      GROUP BY c.id, c.name, c.phone, c.zalo_user_id
     HAVING balance > 0
      ORDER BY balance DESC LIMIT ?`,
    [limit]
  );
  return rows;
}

module.exports = { findByZaloUser, linkOrder, addEntry, topBalances };
