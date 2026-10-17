const { pool } = require('../config/db');

const db = (conn) => conn || pool;

/** Purchase slips (phiếu nhập kho), their lines and the payments made against them. */

async function insertReceipt({ supplierId = null, docNo = null, note = null, createdBy = null }, conn) {
  const [res] = await db(conn).query(
    'INSERT INTO purchase_receipts (supplier_id, doc_no, note, created_by) VALUES (?, ?, ?, ?)',
    [supplierId, docNo, note, createdBy]
  );
  const id = res.insertId;
  // PN + yymmdd (shop local date) + zero-padded id, like order codes
  await db(conn).query(
    `UPDATE purchase_receipts SET receipt_code = CONCAT('PN', DATE_FORMAT(created_at, '%y%m%d'), '-', LPAD(id, 5, '0')) WHERE id = ?`, [id]
  );
  return id;
}

async function insertLine(receiptId, l, conn) {
  await db(conn).query(
    `INSERT INTO purchase_receipt_lines (receipt_id, inventory_item_id, item_name, unit, pack_label, pack_qty, pack_factor, pack_price, quantity, unit_cost, line_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [receiptId, l.itemId, l.itemName, l.unit, l.packLabel || null, l.packQty, l.packFactor, l.packPrice, l.quantity, l.unitCost, l.lineTotal]
  );
}

async function setTotals(receiptId, total, paid, conn) {
  await db(conn).query('UPDATE purchase_receipts SET total = ?, paid = ? WHERE id = ?', [total, paid, receiptId]);
}

async function addPaid(receiptId, amount, conn) {
  await db(conn).query('UPDATE purchase_receipts SET paid = paid + ? WHERE id = ?', [amount, receiptId]);
}

async function insertPayment({ supplierId, receiptId = null, amount, method = 'cash', note = null, createdBy = null }, conn) {
  const [res] = await db(conn).query(
    'INSERT INTO supplier_payments (supplier_id, receipt_id, amount, method, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [supplierId, receiptId, amount, method, note, createdBy]
  );
  return res.insertId;
}

const RECEIPT_COLUMNS = `r.id, r.receipt_code, r.supplier_id, s.name AS supplier_name, r.doc_no, r.note, r.total, r.paid,
       r.total - r.paid AS debt, r.created_at, u.full_name AS user_name,
       (SELECT COUNT(*) FROM purchase_receipt_lines l WHERE l.receipt_id = r.id) AS line_count`;
const RECEIPT_FROM = `FROM purchase_receipts r LEFT JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN users u ON u.id = r.created_by`;

function buildFilter({ supplierId, from, to, q, onlyDebt } = {}) {
  const where = [];
  const params = [];
  if (supplierId) { where.push('r.supplier_id = ?'); params.push(supplierId); }
  if (from) { where.push('r.created_at >= ?'); params.push(from); }
  if (to) { where.push('r.created_at < ?'); params.push(to); }
  if (onlyDebt) where.push('r.total - r.paid > 0');
  if (q) {
    where.push("(r.receipt_code LIKE ? ESCAPE '\\\\' OR r.doc_no LIKE ? ESCAPE '\\\\' OR s.name LIKE ? ESCAPE '\\\\')");
    const like = `%${String(q).replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

async function listReceipts({ limit = 20, offset = 0, ...filter } = {}, conn) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db(conn).query(
    `SELECT ${RECEIPT_COLUMNS} ${RECEIPT_FROM} ${clause} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(Number(limit) || 20, 200), Number(offset) || 0]
  );
  return rows;
}

async function countReceipts(filter = {}, conn) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db(conn).query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(r.total), 0) AS total, COALESCE(SUM(r.paid), 0) AS paid ${RECEIPT_FROM} ${clause}`, params
  );
  return { n: Number(rows[0].n), total: Number(rows[0].total), paid: Number(rows[0].paid) };
}

async function getReceipt(id, conn, { forUpdate = false } = {}) {
  if (forUpdate) {
    const [locked] = await db(conn).query('SELECT * FROM purchase_receipts WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
    return locked[0] || null;
  }
  const [rows] = await db(conn).query(`SELECT ${RECEIPT_COLUMNS} ${RECEIPT_FROM} WHERE r.id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

async function getLines(receiptId, conn) {
  const [rows] = await db(conn).query('SELECT * FROM purchase_receipt_lines WHERE receipt_id = ? ORDER BY id', [receiptId]);
  return rows;
}

async function receiptPayments(receiptId, conn) {
  const [rows] = await db(conn).query(
    `SELECT p.id, p.amount, p.method, p.note, p.paid_at, u.full_name AS user_name
       FROM supplier_payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.receipt_id = ? ORDER BY p.id`, [receiptId]
  );
  return rows;
}

async function supplierPayments(supplierId, limit = 50, conn) {
  const [rows] = await db(conn).query(
    `SELECT p.id, p.amount, p.method, p.note, p.paid_at, p.receipt_id, r.receipt_code, u.full_name AS user_name
       FROM supplier_payments p LEFT JOIN purchase_receipts r ON r.id = p.receipt_id LEFT JOIN users u ON u.id = p.created_by
      WHERE p.supplier_id = ? ORDER BY p.id DESC LIMIT ?`, [supplierId, Math.min(Number(limit) || 50, 200)]
  );
  return rows;
}

/** Receipts of a supplier that still owe money, oldest first, locked for the payment that follows. */
async function unpaidReceipts(supplierId, conn) {
  const [rows] = await db(conn).query(
    'SELECT id, receipt_code, total, paid FROM purchase_receipts WHERE supplier_id = ? AND total > paid ORDER BY id FOR UPDATE', [supplierId]
  );
  return rows;
}

module.exports = {
  insertReceipt, insertLine, setTotals, addPaid, insertPayment,
  listReceipts, countReceipts, getReceipt, getLines, receiptPayments, supplierPayments, unpaidReceipts,
};
