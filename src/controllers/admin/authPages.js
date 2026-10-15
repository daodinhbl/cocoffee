const bcrypt = require('bcryptjs');
const userModel = require('../../models/userModel');
const { AppError } = require('../../utils/httpError');
const env = require('../../config/env');
const appRelease = require('../../services/appRelease');
const iosApp = require('../../services/iosApp');
const iosRelease = require('../../services/iosRelease');
const { startSession, endSession, safeBack } = require('../../middlewares/adminAuth');

// Constant-time-ish: always run bcrypt, even for unknown users.
// Same cost as real hashes (12), or unknown usernames answer measurably faster.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
const MIN_PASSWORD = 10;

const renderLogin = async (res, { status = 200, error = null, username = '', next = '' } = {}) =>
  res.status(status).render('login', {
    shopName: env.business.shopName, error, username, next: safeBack(next, ''),
    appDownload: appRelease.loginCard(), iosApp: await iosApp.get(), iosMeta: iosApp.APP, iosRelease: iosRelease.loginCard(),
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
  const weak = password.length < MIN_PASSWORD;   // covers the factory admin/admin
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
  if (typeof current !== 'string' || !(await bcrypt.compare(current, user.password_hash))) throw new AppError(400, 'BAD_CREDENTIALS', 'Mật khẩu hiện tại không đúng.');
  checkNewPassword(next, confirm);
  if (next === current) throw new AppError(400, 'VALIDATION', 'Mật khẩu mới phải khác mật khẩu cũ.');
  const hash = await bcrypt.hash(next, 12);
  await userModel.setPassword(user.id, hash);
  startSession(res, { ...user, password_hash: hash }, { mustChangePassword: false });   // older sessions now invalid
  return { message: 'Đã đổi mật khẩu.', to: '/admin/settings' };
}

module.exports = { loginForm, login, logout, changeOwnPassword, checkNewPassword, MIN_PASSWORD, DUMMY_HASH };
