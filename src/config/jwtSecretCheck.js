/**
 * Startup guard for JWT_SECRET (src/config/env.js calls it when REQUIRE_JWT_SECRET is on).
 * Returns the reasons the secret is unacceptable (empty list = fine).
 */
const MIN_LENGTH = 32;
const WEAK = new Set(['default_secret_key', '123456', 'secret', 'jwt_secret', 'changeme', 'change_me', 'password', 'jwtsecret', 'your_jwt_secret']);

function jwtSecretProblems(secret) {
  const s = typeof secret === 'string' ? secret.trim() : '';
  if (!s) return ['JWT_SECRET is empty or not set'];
  const out = [];
  if (s.length < MIN_LENGTH) out.push(`JWT_SECRET is ${s.length} characters long; at least ${MIN_LENGTH} are required`);
  if (WEAK.has(s.toLowerCase())) out.push('JWT_SECRET is a well-known weak value');
  if (/^(.)\1+$/.test(s)) out.push('JWT_SECRET repeats a single character');
  return out;
}

module.exports = { jwtSecretProblems, MIN_LENGTH };
