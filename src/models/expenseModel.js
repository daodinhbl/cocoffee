const { pool } = require('../config/db');

const db = (conn) => conn || pool;

/** Operating expenses (sổ chi phí) and their categories (danh mục chi phí, with the tax treatment of each). */

// ------------------------------------------------------------------ categories
async function listCategories({ activeOnly = false } = {}, conn) {
  const [rows] = await db(conn).query(
    `SELECT c.*, (SELECT COUNT(*) FROM expenses e WHERE e.category_id = c.id AND e.status = 'posted') AS uses
       FROM expense_categories c ${activeOnly ? 'WHERE c.is_active = 1' : ''} ORDER BY c.sort_order, c.name`
  );
  return rows;
}

async function getCategory(id, conn) {
  const [rows] = await db(conn).query('SELECT * FROM expense_categories WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function categoryByCode(code, conn) {
  const [rows] = await db(conn).query('SELECT * FROM expense_categories WHERE code = ? LIMIT 1', [code]);
  return rows[0] || null;
}

async function createCategory({ code, name, taxTreatment, ledgerCode, sortOrder }, conn) {
  const [res] = await db(conn).query(
    'INSERT INTO expense_categories (code, name, tax_treatment, ledger_code, sort_order) VALUES (?, ?, ?, ?, ?)',
    [code, name, taxTreatment, ledgerCode || null, sortOrder || 0]
  );
  return res.insertId;
}

async function updateCategory(id, { name, taxTreatment, ledgerCode, sortOrder, isActive }, conn) {
  await db(conn).query(
    `UPDATE expense_categories SET name = COALESCE(?, name), tax_treatment = COALESCE(?, tax_treatment), ledger_code = ?,
            sort_order = COALESCE(?, sort_order), is_active = COALESCE(?, is_active) WHERE id = ?`,
    [name ?? null, taxTreatment ?? null, ledgerCode || null, sortOrder ?? null, isActive ?? null, id]
  );
}

// ------------------------------------------------------------------ expenses
const COLUMNS = `e.id, e.expense_date, e.category_id, c.name AS category_name, c.tax_treatment, e.amount, e.vat_included, e.payee,
       e.supplier_id, e.purchase_receipt_id, r.receipt_code, e.doc_no, e.note, e.receipt_media_id, e.source, e.status,
       e.void_reason, e.created_at, u.full_name AS user_name`;
const FROM = `FROM expenses e JOIN expense_categories c ON c.id = e.category_id
       LEFT JOIN purchase_receipts r ON r.id = e.purchase_receipt_id LEFT JOIN users u ON u.id = e.created_by`;

function buildFilter({ q, categoryId, from, to, source, status } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('e.status = ?'); params.push(status); }
  if (categoryId) { where.push('e.category_id = ?'); params.push(categoryId); }
  if (source) { where.push('e.source = ?'); params.push(source); }
  if (from) { where.push('e.expense_date >= ?'); params.push(from); }
  if (to) { where.push('e.expense_date <= ?'); params.push(to); }
  if (q) {
    where.push("(e.payee LIKE ? ESCAPE '\\\\' OR e.note LIKE ? ESCAPE '\\\\' OR e.doc_no LIKE ? ESCAPE '\\\\')");
    const like = `%${String(q).replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

async function list({ limit = 20, offset = 0, ...filter } = {}, conn) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db(conn).query(
    `SELECT ${COLUMNS} ${FROM} ${clause} ORDER BY e.expense_date DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(Number(limit) || 20, 200), Number(offset) || 0]
  );
  return rows;
}

