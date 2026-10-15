const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');
const { checkNewPassword } = require('../controllers/admin/authPages');

/** Staff accounts (Web Admin > Cài đặt and /api/admin/users): create, reset a password, lock / unlock. */

/** @returns {Promise<{ id:number, username:string, full_name:string, role:string }>} */
async function create({ username: rawUsername, password, full_name: rawFullName, role: rawRole } = {}) {
  const username = v.str(rawUsername, 'Tên đăng nhập', { max: 50 }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(username)) throw new AppError(400, 'VALIDATION', 'Tên đăng nhập 3–50 ký tự: chữ thường, số, dấu . _ -');
  checkNewPassword(password);
  const passwordHash = await bcrypt.hash(password, 12);
  const fullName = v.str(rawFullName, 'Họ tên', { max: 100 });
  const role = v.oneOf(rawRole, 'Vai trò', ['admin', 'cashier']);
  const id = await userModel.create({ username, passwordHash, fullName, role });
  return { id, username, full_name: fullName, role };
}

/** Set a new password for another account (every session and token of that account dies). */
async function resetPassword(id, password) {
  const target = await userModel.findById(id);
  if (!target) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy tài khoản.');
  checkNewPassword(password);
  await userModel.setPassword(id, await bcrypt.hash(password, 12));
  return target;
}

/** Lock or unlock an account. Never yourself, and one active admin must remain. */
async function setActive(id, active, actorId) {
  const target = await userModel.findById(id);
  if (!target) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy tài khoản.');
  if (!active) {
    if (target.id === actorId) throw new AppError(409, 'CONFLICT', 'Không thể tự vô hiệu hóa tài khoản đang đăng nhập.');
    if (target.role === 'admin' && target.is_active && (await userModel.countActiveAdmins()) <= 1) {
      throw new AppError(409, 'CONFLICT', 'Phải còn ít nhất một quản trị viên hoạt động.');
    }
  }
  await userModel.setActive(id, Boolean(active));
  return target;
}

module.exports = { create, resetPassword, setActive };
