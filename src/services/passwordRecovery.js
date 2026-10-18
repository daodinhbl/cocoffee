const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');
const settingsModel = require('../models/settingsModel');
const auditModel = require('../models/auditModel');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');

/**
 * "Quên mật khẩu" without e-mail: every admin has a RECOVERY CODE (XXXX-XXXX-XXXX-XXXX) shown once, at setup and whenever they make
 * a new one in Cài đặt. Only its bcrypt hash is kept (app_settings "auth.recovery.<userId>"). On /admin/forgot the admin types the
 * user name, the code and a new password; the code is then replaced by a fresh one (shown once), so a used or leaked code is dead.
 * Wrong guesses are counted per user name and per address (a few tries, then a lock-out), and the answer never says whether the user
 * name exists. A PC administrator can also reset from the machine itself (scripts/reset-admin-password.js, the Windows manager).
 */
const PREFIX = 'auth.recovery.';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';       // no look-alikes (0/O, 1/I)
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const keyOf = (userId) => `${PREFIX}${userId}`;
const DUMMY = bcrypt.hashSync('XXXX-XXXX-XXXX-XXXX', 10);

/** "abcd efgh-ijkl..." -> "ABCDEFGHIJKL" (separators and case never matter). */
const normalize = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function generateCode() {
  const bytes = crypto.randomBytes(16);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

/** Makes a new code for the user, stores its hash, returns the code (the only time it exists in clear). */
async function issueFor(userId, { actorId = null, conn } = {}) {
  const code = generateCode();
  await settingsModel.setMany({ [keyOf(userId)]: await bcrypt.hash(normalize(code), 10) }, actorId, conn);
  return code;
}

async function hasCode(userId) {
  const s = await settingsModel.getByPrefix(keyOf(userId));
  return Boolean(s[keyOf(userId)]);
}

// ------------------------------------------------------------------ guessing limits (per process)
const fails = new Map();            // key -> { n, until }
const failKey = (username, ip) => [`u:${String(username).toLowerCase()}`, `ip:${ip || ''}`];

function locked(username, ip) {
  const now = Date.now();
  return failKey(username, ip).some((k) => { const f = fails.get(k); return f && f.n >= MAX_FAILS && f.until > now; });
}

function noteFail(username, ip) {
  const now = Date.now();
  for (const k of failKey(username, ip)) {
    const f = fails.get(k);
    const cur = f && f.until > now ? f : { n: 0, until: now + LOCK_MS };
    cur.n += 1;
    fails.set(k, cur);
  }
}

function clearFails(username) { fails.delete(`u:${String(username).toLowerCase()}`); }
const resetLimits = () => fails.clear();

/**
 * @param {{ username: string, code: string, newPassword: string, confirm?: string, ip?: string }} input
 * @returns {Promise<{ username: string, newCode: string }>}
 */
async function reset({ username, code, newPassword, confirm, ip }) {
  const { checkNewPassword, isDemoAccount } = require('../controllers/admin/authPages');
  const name = String(username || '').trim().slice(0, 50);
  if (locked(name, ip)) throw new AppError(429, 'RATE_LIMITED', 'Nhập sai nhiều lần. Vui lòng thử lại sau 15 phút.');
  const user = name ? await userModel.findByUsername(name) : null;
  const stored = user && user.role === 'admin' && user.is_active ? (await settingsModel.getByPrefix(keyOf(user.id)))[keyOf(user.id)] : null;
  const ok = await bcrypt.compare(normalize(code), stored || DUMMY);
  const bad = new AppError(400, 'BAD_RECOVERY', 'Tên đăng nhập hoặc mã khôi phục không đúng.');
  if (!user || !stored || !ok || normalize(code).length < 16) { noteFail(name, ip); throw bad; }
  if (isDemoAccount(user)) throw new AppError(403, 'DEMO_ACCOUNT', 'Tài khoản demo không đổi được mật khẩu.');
  checkNewPassword(newPassword, confirm);                // a weak new password is refused BEFORE the code is spent
  const hash = await bcrypt.hash(newPassword, 12);
  await userModel.setPassword(user.id, hash);            // every session and token of this account dies with the old hash
  const newCode = await issueFor(user.id);
  clearFails(name);
  try {
    await auditModel.write(null, { userId: user.id, action: 'password.recovered', entity: `user:${user.id}`, details: { ip: ip || null } });
  } catch (err) {
    logger.error('Audit log write failed (password recovery)', err);
  }
  return { username: user.username, newCode };
}

module.exports = { generateCode, normalize, issueFor, hasCode, reset, resetLimits, MAX_FAILS };
