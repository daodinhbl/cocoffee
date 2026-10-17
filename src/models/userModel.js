const { pool } = require('../config/db');

const db = (conn) => conn || pool;

/** Number of accounts; throws when the users table does not exist yet. */
async function count(conn) {
  const [[{ n }]] = await db(conn).query('SELECT COUNT(*) AS n FROM users');
  return Number(n);
}

async function findByUsername(username, conn) {
  const [rows] = await db(conn).query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
  return rows[0] || null;
}

async function findById(id, conn) {
  const [rows] = await db(conn).query(
    // pw_stamp: fingerprint of the password hash, so admin sessions die when the password changes (never the hash itself)
    'SELECT id, username, full_name, role, is_active, LEFT(SHA2(password_hash, 256), 16) AS pw_stamp FROM users WHERE id = ? LIMIT 1',
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

async function list(conn) {
  const [rows] = await db(conn).query(
    'SELECT id, username, full_name, role, is_active, created_at FROM users ORDER BY is_active DESC, role, username'
  );
  return rows;
}

async function setActive(id, active, conn) {
  await db(conn).query('UPDATE users SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
}

async function countActiveAdmins(conn) {
  const [rows] = await db(conn).query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1");
  return rows[0].n;
}

module.exports = { count, findByUsername, findById, create, setPassword, list, setActive, countActiveAdmins };
