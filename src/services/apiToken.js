const jwt = require('jsonwebtoken');
const env = require('../config/env');
const tenantContext = require('../config/tenantContext');
const { pwStamp } = require('../utils/passwordStamp');

/**
 * Bearer tokens of the JSON API (POS tablets, the Android app).
 *  - audience 'pos-api' + issuer 'cocoffee': the Web Admin cookie JWT (audience 'admin-web', same key) can never be
 *    replayed as a bearer token, and an API token never opens an admin cookie session.
 *  - pws: password stamp, compared with the user's current one on every request (revocation on password change).
 *  - mcp: 1 while the admin still uses a weak/factory password; only /auth/me and /auth/change-password work then.
 */
const AUDIENCE = 'pos-api';
const ISSUER = 'cocoffee';

/** user must carry password_hash (the findByUsername row, with the new hash after a password change). */
function issue(user, { mustChangePassword = false } = {}) {
  return jwt.sign(
    { sub: user.id, tid: tenantContext.key(), role: user.role, pws: pwStamp(user.password_hash), mcp: mustChangePassword ? 1 : 0 },
    env.jwt.secret,
    { algorithm: 'HS256', audience: AUDIENCE, issuer: ISSUER, expiresIn: env.jwt.expiresIn }
  );
}

/** Throws (jsonwebtoken error) on a bad signature, wrong audience/issuer or an expired token. */
const verify = (token) => jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'], audience: AUDIENCE, issuer: ISSUER });

module.exports = { issue, verify, AUDIENCE, ISSUER };
