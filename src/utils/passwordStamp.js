const crypto = require('crypto');

/**
 * Fingerprint of a password hash (never the hash itself). Tokens carry it as `pws`; userModel.findById returns the
 * same value as pw_stamp = LEFT(SHA2(password_hash, 256), 16), so changing or resetting a password invalidates every
 * token and cookie session issued before.
 */
const pwStamp = (passwordHash) => crypto.createHash('sha256').update(String(passwordHash)).digest('hex').slice(0, 16);

module.exports = { pwStamp };
