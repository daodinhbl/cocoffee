const { pool } = require('../config/db');

const db = (conn) => conn || pool;

/** The DB clock, so shift bounds line up with completed_at / paid_at (written with NOW()). */
async function now(conn) {
  const [rows] = await db(conn).query('SELECT NOW() AS t');
  return rows[0].t;
}

async function last(conn, { forUpdate = false } = {}) {
  const [rows] = await db(conn).query(`SELECT * FROM shifts ORDER BY period_to DESC, id DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`);
  return rows[0] || null;
}

async function getById(id, conn) {
  const [rows] = await db(conn).query(
    'SELECT s.*, u.full_name AS closed_by_name FROM shifts s LEFT JOIN users u ON u.id = s.closed_by WHERE s.id = ?', [id]);
  return rows[0] || null;
}

async function recent(limit = 10, conn) {
  const [rows] = await db(conn).query(
    `SELECT s.id, s.period_from, s.period_to, s.revenue, s.orders_count, s.difference, u.full_name AS closed_by_name
       FROM shifts s LEFT JOIN users u ON u.id = s.closed_by ORDER BY s.id DESC LIMIT ?`, [Math.min(Number(limit) || 10, 50)]);
  return rows;
}

/** Money received in [from, to) per method (prepayments and refunds included: it is the till), net. */
async function paymentsByMethod(from, to, conn) {
  const [rows] = await db(conn).query(
    'SELECT method, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE paid_at >= ? AND paid_at < ? GROUP BY method', [from, to]);
  const out = { cash: 0, transfer: 0, card: 0, other: 0 };
  for (const r of rows) out[r.method] = Number(r.amount);
  return out;
}

/** Completed orders of the period, plus the cancelled ones and what is still open right now. */
async function orderTotals(from, to, conn) {
  const [[done]] = await db(conn).query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(discount), 0) AS discount,
            COALESCE(SUM(CASE WHEN payment_status = 'unpaid' THEN total END), 0) AS unpaid
       FROM orders WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?`, [from, to]);
  const [[cancelled]] = await db(conn).query(
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'cancelled' AND updated_at >= ? AND updated_at < ?", [from, to]);
  const [[open]] = await db(conn).query("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders WHERE status = 'open'");
  return {
    orders: Number(done.n), revenue: Number(done.revenue), discount: Number(done.discount), unpaid: Number(done.unpaid),
    cancelled: Number(cancelled.n), open: Number(open.n), openAmount: Number(open.amount),
  };
}

async function insert(s, conn) {
  const [res] = await db(conn).query(
    `INSERT INTO shifts (period_from, period_to, closed_by, opening_cash, counted_cash, expected_cash, difference,
                         cash_total, transfer_total, card_total, other_total, orders_count, cancelled_count, revenue,
                         discount_total, unpaid_total, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.from, s.to, s.closedBy, s.openingCash, s.countedCash, s.expectedCash, s.difference, s.pay.cash, s.pay.transfer, s.pay.card,
      s.pay.other, s.totals.orders, s.totals.cancelled, s.totals.revenue, s.totals.discount, s.totals.unpaid, s.note || null]);
  return res.insertId;
}

module.exports = { now, last, getById, recent, paymentsByMethod, orderTotals, insert };
