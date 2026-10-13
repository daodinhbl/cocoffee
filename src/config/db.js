const mysql = require('mysql2/promise');
const env = require('./env');

// Shared-hosting friendly: small pool, keep-alive, utf8mb4, DECIMAL -> JS number.
const pool = mysql.createPool({
  host: env.db.host, // 127.0.0.1 (NOT "localhost": it can resolve to ::1 and miss the user grant)
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.name,
  waitForConnections: true,
  connectionLimit: env.db.poolLimit,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: env.db.timezone,
  decimalNumbers: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// Make NOW()/CURRENT_TIMESTAMP agree with the shop's local time on every pooled connection.
pool.on('connection', (conn) => {
  conn.query(`SET time_zone = '${env.db.timezone}'`);
});

const DEADLOCK = 1213;
const LOCK_TIMEOUT = 1205;

/**
 * Run `fn(conn)` inside a transaction. Commits on success, rolls back on ANY error and rethrows.
 * Retries (max 3 attempts) when InnoDB reports a deadlock / lock-wait timeout.
 */
async function withTransaction(fn) {
  for (let attempt = 1; ; attempt += 1) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try { await conn.rollback(); } catch (_) { /* connection already gone */ }
      if ((err.errno === DEADLOCK || err.errno === LOCK_TIMEOUT) && attempt < 3) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}

module.exports = { pool, withTransaction };
