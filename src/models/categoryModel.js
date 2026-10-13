const { pool } = require('../config/db');

const db = (conn) => conn || pool;

async function list({ activeOnly = true } = {}, conn) {
  const [rows] = await db(conn).query(
    `SELECT id, code, name, sort_order, is_active FROM categories
      ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order, id`
  );
  return rows;
}

async function create({ code, name, sort_order, is_active }, conn) {
  const [res] = await db(conn).query(
    'INSERT INTO categories (code, name, sort_order, is_active) VALUES (?, ?, ?, ?)',
    [code, name, sort_order || 0, is_active ?? 1]
  );
  return res.insertId;
}

async function update(id, { name, sort_order, is_active }, conn) {
  await db(conn).query(
    `UPDATE categories SET name = COALESCE(?, name), sort_order = COALESCE(?, sort_order),
            is_active = COALESCE(?, is_active) WHERE id = ?`,
    [name ?? null, sort_order ?? null, is_active ?? null, id]
  );
}

module.exports = { list, create, update };
