const { pool } = require('../config/db');

/** Customers and their debt ledger (customer_ledger: + debt, - payment). */
const db = (conn) => conn || pool;

// ─────────────────────────────────────────────────────────────────────────────
// Admin list / search / CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a WHERE clause and param array from filter options.
 * @param {{ q?: string, debtOnly?: boolean, zaloOnly?: boolean }} f
 */
function buildWhere(f = {}) {
  const clauses = [];
  const params = [];
  if (f.q) {
    clauses.push('(c.name LIKE ? OR c.phone LIKE ? OR c.zalo_user_id LIKE ?)');
    const like = `%${f.q}%`;
    params.push(like, like, like);
  }
  if (f.debtOnly) clauses.push('balance > 0');
  if (f.zaloOnly) clauses.push('c.zalo_user_id IS NOT NULL');
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Base CTE: joins balance + order_count so WHERE can filter on balance. */
const BASE_CTE = `
  WITH cust_balance AS (
    SELECT customer_id, COALESCE(SUM(amount), 0) AS balance
    FROM customer_ledger GROUP BY customer_id
  ),
  cust_orders AS (
    SELECT customer_id, COUNT(*) AS order_count
    FROM orders WHERE customer_id IS NOT NULL GROUP BY customer_id
  )
  SELECT c.id, c.name, c.phone, c.zalo_user_id, c.note,
         c.created_at, c.updated_at,
         COALESCE(cb.balance, 0)      AS balance,
         COALESCE(co.order_count, 0)  AS order_count
    FROM customers c
    LEFT JOIN cust_balance cb ON cb.customer_id = c.id
    LEFT JOIN cust_orders  co ON co.customer_id = c.id`;

/** Count matching customers. */
async function count(f = {}, conn) {
  const { where, params } = buildWhere(f);
  // Wrap the CTE so we can apply a WHERE on computed columns (balance).
  const sql = `SELECT COUNT(*) AS n FROM (${BASE_CTE} ${where}) AS t`;
  const [rows] = await db(conn).query(sql, params);
  return Number(rows[0].n);
}

/** Paginated list of customers with balance and order count. */
async function list({ q, debtOnly, zaloOnly, limit = 25, offset = 0 } = {}, conn) {
  const f = { q, debtOnly, zaloOnly };
  const { where, params } = buildWhere(f);
  const sql = `${BASE_CTE} ${where} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`;
  const [rows] = await db(conn).query(sql, [...params, limit, offset]);
  return rows;
}

/** Aggregate summary for the page header: total customers, customers with debt, total debt. */
async function summary(conn) {
  const [rows] = await db(conn).query(`
    SELECT COUNT(DISTINCT c.id)                                     AS total_customers,
           COUNT(DISTINCT CASE WHEN cb.balance > 0 THEN c.id END)  AS debt_customers,
           COALESCE(SUM(CASE WHEN cb.balance > 0 THEN cb.balance ELSE 0 END), 0) AS total_debt
      FROM customers c
      LEFT JOIN (
        SELECT customer_id, SUM(amount) AS balance
          FROM customer_ledger GROUP BY customer_id
      ) cb ON cb.customer_id = c.id`);
  return rows[0];
}

/** Single customer row (with balance). Returns null if not found. */
async function getById(id, conn) {
  const sql = `${BASE_CTE} WHERE c.id = ? LIMIT 1`;
  const [rows] = await db(conn).query(sql, [id]);
  return rows[0] || null;
}

/** Insert a new customer. Throws on duplicate phone/zalo_user_id (errno 1062). */
async function create({ name, phone = null, zalo_user_id = null, note = null } = {}, conn) {
  const [result] = await db(conn).query(
    'INSERT INTO customers (name, phone, zalo_user_id, note) VALUES (?, ?, ?, ?)',
    [name, phone || null, zalo_user_id || null, note || null]
  );
  return result.insertId;
}

/** Update mutable fields of a customer. Only non-undefined fields are written. */
async function update(id, { name, phone, zalo_user_id, note } = {}, conn) {
  const sets = [];
  const params = [];
  if (name !== undefined)         { sets.push('name = ?');         params.push(name); }
  if (phone !== undefined)        { sets.push('phone = ?');        params.push(phone || null); }
  if (zalo_user_id !== undefined) { sets.push('zalo_user_id = ?'); params.push(zalo_user_id || null); }
  if (note !== undefined)         { sets.push('note = ?');         params.push(note || null); }
  if (!sets.length) return;
  params.push(id);
  await db(conn).query(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, params);
}

/** Ledger history for a customer, newest first, up to `limit` rows. */
async function ledgerHistory(customerId, limit = 100, conn) {
  const [rows] = await db(conn).query(
    `SELECT l.id, l.entry_type, l.amount, l.method, l.note, l.created_at,
            l.order_id, o.order_code,
            u.username AS created_by_name
       FROM customer_ledger l
       LEFT JOIN orders o ON o.id = l.order_id
       LEFT JOIN users  u ON u.id = l.created_by
      WHERE l.customer_id = ?
      ORDER BY l.created_at DESC LIMIT ?`,
    [customerId, limit]
  );
  return rows;
}

/** Orders linked to a customer, newest first. */
async function orderHistory(customerId, limit = 50, conn) {
  const [rows] = await db(conn).query(
    `SELECT o.id, o.order_code, o.status, o.payment_status, o.total,
            o.created_at, o.completed_at, o.source
       FROM orders o
      WHERE o.customer_id = ?
      ORDER BY o.created_at DESC LIMIT ?`,
    [customerId, limit]
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debt reconciliation (đối chiếu công nợ) for a period [from, to)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row per customer with any ledger activity up to `to`:
 *   opening  = balance before `from`
 *   increase = debts + positive adjustments inside the period
 *   decrease = payments + negative adjustments inside the period (as a positive number)
 *   closing  = opening + increase - decrease
 */
async function reconciliation(from, to, { q, nonZeroOnly = true } = {}, conn) {
  const params = [from, from, to, from, to, to];
  let filter = '';
  if (q) { filter = 'AND (c.name LIKE ? OR c.phone LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  const [rows] = await db(conn).query(
    `SELECT c.id, c.name, c.phone,
            COALESCE(SUM(CASE WHEN l.created_at < ? THEN l.amount END), 0) AS opening,
            COALESCE(SUM(CASE WHEN l.created_at >= ? AND l.created_at < ? AND l.amount > 0 THEN l.amount END), 0) AS increase,
            COALESCE(-SUM(CASE WHEN l.created_at >= ? AND l.created_at < ? AND l.amount < 0 THEN l.amount END), 0) AS decrease,
            COALESCE(SUM(CASE WHEN l.created_at < ? THEN l.amount END), 0) AS closing
       FROM customers c JOIN customer_ledger l ON l.customer_id = c.id
      WHERE 1 = 1 ${filter}
      GROUP BY c.id, c.name, c.phone
      ORDER BY closing DESC, c.name`,
    params
  );
  const out = rows.map((r) => ({ ...r, opening: Number(r.opening), increase: Number(r.increase), decrease: Number(r.decrease), closing: Number(r.closing) }));
  return nonZeroOnly ? out.filter((r) => r.opening || r.increase || r.decrease || r.closing) : out;
}

/** Statement for one customer: opening balance, the period's ledger rows (oldest first), closing balance. */
async function statement(customerId, from, to, conn) {
  const [[open]] = await db(conn).query(
    'SELECT COALESCE(SUM(amount), 0) AS opening FROM customer_ledger WHERE customer_id = ? AND created_at < ?',
    [customerId, from]
  );
  const [rows] = await db(conn).query(
    `SELECT l.id, l.entry_type, l.amount, l.method, l.note, l.created_at, l.order_id, o.order_code
       FROM customer_ledger l LEFT JOIN orders o ON o.id = l.order_id
      WHERE l.customer_id = ? AND l.created_at >= ? AND l.created_at < ?
      ORDER BY l.created_at, l.id`,
    [customerId, from, to]
  );
  let run = Number(open.opening);
  const entries = rows.map((r) => { run += Number(r.amount); return { ...r, amount: Number(r.amount), balance: run }; });
  const increase = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  const decrease = -entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
  return { opening: Number(open.opening), entries, increase, decrease, closing: run };
}

async function findByZaloUser(zaloUserId, conn) {
  if (!zaloUserId) return null;
  const [rows] = await db(conn).query('SELECT * FROM customers WHERE zalo_user_id = ? LIMIT 1', [zaloUserId]);
  return rows[0] || null;
}

/**
 * Zalo accounts that messaged the bot in the last `days` days and are not linked to a customer yet: id, the
 * display name Zalo sent (Bot Platform: message.from.display_name; Bot Client: senderName), last message time
 * and how many Zalo orders they placed. For the "Gán Zalo" picker on the customers page.
 */
async function zaloSenders({ days = 60, limit = 50 } = {}, conn) {
  const [rows] = await db(conn).query(
    `SELECT e.sender_id AS zalo_user_id,
            MAX(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.message.from.display_name')),
                         JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.senderName')))) AS display_name,
            MAX(e.received_at) AS last_seen_at,
            (SELECT COUNT(*) FROM orders o WHERE o.source = 'zalo' AND o.zalo_user_id = e.sender_id) AS order_count
       FROM zalo_events e
       LEFT JOIN customers c ON c.zalo_user_id = e.sender_id
      WHERE e.sender_id IS NOT NULL AND e.sender_id <> '' AND c.id IS NULL
        AND e.received_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY e.sender_id
      ORDER BY last_seen_at DESC
      LIMIT ?`,
    [days, limit]
  );
  return rows.map((r) => ({ ...r, display_name: r.display_name === 'null' ? null : r.display_name }));
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

module.exports = {
  zaloSenders,
  // Admin CRUD & queries
  list, count, summary, getById, create, update, ledgerHistory, orderHistory, reconciliation, statement,
  // Zalo / POS integration (used by webhooks and order service)
  findByZaloUser, linkOrder, addEntry, topBalances,
};
