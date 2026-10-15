const crypto = require('crypto');
const { AppError } = require('../utils/httpError');
const idempotencyModel = require('../models/idempotencyModel');
const logger = require('../utils/logger');

/**
 * Idempotency-Key for the money/stock writes of the app (POST /api/orders, /api/pos/checkout, collections, stock
 * receipts, ...). A phone on flaky Wi-Fi, or its offline queue, retries with the same key; the first successful
 * answer is replayed instead of creating a second order or charging twice.
 *  - Scope: user + method + path + key. The same key with a different body is refused (422 IDEMPOTENCY_MISMATCH).
 *  - Remembered in the database (table idempotency_keys, 24 h), so a replay still finds the first answer after a
 *    redeploy, a restart, or on another worker — the app queues a write exactly when the server did not answer.
 *  - Only 2xx answers are remembered: a failed attempt rolled back completely, so a retry runs again.
 *  - A retry that arrives while the first attempt is still running waits for it (up to WAIT_MS, then 409). The
 *    first attempt keeps running when its client disconnects, and its answer is still remembered for the retry; a
 *    claim left by a process that died mid-request expires after STALE_PENDING_MS.
 *  - Without the header nothing changes. If the table cannot be used the write still runs (logged, not replayed).
 */
const TTL_MS = 24 * 3600 * 1000;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
const WAIT_MS = 30 * 1000;
const POLL_MS = 500;
const STALE_PENDING_MS = 5 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;

let lastSweep = 0;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

function idempotency() {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (key === undefined) return next();
    if (!KEY_RE.test(key)) throw new AppError(400, 'VALIDATION', 'Idempotency-Key must be 8-100 characters: letters, digits, . _ : -');
    const scope = `${req.user ? req.user.id : 'anon'}:${req.method}:${req.baseUrl}${req.path}:${key}`;
    const hash = crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

    try {
      if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
        lastSweep = Date.now();
        idempotencyModel.sweep(TTL_MS, STALE_PENDING_MS).catch((err) => logger.warn('Idempotency sweep failed', err));
      }
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const row = await idempotencyModel.find(scope);
        if (row) {
          if (row.request_hash !== hash) throw new AppError(422, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request body');
          if (row.status !== null && row.status !== undefined) {
            res.set('Idempotent-Replayed', 'true');
            return res.status(Number(row.status)).json(typeof row.body === 'string' ? JSON.parse(row.body) : row.body);
          }
          if (Date.now() + POLL_MS > deadline) throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The first request with this Idempotency-Key is still running; retry shortly');
          await wait(POLL_MS);
          continue;
        }
        if (await idempotencyModel.claim(scope, hash)) break;         // ours to run; a loser of the race loops and waits
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error('Idempotency store unavailable: the request runs without replay protection', err);
      return next();
    }

    // Remember the answer (2xx) or free the key (anything else) when the handler answers.
    let settled = false;
    const json = res.json.bind(res);
    res.json = (body) => {
      if (!settled) {
        settled = true;
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        (ok ? idempotencyModel.complete(scope, res.statusCode, body) : idempotencyModel.release(scope))
          .catch((err) => logger.warn('Idempotency store write failed', err));
      }
      return json(body);
    };
    return next();
  };
}

module.exports = idempotency;
