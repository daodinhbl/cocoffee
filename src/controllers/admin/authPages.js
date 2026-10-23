const bcrypt = require('bcryptjs');
const userModel = require('../../models/userModel');
const { AppError } = require('../../utils/httpError');
const env = require('../../config/env');
const appRelease = require('../../services/appRelease');
const iosApp = require('../../services/iosApp');
const iosRelease = require('../../services/iosRelease');
const apkpure = require('../../services/apkpure');
const googlePlay = require('../../services/googlePlay');
const windowsRelease = require('../../services/windowsRelease');
const { startSession, endSession, safeBack } = require('../../middlewares/adminAuth');

// Constant-time-ish: always run bcrypt, even for unknown users.
// Same cost as real hashes (12), or unknown usernames answer measurably faster.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
const MIN_PASSWORD = 10;

/** The public demo account (DEMO_MODE): shown on the login page, never forced/allowed to change. */
const isDemoAccount = (user) => Boolean(env.demo.enabled && user && user.username === env.demo.username);
const demoCredentials = () => (env.demo.enabled ? { username: env.demo.username, password: env.demo.password } : null);

const renderLogin = async (res, { status = 200, error = null, username = '', next = '' } = {}) =>
  res.status(status).render('login', {
    shopName: env.business.shopName, error, username, next: safeBack(next, ''), demo: demoCredentials(),
    appDownload: appRelease.loginCard(), iosApp: await iosApp.get(), iosMeta: iosApp.APP, iosRelease: iosRelease.loginCard(), googlePlay: googlePlay.card(), apkpure: apkpure.card(), windowsApp: windowsRelease.loginCard(),
  });

function loginForm(req, res) {
  if (req.user) return res.redirect(303, safeBack(req.query.next));
  return renderLogin(res, { next: req.query.next });
}

async function login(req, res) {
  const username = typeof req.body.username === 'string' ? req.body.username.trim().slice(0, 50) : '';
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 200) : '';
  const next = req.body.next;
  const user = username ? await userModel.findByUsername(username) : null;
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !user.is_active || !ok || !password) {
    return renderLogin(res, { status: 401, error: 'Sai tên đăng nhập hoặc mật khẩu.', username, next });
  }
  if (user.role === 'cashier') {                         // cashiers only get the POS screen
    startSession(res, user, { mustChangePassword: false });
    return res.redirect(303, '/admin/pos');
  }
  if (user.role !== 'admin') {
    return renderLogin(res, { status: 403, error: 'Tài khoản này không có quyền vào hệ thống.', username, next });
  }
  const weak = password.length < MIN_PASSWORD && !isDemoAccount(user);   // covers the factory admin/admin
  startSession(res, user, { mustChangePassword: weak });
  if (weak) res.flash('info', 'Mật khẩu hiện tại quá yếu. Hãy đặt mật khẩu mới (tối thiểu 10 ký tự) để tiếp tục.');
  return res.redirect(303, weak ? '/admin/settings/password' : safeBack(next));
}

function logout(_req, res) {
  endSession(res);
  res.redirect(303, '/admin/login');
}

/** Shared by "change my password" and "reset a staff password". */
function checkNewPassword(password, confirm) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new AppError(400, 'WEAK_PASSWORD', `Mật khẩu mới phải có ít nhất ${MIN_PASSWORD} ký tự.`);
  if (password.length > 200) throw new AppError(400, 'WEAK_PASSWORD', 'Mật khẩu quá dài.');
  if (confirm !== undefined && password !== confirm) throw new AppError(400, 'VALIDATION', 'Mật khẩu nhập lại không khớp.');
}

async function changeOwnPassword(req, res) {
  const { current_password: current, new_password: next, confirm_password: confirm } = req.body;
  const user = await userModel.findByUsername(req.user.username);
  if (isDemoAccount(user)) throw new AppError(403, 'DEMO_ACCOUNT', 'Tài khoản demo không đổi được mật khẩu.');
  if (typeof current !== 'string' || !(await bcrypt.compare(current, user.password_hash))) throw new AppError(400, 'BAD_CREDENTIALS', 'Mật khẩu hiện tại không đúng.');
  checkNewPassword(next, confirm);
  if (next === current) throw new AppError(400, 'VALIDATION', 'Mật khẩu mới phải khác mật khẩu cũ.');
  const hash = await bcrypt.hash(next, 12);
  await userModel.setPassword(user.id, hash);
  startSession(res, { ...user, password_hash: hash }, { mustChangePassword: false });   // older sessions now invalid
  return { message: 'Đã đổi mật khẩu.', to: '/admin/settings' };
}

const renderForgot = (res, { status = 200, error = null, field = null, values = {}, done = null } = {}) => {
  res.set('Cache-Control', 'no-store');
  return res.status(status).render('forgot', { shopName: env.business.shopName, error, field, values, done });
};

function forgotForm(_req, res) {
  return renderForgot(res);
}

/** Public: user name + recovery code + new password. Never says whether the user name exists. */
async function forgot(req, res) {
  const b = req.body || {};
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const values = { username: str(b.username, 50).trim() };
  if (b.website) return renderForgot(res, { status: 400, error: 'Yêu cầu không hợp lệ.', values });       // honeypot
  try {
    const done = await require('../../services/passwordRecovery').reset({
      username: values.username, code: str(b.code, 40), newPassword: str(b.password, 201), confirm: str(b.password2, 201), ip: req.ip,
    });
    return renderForgot(res, { done });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const field = { WEAK_PASSWORD: 'password', VALIDATION: 'password2', BAD_RECOVERY: 'code' }[err.code] || null;
    return renderForgot(res, { status: err.status || 400, error: err.message, field, values });
  }
}

/** Signed-in admin makes a new recovery code (needs the current password); the code is shown once. */
async function newRecoveryCode(req, res) {
  const user = await userModel.findByUsername(req.user.username);
  const typed = req.body.admin_password;
  if (isDemoAccount(user)) throw new AppError(403, 'DEMO_ACCOUNT', 'Tài khoản demo không tạo được mã khôi phục.');
  if (typeof typed !== 'string' || !typed || !(await bcrypt.compare(typed, user.password_hash))) throw new AppError(400, 'BAD_CREDENTIALS', 'Mật khẩu không đúng.');
  const code = await require('../../services/passwordRecovery').issueFor(user.id, { actorId: user.id });
  res.set('Cache-Control', 'no-store');
  return res.page('recovery_code', { code });
}

module.exports = { forgotForm, forgot, newRecoveryCode, loginForm, login, logout, changeOwnPassword, checkNewPassword, isDemoAccount, MIN_PASSWORD, DUMMY_HASH };
