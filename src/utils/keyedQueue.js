/**
 * Runs async jobs sharing the same key strictly one after another (per-process).
 * Webhooks are ACKed immediately, so "2 ca phe sua" and "ok" sent a second apart would
 * otherwise race. DB row locks (zalo_sessions FOR UPDATE) cover the cross-process case.
 */
const tails = new Map();

function run(key, job) {
  const prev = tails.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  const tail = next.catch(() => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return next;
}

module.exports = { run };
