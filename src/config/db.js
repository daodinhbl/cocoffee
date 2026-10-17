const mysql = require('mysql2/promise');
const env = require('./env');
const tenantContext = require('./tenantContext');

const baseOptions = {
  waitForConnections: true,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: env.db.timezone,
  decimalNumbers: true,
  dateStrings: ['DATE'],                    // DATE columns (expense_date, tax periods, rollup days) stay 'YYYY-MM-DD', never a timezone-shifted Date
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
};

function makePool({ host, port, user, password, database }, connectionLimit) {
  const p = mysql.createPool({ ...baseOptions, host, port, user, password, database, connectionLimit });
  // Make NOW()/CURRENT_TIMESTAMP agree with the shop's local time on every pooled connection.
  p.on('connection', (conn) => { conn.query(`SET time_zone = '${env.db.timezone}'`); });
  return p;
}

// Shared-hosting friendly: small pool, keep-alive, utf8mb4, DECIMAL -> JS number.
// host: 127.0.0.1 (NOT "localhost": it can resolve to ::1 and miss the user grant)
const defaultPool = makePool({ host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, database: env.db.name }, env.db.poolLimit);

// One small pool per tenant database, created on first use (tenant = a shop with its own database, see services/tenantService.js).
const tenantPools = new Map();
const TENANT_POOL_LIMIT = 3;

function tenantPool(t) {
  let p = tenantPools.get(t.id);
  if (!p) {
    p = makePool(t.db, TENANT_POOL_LIMIT);
    tenantPools.set(t.id, p);
  }
  return p;
}

/** Drops a tenant's pool (its database credentials changed or the shop was suspended). */
async function closeTenantPool(id) {
  const p = tenantPools.get(id);
  tenantPools.delete(id);
  if (p) await p.end().catch(() => {});
}

/** The pool of the current request's shop. Tenants never reach the default pool unless the code asks for `defaultPool`. */
const currentPool = () => {
  const t = tenantContext.current();
  return t ? tenantPool(t) : defaultPool;
};

// Every model imports `pool`; this facade sends each call to the current shop's database.
const pool = {
  query: (...a) => currentPool().query(...a),
  execute: (...a) => currentPool().execute(...a),
  getConnection: () => currentPool().getConnection(),
  end: () => defaultPool.end(),
};

const DEADLOCK = 1213;
const LOCK_TIMEOUT = 1205;

/**
 * Run `fn(conn)` inside a transaction. Commits on success, rolls back on ANY error and rethrows.
 * Retries (max 3 attempts) when InnoDB reports a deadlock / lock-wait timeout.
 */
async function withTransaction(fn) {
  for (let attempt = 1; ; attempt += 1) {
    const conn = await pool.getConnection();   // the facade: the current shop's database
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

module.exports = { pool, defaultPool, withTransaction, makePool, closeTenantPool };
