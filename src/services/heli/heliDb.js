const { pool } = require('../../config/db');
const sqlGuard = require('./sqlGuard');

const MAX_ROWS = 50;

/**
 * Runs one guarded read for Heli and returns text for the model. Even if the guard missed something, the
 * statement runs inside START TRANSACTION READ ONLY and is always rolled back.
 */
async function readOnlyQuery(sql) {
  const verdict = sqlGuard.check(sql);
  if (!verdict.ok) return verdict.reason;
  if (verdict.virtual === 'tables') return sqlGuard.ALLOWED_TABLES.join('\n');
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const [rows] = await conn.query({ sql: verdict.sql, timeout: 15000 });
    if (!Array.isArray(rows) || rows.length === 0) return '(không có dòng nào)';
    const more = rows.length > MAX_ROWS ? `\n(còn ${rows.length - MAX_ROWS} dòng nữa, đã cắt)` : '';
    return rows.slice(0, MAX_ROWS).map((r) => JSON.stringify(r)).join('\n') + more;
  } catch (e) {
    return `Lỗi truy vấn (${e.code || 'SQL'}): hãy kiểm tra tên cột/bảng bằng DESCRIBE.`;
  } finally {
    try { await conn.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    conn.release();
  }
}

module.exports = { readOnlyQuery, MAX_ROWS };
