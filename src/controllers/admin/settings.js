const env = require('../../config/env');
const userModel = require('../../models/userModel');
const v = require('../../utils/validate');
const { render, formBool } = require('./common');
const printerSettings = require('../../services/printerSettings');
const iosApp = require('../../services/iosApp');
const shopProfile = require('../../services/shopProfile');
const userService = require('../../services/userService');
const { systemConfig } = require('../../services/settingsService');
const payon = require('./payon');

async function page(req, res) {
  const forced = Boolean(req.session.mustChangePassword);
  await render(res, 'settings', {
    title: 'Cài đặt', activeMenu: 'settings',
    breadcrumbs: [{ label: 'Hệ thống', href: '#' }, { label: 'Cài đặt' }],
  }, {
    forced,
    users: forced ? [] : await userModel.list(),
    printer: forced ? null : await printerSettings.get(),
    payonPanel: forced ? null : await payon.settingsPanel(),
    iosApp: forced ? null : await iosApp.view(),
    shop: forced ? null : await shopProfile.get(),
    shopFields: shopProfile.FIELDS, declarationPeriods: shopProfile.PERIODS,
    config: { ...systemConfig(), publicBaseUrl: env.publicBaseUrl || '(chưa đặt)' },
    heli: forced ? null : require('../../services/heli/heliConfig').view(),
    dbConn: forced ? null : require('../../services/dbConfig').view(),
    machineId: forced ? null : await require('../../services/machineId').read(),
  });
}

/** The signed-in admin must type their own password again before the database connection is tested, saved or reset. */
async function confirmAdmin(req, typed) {
  const bcrypt = require('bcryptjs');
  const { AppError } = require('../../utils/httpError');
  const user = await userModel.findByUsername(req.user.username);
  if (typeof typed !== 'string' || !typed || !user || !(await bcrypt.compare(typed, user.password_hash))) {
    throw new AppError(403, 'BAD_CREDENTIALS', 'Mật khẩu quản trị chưa đúng. Nhập lại mật khẩu của bạn để đổi kết nối CSDL.');
  }
}

const dbFields = (b) => ({ host: b.host, port: b.port, name: b.name, user: b.user, password: b.password });

async function testDb(req) {
  await confirmAdmin(req, req.body.admin_password);
  const r = await require('../../services/dbConfig').test(req.body.section, dbFields(req.body));
  return { message: `Kết nối được: MySQL/MariaDB ${r.version}, ${r.tables} bảng${r.empty ? ' (cơ sở dữ liệu trống)' : ''}.` };
}

async function saveDb(req) {
  await confirmAdmin(req, req.body.admin_password);
  const svc = require('../../services/dbConfig');
  await svc.save(req.body.section, dbFields(req.body));
  return { message: 'Đã lưu kết nối CSDL. Khởi động lại ứng dụng để áp dụng.' };
}

async function resetDb(req) {
  await confirmAdmin(req, req.body.admin_password);
  require('../../services/dbConfig').reset(req.body.section);
  return { message: 'Đã bỏ kết nối đã lưu: sau khi khởi động lại sẽ dùng lại biến môi trường.' };
}

async function restartApp(req) {
  await confirmAdmin(req, req.body.admin_password);
  require('../../services/dbConfig').restart();
  return { message: 'Ứng dụng đang khởi động lại, vài giây nữa hãy tải lại trang.' };
}

async function saveHeli(req) {
  const heli = require('../../services/heli/heliConfig');
  const b = req.body;
  await heli.save({ apiKey: b.api_key, model: b.model, clear: b.clear === '1' }, req.user.id);
  return { message: b.clear === '1' ? 'Đã xóa khóa API đã lưu (dùng lại biến OPENAI_API_KEY nếu có).' : 'Đã lưu cấu hình trợ lý Heli.' };
}

async function testHeli(req) {
  const r = await require('../../services/heli/heliConfig').test(req.body.api_key);
  return { message: `Khóa API hợp lệ (${r.hint}).` };
}

async function savePublicUrl(req) {
  const url = await require('../../services/publicUrl').save(req.body.public_url, req.user.id);
  return { message: url ? `Đã đặt tên miền công khai: ${url}` : 'Đã bỏ địa chỉ đã lưu, dùng lại PUBLIC_BASE_URL.' };
}

async function createUser(req) {
  const { username } = await userService.create(req.body);
  return { message: `Đã tạo tài khoản ${username}.` };
}

async function resetPassword(req) {
  const target = await userService.resetPassword(v.id(req.params.id), req.body.password);
  return { message: `Đã đặt lại mật khẩu cho ${target.username}.` };
}

async function setActive(req) {
  const active = formBool(req.body.active);
  const target = await userService.setActive(v.id(req.params.id), active, req.user.id);
  return { message: active ? `Đã kích hoạt ${target.username}.` : `Đã vô hiệu hóa ${target.username}.` };
}

/** Receipt printer: paper, auto print, copies, header/footer lines, VAT line. */
async function savePrinter(req) {
  await printerSettings.save(req.body, req.user.id);
  return { message: 'Đã lưu cấu hình máy in.', to: '/admin/settings' };
}

/** iOS app: the TestFlight public link or App Store page that /download/ios and the login page QR lead to. */
async function saveIosApp(req) {
  const link = await iosApp.save(req.body, req.user.id);
  return { message: link ? `Đã lưu liên kết tải ứng dụng iOS (${link.label}).` : 'Đã bỏ liên kết tải ứng dụng iOS.', to: '/admin/settings' };
}

/** Store / household-business profile: name, owner, tax code, address, phone... */
async function saveShop(req) {
  await shopProfile.save(req.body, req.user.id);
  return { message: 'Đã lưu thông tin cửa hàng.', to: '/admin/settings' };
}

module.exports = { confirmAdmin, testDb, saveDb, resetDb, restartApp, saveHeli, testHeli, savePublicUrl, page, createUser, resetPassword, setActive, savePrinter, saveIosApp, saveShop };
