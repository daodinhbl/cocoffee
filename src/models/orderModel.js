const { pool } = require('../config/db');

const db = (conn) => conn || pool;

async function insert(
  { tableId = null, source = 'pos', status = 'open', zaloUserId = null, zaloChatType = null,
    zaloChatId = null, note = null, discount = 0, createdBy = null },
  conn
) {
  const [res] = await db(conn).query(
    `INSERT INTO orders (table_id, source, status, zalo_user_id, zalo_chat_type, zalo_chat_id, note, discount, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tableId, source, status, zaloUserId, zaloChatType, zaloChatId, note, discount, createdBy]
  );
  const id = res.insertId;
  // CF + yymmdd (shop local date) + zero-padded id: unique without a separate counter table.
  await db(conn).query(
    `UPDATE orders SET order_code = CONCAT('CF', DATE_FORMAT(created_at, '%y%m%d'), '-', LPAD(id, 5, '0')) WHERE id = ?`,
    [id]
  );
  return id;
}

async function getById(id, conn, { forUpdate = false } = {}) {
  if (forUpdate) {
    // plain row lock: no JOIN, so dining_tables rows are not locked as a side effect
    const [locked] = await db(conn).query('SELECT * FROM orders WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
    return locked[0] || null;
  }
  const [rows] = await db(conn).query(
    `SELECT o.*, t.code AS table_code, t.name AS table_name, c.name AS customer_name
       FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id
                     LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function setDiscount(orderId, discount, conn) {
  await db(conn).query('UPDATE orders SET discount = ? WHERE id = ?', [discount, orderId]);
  await recalcTotals(orderId, conn);
}

async function getItems(orderId, conn) {
  const [rows] = await db(conn).query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
  return rows;
}

/** Replace all lines and recompute subtotal/total. lines: [{product_id, product_name, unit_price, quantity, note}] */
async function replaceItems(orderId, lines, conn) {
  await db(conn).query('DELETE FROM order_items WHERE order_id = ?', [orderId]);
  if (lines.length) {
    await db(conn).query(
      `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total, note) VALUES ?`,
      [lines.map((l) => [orderId, l.product_id, l.product_name, l.unit_price, l.quantity, l.unit_price * l.quantity, l.note || null])]
    );
  }
  await recalcTotals(orderId, conn);
}

async function recalcTotals(orderId, conn) {
  await db(conn).query(
    `UPDATE orders o
       JOIN (SELECT COALESCE(SUM(line_total), 0) AS s FROM order_items WHERE order_id = ?) x
        SET o.subtotal = x.s, o.total = GREATEST(0, x.s - o.discount)
      WHERE o.id = ?`,
    [orderId, orderId]
  );
}

async function setItemCogs(itemId, unitCogs, lineCogs, conn) {
  await db(conn).query('UPDATE order_items SET unit_cogs = ?, line_cogs = ? WHERE id = ?', [unitCogs, lineCogs, itemId]);
}

async function markCompleted(orderId, cogsTotal, conn) {
  await db(conn).query(
    "UPDATE orders SET status = 'completed', cogs_total = ?, completed_at = NOW() WHERE id = ?",
    [cogsTotal, orderId]
  );
}

async function markPaid(orderId, method, conn) {
  await db(conn).query(
    "UPDATE orders SET payment_status = 'paid', payment_method = ?, paid_at = NOW() WHERE id = ?",
    [method, orderId]
  );
}

async function markCancelled(orderId, conn) {
  await db(conn).query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [orderId]);
}

async function insertPayment({ orderId, method, amount, reference = null, userId = null }, conn) {
  await db(conn).query(
    'INSERT INTO payments (order_id, method, amount, reference, received_by) VALUES (?, ?, ?, ?, ?)',
    [orderId, method, amount, reference, userId]
  );
}

async function markReceipt(orderId, error, conn) {
  if (error) {
    await db(conn).query('UPDATE orders SET receipt_error = ? WHERE id = ?', [String(error).slice(0, 255), orderId]);
  } else {
    await db(conn).query('UPDATE orders SET receipt_sent_at = NOW(), receipt_error = NULL WHERE id = ?', [orderId]);
  }
}

/** WHERE clause shared by list() and count(). `q` matches the order code (LIKE wildcards escaped). */
function buildFilter({ status, excludeStatuses, source, paymentStatus, tableId, from, to, q, updatedAfter } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (excludeStatuses?.length) { where.push('o.status NOT IN (?)'); params.push(excludeStatuses); }
  if (source) { where.push('o.source = ?'); params.push(source); }
  if (paymentStatus) { where.push('o.payment_status = ?'); params.push(paymentStatus); }
  if (tableId) { where.push('o.table_id = ?'); params.push(tableId); }
  if (from) { where.push('o.created_at >= ?'); params.push(from); }
  if (to) { where.push('o.created_at < ?'); params.push(to); }
  if (q) { where.push("o.order_code LIKE ? ESCAPE '\\\\'"); params.push(`%${String(q).replace(/[\\%_]/g, '\\$&')}%`); }
  if (updatedAfter) { where.push('o.updated_at >= ?'); params.push(updatedAfter); }
  return { where, params };
}

async function count(filter = {}, conn) {
  const { where, params } = buildFilter(filter);
  const [rows] = await db(conn).query(
    `SELECT COUNT(*) AS n FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params
  );
  return rows[0].n;
}

async function getPayments(orderId, conn) {
  const [rows] = await db(conn).query(
    `SELECT p.id, p.method, p.amount, p.reference, p.paid_at, u.full_name AS received_by_name
       FROM payments p LEFT JOIN users u ON u.id = p.received_by
      WHERE p.order_id = ? ORDER BY p.id`,
    [orderId]
  );
  return rows;
}

/** Batch forms of getById / getItems / getPayments for many orders at once (3 queries instead of 3 per order). */
async function getFullByIds(ids, conn) {
  if (!ids.length) return [];
  const [rows] = await db(conn).query(
    `SELECT o.*, t.code AS table_code, t.name AS table_name, c.name AS customer_name
       FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id
                     LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id IN (?)`,
    [ids]
  );
  return rows;
}

async function getItemsByOrderIds(ids, conn) {
  if (!ids.length) return [];
  const [rows] = await db(conn).query('SELECT * FROM order_items WHERE order_id IN (?) ORDER BY id', [ids]);
  return rows;
}

async function getPaymentsByOrderIds(ids, conn) {
  if (!ids.length) return [];
  const [rows] = await db(conn).query(
    `SELECT p.id, p.order_id, p.method, p.amount, p.reference, p.paid_at, u.full_name AS received_by_name
       FROM payments p LEFT JOIN users u ON u.id = p.received_by
      WHERE p.order_id IN (?) ORDER BY p.id`,
    [ids]
  );
  return rows;
}

async function list({ limit = 50, offset = 0, ...filter } = {}, conn) {
  const { where, params } = buildFilter(filter);
  const [rows] = await db(conn).query(
    `SELECT o.id, o.order_code, o.source, o.status, o.payment_status, o.payment_method, o.total,
            o.cogs_total, o.table_id, t.code AS table_code, o.zalo_user_id, o.zalo_chat_type, o.note,
            o.receipt_sent_at, o.receipt_error, o.created_at, o.completed_at, o.customer_id, c.name AS customer_name,
            (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id
                     LEFT JOIN customers c ON c.id = o.customer_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(Number(limit) || 50, 200), Number(offset) || 0]
  );
  return rows;
}

/**
 * Counts and amounts per status for the list's tabs and summary cards. Uses every filter EXCEPT the
 * status/payment ones, so each tab shows what clicking it would give.
 */
async function breakdown({ source, tableId, from, to, q, updatedAfter } = {}, conn) {
  const { where, params } = buildFilter({ source, tableId, from, to, q, updatedAfter });
  const [rows] = await db(conn).query(
    `SELECT o.status, o.payment_status, COUNT(*) AS n, COALESCE(SUM(o.total), 0) AS amount
       FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY o.status, o.payment_status`,
    params
  );
  const out = { all: 0, draft: 0, open: 0, completed: 0, cancelled: 0, unpaid: 0, revenue: 0, unpaidAmount: 0, openAmount: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    const amount = Number(r.amount);
    out.all += n;
    out[r.status] += n;
    if (r.status === 'completed') out.revenue += amount;
    if (r.status === 'completed' && r.payment_status === 'unpaid') { out.unpaid += n; out.unpaidAmount += amount; }
    if (r.status === 'open') out.openAmount += amount;
  }
  return out;
}

/** Revenue / COGS / gross profit over completed orders in [from, to). */
async function summary(from, to, conn) {
  const [rows] = await db(conn).query(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(cogs_total), 0) AS cogs,
            COALESCE(SUM(total - cogs_total), 0) AS gross_profit,
            COALESCE(SUM(CASE WHEN payment_status = 'unpaid' THEN total END), 0) AS unpaid
       FROM orders WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?`,
    [from, to]
  );
  return rows[0];
}

module.exports = {
  insert, getById, getItems, replaceItems, recalcTotals, setDiscount, setItemCogs, markCompleted, markPaid,
  markCancelled, insertPayment, markReceipt, getFullByIds, getItemsByOrderIds, getPaymentsByOrderIds, list, count, getPayments, summary, breakdown,
};
