const { AppError } = require('../utils/httpError');

/** Tiny in-memory fixed-window limiter (per process) - enough to blunt login brute force. */
function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs).unref();
  return (req, _res, next) => {
    const k = key(req);
    const now = Date.now();
    const entry = hits.get(k) && hits.get(k).reset > now ? hits.get(k) : { count: 0, reset: now + windowMs };
    entry.count += 1;
    hits.set(k, entry);
    if (entry.count > max) throw new AppError(429, 'RATE_LIMITED', 'Too many attempts, try again later');
    next();
  };
}

module.exports = rateLimit;
