const { pool } = require('../config/db');

/** Technical-service leads captured by the public QR page (/ky-thuat). Table: service_leads. */
const db = (conn) => conn || pool;

async function create({ name, phone, need, source, note }, conn) {
  const [r] = await db(conn).query(
    'INSERT INTO service_leads (name, phone, need, source, note) VALUES (?, ?, ?, ?, ?)',
    [name, phone, need, source, note || null]
  );
  return r.insertId;
}

/** Same phone asked again within `hours`: used to avoid notifying the owner twice for a double tap. */
async function recentByPhone(phone, hours = 12, conn) {
  const [rows] = await db(conn).query(
    'SELECT id FROM service_leads WHERE phone = ? AND created_at > (NOW() - INTERVAL ? HOUR) LIMIT 1',
    [phone, hours]
  );
  return rows[0] || null;
}

async function list({ limit = 100 } = {}, conn) {
  const [rows] = await db(conn).query('SELECT * FROM service_leads ORDER BY id DESC LIMIT ?', [limit]);
  return rows;
}

module.exports = { create, recentByPhone, list };