/** Row count and the money of the POSTED rows of a filter (void rows are listed but never summed). */
async function totals(filter = {}, conn) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db(conn).query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN e.status = 'posted' THEN e.amount END), 0) AS amount,
            COALESCE(SUM(CASE WHEN e.status = 'posted' AND e.source = 'purchase' THEN e.amount END), 0) AS purchases,
            COALESCE(SUM(CASE WHEN e.status = 'posted' AND c.tax_treatment = 'deductible' THEN e.amount END), 0) AS deductible
       ${FROM} ${clause}`, params
  );
  const r = rows[0];
  return { n: Number(r.n), amount: Number(r.amount), purchases: Number(r.purchases), manual: Number(r.amount) - Number(r.purchases), deductible: Number(r.deductible) };
}

/** Posted money per category over [from, to], biggest first. */
async function byCategory({ from, to }, conn) {
  const [rows] = await db(conn).query(
    `SELECT c.id, c.name, COALESCE(SUM(e.amount), 0) AS amount, COUNT(e.id) AS n
       FROM expense_categories c JOIN expenses e ON e.category_id = c.id AND e.status = 'posted' AND e.expense_date >= ? AND e.expense_date <= ?
      GROUP BY c.id, c.name ORDER BY amount DESC`, [from, to]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, amount: Number(r.amount), n: Number(r.n) }));
}

/** Newest first by id, keyset-paged for the app: rows with id < beforeId. Voided rows are listed (status says so). */
async function listPage({ beforeId, limit = 30, ...filter } = {}, conn) {
  const { clause, params } = buildFilter(filter);
  const cond = beforeId ? `${clause ? `${clause} AND` : 'WHERE'} e.id < ?` : clause;
  const [rows] = await db(conn).query(
    `SELECT ${COLUMNS} ${FROM} ${cond} ORDER BY e.id DESC LIMIT ?`,
    [...params, ...(beforeId ? [beforeId] : []), Math.min(Number(limit) || 30, 100)]
  );
  return rows;
}

/** Posted expenses of [from, to] after `afterId`, oldest id first: the export reads them in pages, never all at once. */
async function exportBatch({ from, to, afterId = 0, limit = 1000 }, conn) {
  const [rows] = await db(conn).query(
    `SELECT e.id, e.expense_date, c.name AS category_name, c.ledger_code, c.tax_treatment, e.payee, e.doc_no, e.amount, e.vat_included, e.source, e.note
       FROM expenses e JOIN expense_categories c ON c.id = e.category_id
      WHERE e.status = 'posted' AND e.expense_date >= ? AND e.expense_date <= ? AND e.id > ? ORDER BY e.id LIMIT ?`,
    [from, to, afterId, limit]
  );
  return rows;
}

async function getById(id, conn, { forUpdate = false } = {}) {
  if (forUpdate) {                                       // plain row lock: no JOIN, so other tables are not locked as a side effect
    const [locked] = await db(conn).query('SELECT * FROM expenses WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
    return locked[0] || null;
  }
  const [rows] = await db(conn).query(`SELECT ${COLUMNS}, e.receipt_sha256 ${FROM} WHERE e.id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

async function insert(e, conn) {
  const [res] = await db(conn).query(
    `INSERT INTO expenses (expense_date, category_id, amount, vat_included, payee, supplier_id, purchase_receipt_id, doc_no, note,
                           receipt_media_id, receipt_sha256, source, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.expenseDate, e.categoryId, e.amount, e.vatIncluded ? 1 : 0, e.payee || null, e.supplierId || null, e.purchaseReceiptId || null,
      e.docNo || null, e.note || null, e.receiptMediaId || null, e.receiptSha256 || null, e.source || 'manual', e.createdBy || null]
  );
  return res.insertId;
}

async function update(id, e, conn) {
  await db(conn).query(
    `UPDATE expenses SET expense_date = COALESCE(?, expense_date), category_id = COALESCE(?, category_id), amount = COALESCE(?, amount),
            vat_included = COALESCE(?, vat_included), payee = ?, doc_no = ?, note = ? WHERE id = ?`,
    [e.expenseDate ?? null, e.categoryId ?? null, e.amount ?? null, e.vatIncluded === undefined ? null : (e.vatIncluded ? 1 : 0), e.payee || null, e.docNo || null, e.note || null, id]
  );
}

async function setCategoryAndNote(id, { categoryId, note }, conn) {
  await db(conn).query('UPDATE expenses SET category_id = COALESCE(?, category_id), note = ? WHERE id = ?', [categoryId ?? null, note || null, id]);
}

async function setReceipt(id, mediaId, sha256, conn) {
  await db(conn).query('UPDATE expenses SET receipt_media_id = ?, receipt_sha256 = ? WHERE id = ?', [mediaId || null, sha256 || null, id]);
}

async function voidExpense(id, reason, userId, conn) {
  await db(conn).query("UPDATE expenses SET status = 'void', void_reason = ?, voided_by = ? WHERE id = ?", [reason || null, userId || null, id]);
}

/** A POSTED expense that already uses this photo (same SHA-256), other than `exceptId`. */
async function findBySha(sha256, exceptId = 0, conn) {
  const [rows] = await db(conn).query(
    "SELECT id, expense_date, amount FROM expenses WHERE receipt_sha256 = ? AND status = 'posted' AND id <> ? LIMIT 1", [sha256, exceptId]
  );
  return rows[0] || null;
}

module.exports = {
  listCategories, getCategory, categoryByCode, createCategory, updateCategory,
  list, listPage, totals, byCategory, exportBatch, getById, insert, update, setCategoryAndNote, setReceipt, voidExpense, findBySha,
};
