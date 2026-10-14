const crypto = require('crypto');
const { AppError } = require('../utils/httpError');

/**
 * Idempotency-Key for the money/stock writes of the app (POST /api/orders, POST /api/pos/checkout).
 * A tablet on flaky Wi-Fi retries with the same key; the first successful answer is replayed instead of creating a
 * second order or charging twice.
 *  - Scope: user + method + path + key. The same key with a different body is refused (422 IDEMPOTENCY_MISMATCH).
 *  - Only 2xx answers are remembered: a failed attempt rolled back completely, so a retry runs again.
 *  - A retry that arrives while the first attempt is still running waits for it (up to WAIT_MS, then 409). The first
 *    attempt keeps running when its client disconnects, and its answer is still remembered for the retry.
 *  - Kept in memory for 24 h (per Node process, at most MAX_KEYS keys). Without the header nothing changes.
 */
const TTL_MS = 24 * 3600 * 1000;
const MAX_KEYS = 5000;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
const WAIT_MS = 30 * 1000;
const STALE_PENDING_MS = 5 * 60 * 1000;     // a handler that never answered: forget its claim

function idempotency() {
  const store = new Map();     // scope -> { state: 'pending'|'done', hash, at, done?, status?, body? }

  const sweep = () => {
    const now = Date.now();
    for (const [k, e] of store) {
      const expired = e.state === 'done' ? e.at + TTL_MS <= now : e.at + STALE_PENDING_MS <= now;
      if (expired || (store.size > MAX_KEYS && e.state === 'done')) store.delete(k);
    }
  };

  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (key === undefined) return next();
    if (!KEY_RE.test(key)) throw new AppError(400, 'VALIDATION', 'Idempotency-Key must be 8-100 characters: letters, digits, . _ : -');
    const scope = `${req.user ? req.user.id : 'anon'}:${req.method}:${req.baseUrl}${req.path}:${key}`;
    const hash = crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
    sweep();

    let entry = store.get(scope);
    while (entry && entry.state === 'pending') {
      if (entry.hash !== hash) throw new AppError(422, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request body');
      const waited = await Promise.race([entry.done.then(() => true), new Promise((r) => { setTimeout(r, WAIT_MS, false).unref(); })]);
      if (!waited) throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The first request with this Idempotency-Key is still running; retry shortly');
      entry = store.get(scope);
    }
    if (entry && entry.state === 'done') {
      if (entry.hash !== hash) throw new AppError(422, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request body');
      res.set('Idempotent-Replayed', 'true');
      return res.status(entry.status).json(entry.body);
    }

    let finish;
    const pending = { state: 'pending', hash, at: Date.now(), done: new Promise((resolve) => { finish = resolve; }) };
    store.set(scope, pending);
    const settle = (result) => {
      if (store.get(scope) !== pending) return;
      if (result) store.set(scope, { state: 'done', hash, at: Date.now(), ...result });
      else store.delete(scope);
      finish();
    };
    const json = res.json.bind(res);
    res.json = (body) => {
      settle(res.statusCode >= 200 && res.statusCode < 300 ? { status: res.statusCode, body } : null);
      return json(body);
    };
    return next();
  };
}

module.exports = idempotency;
