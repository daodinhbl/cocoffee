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

/** Payments that need a person: money arrived but could not be applied. */
async function listNeedingAttention(limit = 20, conn) {
  const [rows] = await db(conn).query(
    `SELECT ${COLUMNS}, o.order_code FROM payon_payments p LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'manual' ORDER BY p.id DESC LIMIT ?`, [limit]
  );
  return rows;
}

/**
 * Atomically takes a payment for applying: pending (or manual, for a retry) -> applying, recording what PayOn reported.
 * False when somebody else already took it, so a notification and a status check arriving together apply it once.
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

async function finish(id, status, note, conn) {
  await db(conn).query('UPDATE payon_payments SET status = ?, note = ? WHERE id = ?', [status, note ? String(note).slice(0, 255) : null, id]);
}

/** A claim that never finished (process died between claim and finish) goes back to pending. */
async function releaseStale(minutes, conn) {
  await db(conn).query(
    "UPDATE payon_payments SET status = 'pending' WHERE status = 'applying' AND updated_at < NOW() - INTERVAL ? MINUTE", [minutes]
  );
}

module.exports = { create, setQr, getById, getByRequestId, listForOrder, listNeedingAttention, claim, finish, releaseStale };
