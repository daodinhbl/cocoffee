const { pool } = require('../config/db');

const db = (conn) => conn || pool;

async function list(conn) {
  const [rows] = await db(conn).query(
    `SELECT t.id, t.code, t.name, t.capacity, t.status, t.current_order_id, t.is_active,
            o.order_code AS current_order_code, o.total AS current_order_total
       FROM dining_tables t
       LEFT JOIN orders o ON o.id = t.current_order_id
      WHERE t.is_active = 1
      ORDER BY t.code`
  );
  return rows;
}

/** Admin view: inactive tables included. */
async function listAll(conn) {
  const [rows] = await db(conn).query(
    `SELECT t.id, t.code, t.name, t.capacity, t.status, t.current_order_id, t.is_active,
            o.order_code AS current_order_code, o.total AS current_order_total
       FROM dining_tables t LEFT JOIN orders o ON o.id = t.current_order_id
      ORDER BY t.is_active DESC, t.code`
  );
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
    "UPDATE dining_tables SET status = 'serving', current_order_id = ? WHERE id = ?",
    [orderId, id]
  );
}

async function release(id, conn) {
  await db(conn).query(
    "UPDATE dining_tables SET status = 'available', current_order_id = NULL WHERE id = ?",
    [id]
  );
}

module.exports = { list, listAll, getById, create, update, setServing, release };
