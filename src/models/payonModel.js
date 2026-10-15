const { pool } = require('../config/db');

/** QR payments made through PayOn (table payon_payments): one row per QR shown to a customer. */
const db = (conn) => conn || pool;

const COLUMNS = `p.id, p.merchant_request_id, p.kind, p.order_id, p.customer_id, p.amount, p.status, p.payon_status, p.payment_id,
  p.transaction_id, p.received, p.fee, p.qr_pay, p.qr_image, p.expires_at, p.paid_at, p.note, p.created_by, p.created_at, p.updated_at`;

async function create({ requestId, kind = 'order', orderId = null, customerId = null, amount, expiresAt, userId = null }, conn) {
  const [res] = await db(conn).query(
    `INSERT INTO payon_payments (merchant_request_id, kind, order_id, customer_id, amount, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [requestId, kind, orderId, customerId, amount, expiresAt, userId]
  );
  return res.insertId;
}

/** Fills in what PayOn answered when the QR was created. */
async function setQr(id, { paymentId, qrPay, qrImage, expiresAt }, conn) {
  await db(conn).query(
    'UPDATE payon_payments SET payment_id = ?, qr_pay = ?, qr_image = ?, expires_at = COALESCE(?, expires_at) WHERE id = ?',
    [paymentId == null ? null : String(paymentId), qrPay || null, qrImage || null, expiresAt || null, id]
  );
}

async function getById(id, conn) {
  const [rows] = await db(conn).query(`SELECT ${COLUMNS} FROM payon_payments p WHERE p.id = ?`, [id]);
  return rows[0] || null;
}

async function getByRequestId(requestId, conn) {
  const [rows] = await db(conn).query(`SELECT ${COLUMNS} FROM payon_payments p WHERE p.merchant_request_id = ?`, [requestId]);
  return rows[0] || null;
}

/** Newest first. */
async function listForOrder(orderId, limit = 5, conn) {
  const [rows] = await db(conn).query(`SELECT ${COLUMNS} FROM payon_payments p WHERE p.order_id = ? ORDER BY p.id DESC LIMIT ?`, [orderId, limit]);
  return rows;
}

/** Payments that need a person: money arrived but could not be applied. Newest first, with the order code. */
async function listNeedingAttention(limit = 50, conn) {
  const [rows] = await db(conn).query(
    `SELECT ${COLUMNS}, o.order_code FROM payon_payments p LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'manual' ORDER BY p.id DESC LIMIT ?`, [limit]
  );
  return rows;
}

async function countNeedingAttention(conn) {
  const [rows] = await db(conn).query("SELECT COUNT(*) AS n FROM payon_payments WHERE status = 'manual'");
  return Number(rows[0].n);
}

/** Latest payments of every status (the admin list's history part), with the order code. */
async function listRecent(limit = 30, conn) {
  const [rows] = await db(conn).query(
    `SELECT ${COLUMNS}, o.order_code FROM payon_payments p LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.status <> 'failed' ORDER BY p.id DESC LIMIT ?`, [limit]
  );
  return rows;
}

/**
 * Atomically takes a payment for applying (pending / manual for a retry / expired or failed when the money arrived late)
 * -> applying, recording what PayOn reported. False when somebody else already took it, so a notification and a status
 * check arriving together apply it once.
 */
async function claim(id, fromStatuses, { payonStatus, paymentId, transactionId, received, fee, paidAt }, conn) {
  const [res] = await db(conn).query(
    `UPDATE payon_payments
        SET status = 'applying', payon_status = ?, payment_id = COALESCE(?, payment_id), transaction_id = ?, received = ?, fee = ?,
            paid_at = ?
      WHERE id = ? AND status IN (?)`,
    [payonStatus, paymentId == null ? null : String(paymentId), transactionId == null ? null : String(transactionId), received, fee, paidAt, id, fromStatuses]
  );
  return res.affectedRows === 1;
}

/**
 * Sets the final state, but only from the state the caller saw (default: still being applied), so a settled payment is never
 * overwritten by a stale "failed" / "expired" decision. @returns {Promise<boolean>} whether the row changed
 */
async function finish(id, status, note, fromStatuses = ['applying'], conn) {
  const [res] = await db(conn).query(
    'UPDATE payon_payments SET status = ?, note = ? WHERE id = ? AND status IN (?)',
    [status, note ? String(note).slice(0, 255) : null, id, fromStatuses]
  );
  return res.affectedRows === 1;
}

/** Claims that never finished (the process died between claim and finish), oldest first. */
async function listStaleApplying(minutes, limit = 20, conn) {
  const [rows] = await db(conn).query(
    `SELECT ${COLUMNS} FROM payon_payments p WHERE p.status = 'applying' AND p.updated_at < NOW() - INTERVAL ? MINUTE ORDER BY p.id LIMIT ?`,
    [minutes, limit]
  );
  return rows;
}

/** Back to pending (a stale claim with nothing applied): the next notification or check applies it. */
async function release(id, conn) {
  const [res] = await db(conn).query("UPDATE payon_payments SET status = 'pending' WHERE id = ? AND status = 'applying'", [id]);
  return res.affectedRows === 1;
}

module.exports = {
  create, setQr, getById, getByRequestId, listForOrder, listNeedingAttention, countNeedingAttention, listRecent,
  claim, finish, listStaleApplying, release,
};
