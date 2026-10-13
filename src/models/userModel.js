const { pool } = require('../config/db');

const db = (conn) => conn || pool;

async function findByUsername(username, conn) {
  const [rows] = await db(conn).query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
  return rows[0] || null;
}

async function findById(id, conn) {
  const [rows] = await db(conn).query(
    'SELECT id, username, full_name, role, is_active FROM users WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

async function create({ username, passwordHash, fullName, role }, conn) {
  const [res] = await db(conn).query(
    'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
    [username, passwordHash, fullName, role]
  );
  return res.insertId;
}

async function setPassword(id, passwordHash, conn) {
  await db(conn).query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
}

module.exports = { findByUsername, findById, create, setPassword };
