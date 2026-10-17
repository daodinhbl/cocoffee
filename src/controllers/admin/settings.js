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
  });
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

module.exports = { page, createUser, resetPassword, setActive, savePrinter, saveIosApp, saveShop };
