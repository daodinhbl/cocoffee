const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const userModel = require('../models/userModel');

/**
 * Cookie session for the server-rendered Web Admin.
 *  - HttpOnly + SameSite=Strict cookie holding a signed JWT (audience "admin-web", so an API bearer token
 *    can never be replayed as an admin session). Only active users with role "admin" get in.
 *  - The JWT carries a per-session CSRF token; every POST must echo it in the `_csrf` form field.
 *  - `mcp` (must change password) is set when the account still uses the factory password: every page then
 *    redirects to the change-password form until it is replaced.
 *  - `pws` fingerprints the password hash: changing or resetting a password invalidates every older session.
 *  - One-shot flash message in a short-lived cookie (shown once, escaped by the template).
 */
const SESSION_COOKIE = 'cc_admin';
const FLASH_COOKIE = 'cc_flash';
const AUDIENCE = 'admin-web';
const COOKIE_BASE = { httpOnly: true, sameSite: 'strict', path: '/admin', secure: env.nodeEnv === 'production' };
// Also Secure whenever the request itself came over HTTPS (trust proxy is on), even if NODE_ENV was left unset.
const cookieOpts = (res) => ({ ...COOKIE_BASE, secure: COOKIE_BASE.secure || Boolean(res.req && res.req.secure) });
const pwStamp = (passwordHash) => crypto.createHash('sha256').update(String(passwordHash)).digest('hex').slice(0, 16);

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* skip malformed pair */ }
  }
  return out;
}

const sessionHours = () => {
  const m = /^(\d+)\s*([hdm]?)$/.exec(String(env.jwt.expiresIn));
  if (!m) return 12;
  return m[2] === 'd' ? Number(m[1]) * 24 : m[2] === 'm' ? Math.max(1, Math.round(Number(m[1]) / 60)) : Number(m[1]);
};

/** user must carry password_hash (the row from findByUsername, with the new hash after a password change). */
function startSession(res, user, { mustChangePassword = false } = {}) {
  const hours = sessionHours();
  const token = jwt.sign(
    { sub: user.id, role: user.role, csrf: crypto.randomBytes(18).toString('hex'), mcp: mustChangePassword ? 1 : 0, pws: pwStamp(user.password_hash) },
    env.jwt.secret,
    { algorithm: 'HS256', audience: AUDIENCE, expiresIn: `${hours}h` }
  );
  res.cookie(SESSION_COOKIE, token, { ...cookieOpts(res), maxAge: hours * 3600 * 1000 });
}

const endSession = (res) => res.clearCookie(SESSION_COOKIE, cookieOpts(res));

/** Attach `res.flash(type, text)` and expose the pending message (once) as `res.locals.flash`. */
function flash(req, res, next) {
  const raw = readCookies(req)[FLASH_COOKIE];
  res.locals.flash = null;
  if (raw) {
    try {
      const f = JSON.parse(raw);
      if (f && typeof f.m === 'string') res.locals.flash = { type: ['success', 'error', 'info'].includes(f.t) ? f.t : 'info', message: f.m.slice(0, 300) };
    } catch (_) { /* ignore a tampered cookie */ }
    res.clearCookie(FLASH_COOKIE, cookieOpts(res));
  }
  res.flash = (type, message) => res.cookie(FLASH_COOKIE, JSON.stringify({ t: type, m: String(message).slice(0, 300) }), { ...cookieOpts(res), maxAge: 60 * 1000 });
  next();
}

/** Only same-site /admin paths are valid redirect targets (blocks open redirects via ?next= / _back). */
function safeBack(target, fallback = '/admin/dashboard') {
  const s = typeof target === 'string' ? target : '';
  return /^\/admin(\/[A-Za-z0-9\-_/.]*)?(\?[A-Za-z0-9\-_=&%.+:~,]*)?$/.test(s) && !s.includes('//') && !s.includes('..') ? s : fallback;
}

/** Resolve the session cookie into req.user (+ res.locals.csrf). Does not reject by itself. */
async function loadSession(req, res, next) {
  req.user = null;
  const token = readCookies(req)[SESSION_COOKIE];
  if (token) {
    try {
      const p = jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'], audience: AUDIENCE });
      const user = await userModel.findById(p.sub);
      if (user && user.is_active && user.role === 'admin' && p.pws === user.pw_stamp) {
        req.user = user;
        req.session = { csrf: p.csrf, mustChangePassword: p.mcp === 1 };
      }
    } catch (_) { /* expired / forged: treated as logged out */ }
  }
  res.locals.csrf = req.session ? req.session.csrf : '';
  res.locals.currentUser = req.user;
  res.locals.backUrl = req.originalUrl;
  next();
}

/** Gate for everything except /login: redirect to the login form, or to the forced password change. */
function requireAdmin(req, res, next) {
  if (!req.user) {
    const target = req.method === 'GET' ? safeBack(req.originalUrl, '') : '';
    return res.redirect(303, target ? `/admin/login?next=${encodeURIComponent(target)}` : '/admin/login');
  }
  if (req.session.mustChangePassword && !/^\/settings\/password$|^\/logout$/.test(req.path)) {
    if (req.method === 'GET') return res.redirect(303, '/admin/settings/password');
    return res.status(403).type('text').send('Đổi mật khẩu mặc định trước khi tiếp tục.');
  }
  return next();
}

/** POST guard: constant-time comparison of the form token against the session token. */
function requireCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const sent = String(req.body?._csrf || '');
  const want = String(req.session?.csrf || '');
  const ok = want.length > 0 && sent.length === want.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
  if (!ok) {
    res.flash('error', 'Phiên làm việc đã hết hạn hoặc biểu mẫu không hợp lệ. Vui lòng thử lại.');
    return res.redirect(303, safeBack(req.body?._back, '/admin/dashboard'));
  }
  return next();
}

module.exports = { startSession, endSession, flash, loadSession, requireAdmin, requireCsrf, safeBack, readCookies };
