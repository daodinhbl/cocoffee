const crypto = require('crypto');

/**
 * Zalo OA webhook signature (developers.zalo.me > Webhook):
 *   X-ZEvent-Signature: mac = sha256(appId + data + timeStamp + OAsecretKey)
 * where `data` is the RAW JSON body string exactly as received (not re-serialized).
 * Plain SHA-256 of the concatenation, hex encoded (NOT an HMAC).
 */
function computeMac({ appId, rawBody, timestamp, oaSecretKey }) {
  return crypto.createHash('sha256').update(`${appId}${rawBody}${timestamp}${oaSecretKey}`, 'utf8').digest('hex');
}

function verifySignature({ appId, rawBody, timestamp, oaSecretKey, header }) {
  if (!header || !rawBody || timestamp === undefined) return false;
  const expected = computeMac({ appId, rawBody, timestamp, oaSecretKey });
  const given = String(header).trim().replace(/^mac=/i, '').toLowerCase(); // tolerate "mac=<hex>"
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { computeMac, verifySignature };
