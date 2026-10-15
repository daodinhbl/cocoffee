const crypto = require('crypto');
const { pool } = require('../config/db');

/**
 * Remembered answers of the app's idempotent writes (table idempotency_keys, see middlewares/idempotency.js).
 * A row is claimed (status NULL) while the first request runs, completed with the 2xx answer, or released.
 * Keyed by the SHA-256 of the scope string (user + method + path + key), so any scope length fits the index.
 */
const db = (conn) => conn || pool;
const idOf = (scope) => crypto.createHash('sha256').update(scope).digest('hex');

/** @returns {Promise<{request_hash:string, status:number|null, body:string|null, created_at:Date}|null>} */
async function find(scope, conn) {
  const [rows] = await db(conn).query('SELECT request_hash, status, body, created_at FROM idempotency_keys WHERE id = ?', [idOf(scope)]);
  return rows[0] || null;
}

/** Claims the key for a request about to run. False when another request already holds it. */
async function claim(scope, requestHash, conn) {
  try {
    await db(conn).query('INSERT INTO idempotency_keys (id, scope, request_hash) VALUES (?, ?, ?)', [idOf(scope), scope.slice(0, 255), requestHash]);
    return true;
  } catch (err) {
    if (err.errno === 1062) return false;
    throw err;
  }
}

async function complete(scope, status, body, conn) {
  await db(conn).query('UPDATE idempotency_keys SET status = ?, body = ? WHERE id = ?', [status, JSON.stringify(body ?? null), idOf(scope)]);
}

async function release(scope, conn) {
  await db(conn).query('DELETE FROM idempotency_keys WHERE id = ?', [idOf(scope)]);
}

/** Drops answers older than ttlMs and claims never completed within staleMs (a process that died mid-request). */
async function sweep(ttlMs, staleMs, conn) {
  await db(conn).query(
    `DELETE FROM idempotency_keys
      WHERE (status IS NOT NULL AND created_at < NOW() - INTERVAL ? SECOND)
         OR (status IS NULL AND created_at < NOW() - INTERVAL ? SECOND)`,
    [Math.round(ttlMs / 1000), Math.round(staleMs / 1000)]
  );
}

module.exports = { find, claim, complete, release, sweep };
