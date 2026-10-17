const { pool } = require('../config/db');

const db = (conn) => conn || pool;

/**
 * Suppliers (nhà cung cấp) with what we bought from them and what is still owed:
 *   purchased = sum of receipt totals, paid = sum of what was paid on them, debt = purchased - paid.
 */
const TOTALS = `LEFT JOIN (
    SELECT supplier_id, COUNT(*) AS receipts, SUM(total) AS purchased, SUM(paid) AS paid, MAX(created_at) AS last_at
      FROM purchase_receipts WHERE supplier_id IS NOT NULL GROUP BY supplier_id
  ) t ON t.supplier_id = s.id`;
const COLUMNS = `s.id, s.name, s.phone, s.address, s.tax_code, s.note, s.is_active, s.created_at,
       COALESCE(t.receipts, 0) AS receipts, COALESCE(t.purchased, 0) AS purchased, COALESCE(t.paid, 0) AS paid,
       COALESCE(t.purchased, 0) - COALESCE(t.paid, 0) AS debt, t.last_at`;

function buildFilter({ q, onlyDebt, active } = {}) {
  const where = [];
  const params = [];
  if (q) { where.push("(s.name LIKE ? ESCAPE '\\\\' OR s.phone LIKE ? ESCAPE '\\\\')"); const like = `%${String(q).replace(/[\\%_]/g, '\\$&')}%`; params.push(like, like); }
  if (onlyDebt) where.push('COALESCE(t.purchased, 0) - COALESCE(t.paid, 0) > 0');
  if (active !== undefined) { where.push('s.is_active = ?'); params.push(active ? 1 : 0); }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

async function list({ q, onlyDebt, active, limit = 20, offset = 0 } = {}, conn) {
  const { clause, params } = buildFilter({ q, onlyDebt, active });
  const [rows] = await db(conn).query(
    `SELECT ${COLUMNS} FROM suppliers s ${TOTALS} ${clause} ORDER BY s.is_active DESC, s.name LIMIT ? OFFSET ?`,
    [...params, Math.min(Number(limit) || 20, 500), Number(offset) || 0]
  );
  return rows;
}

async function count(filter = {}, conn) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db(conn).query(`SELECT COUNT(*) AS n FROM suppliers s ${TOTALS} ${clause}`, params);
  return Number(rows[0].n);
}

/** Active suppliers for a <select> (id + name only). */
async function options(conn) {
  const [rows] = await db(conn).query('SELECT id, name FROM suppliers WHERE is_active = 1 ORDER BY name');
  return rows;
}

async function getById(id, conn, { forUpdate = false } = {}) {
  if (forUpdate) {
    const [locked] = await db(conn).query('SELECT * FROM suppliers WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
    return locked[0] || null;
  }
  const [rows] = await db(conn).query(`SELECT ${COLUMNS} FROM suppliers s ${TOTALS} WHERE s.id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

async function findByName(name, conn) {
  const [rows] = await db(conn).query('SELECT id, name, is_active FROM suppliers WHERE name = ? LIMIT 1', [name]);
  return rows[0] || null;
}

async function create({ name, phone, address, tax_code, note }, conn) {
  const [res] = await db(conn).query(
    'INSERT INTO suppliers (name, phone, address, tax_code, note) VALUES (?, ?, ?, ?, ?)',
    [name, phone || null, address || null, tax_code || null, note || null]
  );
  return res.insertId;
}

async function update(id, { name, phone, address, tax_code, note, is_active }, conn) {
  await db(conn).query(
    `UPDATE suppliers SET name = COALESCE(?, name), phone = ?, address = ?, tax_code = ?, note = ?,
            is_active = COALESCE(?, is_active) WHERE id = ?`,
    [name ?? null, phone || null, address || null, tax_code || null, note || null, is_active ?? null, id]
  );
}

/** Totals over all suppliers, for the summary cards. */
async function totals(conn) {
  const [rows] = await db(conn).query(
    `SELECT COUNT(*) AS suppliers, COALESCE(SUM(t.purchased), 0) AS purchased, COALESCE(SUM(t.paid), 0) AS paid,
            COALESCE(SUM(CASE WHEN t.purchased - t.paid > 0 THEN 1 END), 0) AS in_debt
       FROM suppliers s ${TOTALS} WHERE s.is_active = 1`
  );
  const r = rows[0];
  return { suppliers: Number(r.suppliers), purchased: Number(r.purchased), paid: Number(r.paid), debt: Number(r.purchased) - Number(r.paid), inDebt: Number(r.in_debt) };
}

module.exports = { list, count, options, getById, findByName, create, update, totals };
