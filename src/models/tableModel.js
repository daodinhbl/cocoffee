const { pool } = require('../config/db');

const db = (conn) => conn || pool;

// merged_into / merged_order_id: a table merged into another one (ghép bàn) has no order of its own; it shares
// the open order of its primary table.
const COLUMNS = `t.id, t.code, t.name, t.capacity, t.status, t.current_order_id, t.merged_into, t.is_active,
            o.order_code AS current_order_code, o.total AS current_order_total,
            p.current_order_id AS merged_order_id, p.name AS merged_into_name`;
const FROM = `FROM dining_tables t
       LEFT JOIN orders o ON o.id = t.current_order_id
       LEFT JOIN dining_tables p ON p.id = t.merged_into`;

async function list(conn) {
  const [rows] = await db(conn).query(`SELECT ${COLUMNS} ${FROM} WHERE t.is_active = 1 ORDER BY t.code`);
  return rows;
}

/** Admin view: inactive tables included. */
async function listAll(conn) {
  const [rows] = await db(conn).query(`SELECT ${COLUMNS} ${FROM} ORDER BY t.is_active DESC, t.code`);
  return rows;
}

async function getById(id, conn, { forUpdate = false } = {}) {
  const [rows] = await db(conn).query(
    `SELECT * FROM dining_tables WHERE id = ? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id]
  );
  return rows[0] || null;
}

async function create({ code, name, capacity }, conn) {
  const [res] = await db(conn).query(
    'INSERT INTO dining_tables (code, name, capacity) VALUES (?, ?, ?)',
    [code, name, capacity || 4]
  );
  return res.insertId;
}

async function update(id, { code, name, capacity, is_active }, conn) {
  await db(conn).query(
    `UPDATE dining_tables
        SET code = COALESCE(?, code), name = COALESCE(?, name),
            capacity = COALESCE(?, capacity), is_active = COALESCE(?, is_active)
      WHERE id = ?`,
    [code ?? null, name ?? null, capacity ?? null, is_active ?? null, id]
  );
}

async function setServing(id, orderId, conn) {
  await db(conn).query(
    "UPDATE dining_tables SET status = 'serving', current_order_id = ?, merged_into = NULL WHERE id = ?",
    [orderId, id]
  );
}

/** Ghép bàn: the table stays occupied but shares the open order of `primaryId`. */
async function setMerged(id, primaryId, conn) {
  await db(conn).query(
    "UPDATE dining_tables SET status = 'serving', current_order_id = NULL, merged_into = ? WHERE id = ?",
    [primaryId, id]
  );
}

/** Tables merged into `primaryId`, oldest id first. */
async function mergedInto(primaryId, conn, { forUpdate = false } = {}) {
  const [rows] = await db(conn).query(
    `SELECT id, code, name FROM dining_tables WHERE merged_into = ? ORDER BY id${forUpdate ? ' FOR UPDATE' : ''}`,
    [primaryId]
  );
  return rows;
}

/** Frees the table and every table that was merged into it. */
async function release(id, conn) {
  await db(conn).query(
    "UPDATE dining_tables SET status = 'available', current_order_id = NULL, merged_into = NULL WHERE id = ? OR merged_into = ?",
    [id, id]
  );
}

module.exports = { list, listAll, getById, create, update, setServing, setMerged, mergedInto, release };
