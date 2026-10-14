const env = require('../../config/env');
const userModel = require('../../models/userModel');
const userService = require('../../services/userService');
const printerSettings = require('../../services/printerSettings');
const { systemConfig } = require('../../services/settingsService');
const v = require('../../utils/validate');

/** Settings screen of the app (admin): printer, read-only configuration, staff accounts. */

/** GET /api/admin/settings -> { printer, config, shop_name } (shop_name: SHOP_NAME, shown read-only like the web page) */
async function get(_req, res) {
  res.json({ printer: await printerSettings.get(), config: systemConfig(), shop_name: env.business.shopName });
}

const PRINTER_FIELDS = ['paperMm', 'autoPrint', 'copies', 'printerName', 'shopAddress', 'shopPhone', 'footer', 'showVat', 'vatRate'];

/** JSON boolean (or 0/1) -> the '1' / '0' that printerSettings.save() expects from the web form. */
function formFlag(value, name) {
  if (value === true || value === 1 || value === '1') return '1';
  if (value === false || value === 0 || value === '0') return '0';
  return v.fail(`${name} must be a boolean`);
}

/**
 * PUT /api/admin/settings/printer { paperMm: 58|80, autoPrint, copies: 1..3, printerName, shopAddress, shopPhone, footer,
 * showVat, vatRate: 0..20 }. Fields left out keep their current value. -> { printer }
 */
async function savePrinter(req, res) {
  const current = await printerSettings.get();
  const body = {};
  for (const k of PRINTER_FIELDS) body[k] = req.body[k] !== undefined ? req.body[k] : current[k];
  body.autoPrint = formFlag(body.autoPrint, 'autoPrint');
  body.showVat = formFlag(body.showVat, 'showVat');
  await printerSettings.save(body, req.user.id);
  res.json({ printer: await printerSettings.get() });
}

const publicUser = (u) => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, is_active: u.is_active, created_at: u.created_at ?? null });

/** GET /api/admin/users -> { users: [{ id, username, full_name, role, is_active, created_at }] } */
async function listUsers(_req, res) {
  res.json({ users: (await userModel.list()).map(publicUser) });
}

/** POST /api/admin/users { username, password (>= 10), full_name, role: admin|cashier } -> 201 { user } */
async function createUser(req, res) {
  const user = await userService.create(req.body);
  res.status(201).json({ user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, is_active: 1 } });
}

/** PUT /api/admin/users/:id/password { password } -> { ok } (every token and session of that account stops working) */
async function resetPassword(req, res) {
  await userService.resetPassword(v.id(req.params.id), req.body.password);
  res.json({ ok: true });
}

/** PUT /api/admin/users/:id/active { active: boolean } -> { ok } */
async function setActive(req, res) {
  const raw = req.body.active;
  if (![true, false, 0, 1].includes(raw)) v.fail('active must be a boolean');
  await userService.setActive(v.id(req.params.id), Boolean(raw), req.user.id);
  res.json({ ok: true });
}

module.exports = { get, savePrinter, listUsers, createUser, resetPassword, setActive };
