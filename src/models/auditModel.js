const { pool } = require('../config/db');

/**
 * Who did what to which record (table audit_log). Written inside the caller's transaction when there is one, so the
 * trail and the change commit or roll back together.
 */
const db = (conn) => conn || pool;

/** @param {{ userId?: number|null, action: string, entity: string, details?: object }} entry */
async function write(conn, { userId, action, entity, details }) {
  await db(conn).query(
    'INSERT INTO audit_log (user_id, action, entity, details) VALUES (?, ?, ?, ?)',
    [userId ?? null, String(action).slice(0, 40), String(entity).slice(0, 60), details === undefined ? null : JSON.stringify(details)]
  );
}

/** Newest first. */
async function list({ entity, action, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (entity) { where.push('entity = ?'); params.push(entity); }
  if (action) { where.push('action = ?'); params.push(action); }
  const [rows] = await pool.query(
    `SELECT id, user_id, action, entity, details, created_at FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 100, 500)]
  );
  return rows;
}

module.exports = { write, list };
