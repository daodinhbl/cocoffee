const bcrypt = require('bcryptjs');
const env = require('../../config/env');
const userModel = require('../../models/userModel');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render, formBool } = require('./common');
const { checkNewPassword, isDemoAccount } = require('./authPages');
const printerSettings = require('../../services/printerSettings');

async function page(req, res) {
  const forced = Boolean(req.session.mustChangePassword);
  await render(res, 'settings', {
    title: 'Cài đặt', activeMenu: 'settings',
    breadcrumbs: [{ label: 'Hệ thống', href: '#' }, { label: 'Cài đặt' }],
  }, {
    forced,
    users: forced ? [] : await userModel.list(),
    printer: forced ? null : await printerSettings.get(),
    config: {
      publicBaseUrl: env.publicBaseUrl || '(chưa đặt)',
      allowNegativeStock: env.business.allowNegativeStock,
      draftTtlMinutes: env.zalo.draftTtlMinutes,
      verifySignature: env.zalo.verifySignature,
      receiptImage: env.receiptImage.enabled,
      timezone: env.db.timezone,
      sessionHours: env.jwt.expiresIn,
    },
  });
}

async function createUser(req) {
  const b = req.body;
  const username = v.str(b.username, 'Tên đăng nhập', { max: 50 }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(username)) throw new AppError(400, 'VALIDATION', 'Tên đăng nhập 3–50 ký tự: chữ thường, số, dấu . _ -');
  checkNewPassword(b.password);
  await userModel.create({
    username,
    passwordHash: await bcrypt.hash(b.password, 12),
    fullName: v.str(b.full_name, 'Họ tên', { max: 100 }),
    role: v.oneOf(b.role, 'Vai trò', ['admin', 'cashier']),
  });
  return { message: `Đã tạo tài khoản ${username}.` };
}

async function resetPassword(req) {
  const id = v.id(req.params.id);
  const target = await userModel.findById(id);
  if (!target) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy tài khoản.');
  if (isDemoAccount(target)) throw new AppError(403, 'DEMO_ACCOUNT', 'Tài khoản demo không đổi được mật khẩu.');
  checkNewPassword(req.body.password);
  await userModel.setPassword(id, await bcrypt.hash(req.body.password, 12));
  return { message: `Đã đặt lại mật khẩu cho ${target.username}.` };
}

async function setActive(req) {
  const id = v.id(req.params.id);
  const active = formBool(req.body.active);
  const target = await userModel.findById(id);
  if (!target) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy tài khoản.');
  if (!active) {
    if (isDemoAccount(target)) throw new AppError(403, 'DEMO_ACCOUNT', 'Không thể vô hiệu hóa tài khoản demo.');
    if (target.id === req.user.id) throw new AppError(409, 'CONFLICT', 'Không thể tự vô hiệu hóa tài khoản đang đăng nhập.');
    if (target.role === 'admin' && target.is_active && (await userModel.countActiveAdmins()) <= 1) {
      throw new AppError(409, 'CONFLICT', 'Phải còn ít nhất một quản trị viên hoạt động.');
    }
  }
  await userModel.setActive(id, Boolean(active));
  return { message: active ? `Đã kích hoạt ${target.username}.` : `Đã vô hiệu hóa ${target.username}.` };
}

/** Receipt printer: paper, auto print, copies, header/footer lines, VAT line. */
async function savePrinter(req) {
  await printerSettings.save(req.body, req.user.id);
  return { message: 'Đã lưu cấu hình máy in.', to: '/admin/settings' };
}

module.exports = { page, createUser, resetPassword, setActive, savePrinter };
