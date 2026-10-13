const { pool } = require('../config/db');

/**
 * Read-only aggregates for the Web Admin (dashboard, reports, Zalo monitor, notifications).
 * Date arguments are half-open DATETIME bounds: [from, to).
 */
const db = (conn) => conn || pool;

// A Zalo draft is "waiting for the customer" only while its session still awaits confirmation and has not
// expired. Expired/abandoned drafts keep status='draft' in orders (expiry is lazy), so they must not count.
const LIVE_DRAFT = `s.state = 'awaiting_confirm' AND (s.expires_at IS NULL OR s.expires_at >= NOW()) AND o.status = 'draft'`;

/** Live queue counters: Zalo drafts waiting for the customer, POS orders being served, bills still to collect. */
async function queueCounts(conn) {
  const [rows] = await db(conn).query(
    `SELECT (SELECT COUNT(*) FROM zalo_sessions s JOIN orders o ON o.id = s.draft_order_id WHERE ${LIVE_DRAFT}) AS drafts,
            COALESCE(SUM(status = 'open'), 0) AS open_orders,
            COALESCE(SUM(status = 'completed' AND payment_status = 'unpaid'), 0) AS unpaid
       FROM orders
      WHERE status = 'open' OR (status = 'completed' AND payment_status = 'unpaid')`
  );
  return rows[0];
}

async function receiptErrors(limit = 5, conn) {
  const [rows] = await db(conn).query(
    `SELECT id, order_code, receipt_error, completed_at
       FROM orders
      WHERE source = 'zalo' AND status = 'completed' AND receipt_error IS NOT NULL
      ORDER BY id DESC LIMIT ?`,
    [limit]
  );
  return rows;
}

async function salesByDay(from, to, conn) {
  const [rows] = await db(conn).query(
    `SELECT DATE_FORMAT(completed_at, '%Y-%m-%d') AS day, COUNT(*) AS orders,
            SUM(total) AS revenue, SUM(cogs_total) AS cogs
       FROM orders WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?
      GROUP BY DATE_FORMAT(completed_at, '%Y-%m-%d') ORDER BY day`,
    [from, to]
  );
  return rows;
}

async function salesByHour(from, to, conn) {
  const [rows] = await db(conn).query(
    `SELECT HOUR(completed_at) AS hour, COUNT(*) AS orders, SUM(total) AS revenue
       FROM orders WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?
      GROUP BY HOUR(completed_at) ORDER BY hour`,
    [from, to]
  );
  return rows;
}

async function salesBySource(from, to, conn) {
  const [rows] = await db(conn).query(
    `SELECT source, COUNT(*) AS orders, SUM(total) AS revenue, SUM(cogs_total) AS cogs
       FROM orders WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?
      GROUP BY source ORDER BY revenue DESC`,
    [from, to]
  );
  return rows;
}

/** Payment method of completed orders; unpaid ones (Zalo bills not collected yet) are grouped as 'unpaid'. */
async function salesByPayment(from, to, conn) {
  const [rows] = await db(conn).query(
    `SELECT CASE WHEN payment_status = 'paid' THEN COALESCE(payment_method, 'other') ELSE 'unpaid' END AS method,
            COUNT(*) AS orders, SUM(total) AS revenue
       FROM orders WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?
      GROUP BY 1 ORDER BY revenue DESC`,
    [from, to]
  );
  return rows;
}

async function topProducts(from, to, limit = 10, conn) {
  const [rows] = await db(conn).query(
    `SELECT oi.product_id, oi.product_name, SUM(oi.quantity) AS qty,
            SUM(oi.line_total) AS revenue, SUM(oi.line_cogs) AS cogs
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?
      GROUP BY oi.product_id, oi.product_name
      ORDER BY revenue DESC LIMIT ?`,
    [from, to, limit]
  );
  return rows;
}

async function recentPurchases(limit = 30, conn) {
  const [rows] = await db(conn).query(
    `SELECT m.id, m.inventory_item_id, i.name AS item_name, i.unit, m.quantity_change, m.unit_cost,
            m.balance_after, m.note, m.created_at, u.full_name AS user_name
       FROM inventory_movements m
       JOIN inventory_items i ON i.id = m.inventory_item_id
       LEFT JOIN users u ON u.id = m.created_by
      WHERE m.movement_type = 'purchase'
      ORDER BY m.id DESC LIMIT ?`,
    [limit]
  );
  return rows;
}

// ------------------------------------------------------------------------ Zalo monitor
async function zaloEventStats(hours = 24, conn) {
  const [rows] = await db(conn).query(
    `SELECT status, COUNT(*) AS n FROM zalo_events
      WHERE received_at >= DATE_SUB(NOW(), INTERVAL ? HOUR) GROUP BY status`,
    [hours]
  );
  const stats = { received: 0, processed: 0, ignored: 0, failed: 0 };
  for (const r of rows) stats[r.status] = r.n;
  const [last] = await db(conn).query('SELECT MAX(received_at) AS at FROM zalo_events');
  return { ...stats, lastEventAt: last[0].at };
}

/** Never selects `payload` (message bodies are customer data the monitor does not need). */
async function zaloRecentEvents(limit = 25, conn) {
  const [rows] = await db(conn).query(
    `SELECT id, event_name, status, error, num_retry, received_at, processed_at
       FROM zalo_events ORDER BY id DESC LIMIT ?`,
    [limit]
  );
  return rows;
}

async function zaloPendingDrafts(limit = 20, conn) {
  const [rows] = await db(conn).query(
    `SELECT s.id, s.chat_type, s.last_activity_at, s.expires_at, o.id AS order_id, o.order_code, o.total
       FROM zalo_sessions s JOIN orders o ON o.id = s.draft_order_id
      WHERE ${LIVE_DRAFT} ORDER BY s.last_activity_at DESC LIMIT ?`,
    [limit]
  );
  return rows;
}

/**
 * Customers owing money: Zalo orders that were confirmed (completed, stock deducted) but not paid, grouped
 * by the Zalo user who placed them, named from `customers` when that user is known.
 */
async function topDebtors(limit = 6, conn) {
  const [rows] = await db(conn).query(
    `SELECT o.zalo_user_id, MAX(c.id) AS customer_id, MAX(c.name) AS customer_name, MAX(c.phone) AS customer_phone,
            COUNT(*) AS orders, SUM(o.total) AS amount, MIN(o.completed_at) AS oldest
       FROM orders o LEFT JOIN customers c ON c.zalo_user_id = o.zalo_user_id
      WHERE o.status = 'completed' AND o.payment_status = 'unpaid' AND o.zalo_user_id IS NOT NULL
      GROUP BY o.zalo_user_id
      ORDER BY amount DESC LIMIT ?`,
    [limit]
  );
  return rows;
}

module.exports = {
  topDebtors,
  queueCounts, receiptErrors, salesByDay, salesByHour, salesBySource, salesByPayment, topProducts,
  recentPurchases, zaloEventStats, zaloRecentEvents, zaloPendingDrafts,
};
