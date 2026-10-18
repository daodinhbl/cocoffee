const env = require('../../config/env');
const userModel = require('../../models/userModel');
const userService = require('../../services/userService');
const printerSettings = require('../../services/printerSettings');
const iosApp = require('../../services/iosApp');
const payon = require('../admin/payon');
const { systemConfig } = require('../../services/settingsService');
const v = require('../../utils/validate');

/** Settings screen of the app (admin): printer, iOS download link, PayOn, read-only configuration, staff accounts. */

/**
 * GET /api/admin/settings -> { printer, config, shop_name, ios_app, payon }
 *   shop_name: SHOP_NAME, shown read-only like the web page
 *   ios_app: { url (stored), link ({kind,label,action,url}|null: what is in force), fallback (IOS_APP_URL), app }
 *   payon: { config (no secret values: only set/hint flags), banks (saved by the last connection test), ipnUrl }
 */
async function get(_req, res) {
  const [printer, ios, px] = await Promise.all([printerSettings.get(), iosApp.view(), payon.settingsPanel()]);
  res.json({ printer, config: systemConfig(), shop_name: env.business.shopName, ios_app: ios, payon: px, heli: require('../../services/heli/heliConfig').view(), db_conn: require('../../services/dbConfig').view() });
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

/**
 * Database connection (server, name, user, password): the admin's own password is required in every call (admin_password).
 *   POST /api/admin/settings/db/test    { section: db|cloud, host, port, name, user, password?, admin_password } -> { ok, version, tables, empty }
 *   PUT  /api/admin/settings/db         same body -> { ok, restartNeeded } (tested first; saved to the connection file; applies after a restart)
 *   DELETE /api/admin/settings/db       { section, admin_password } -> { ok } (back to the environment values)
 *   POST /api/admin/settings/db/restart { admin_password } -> { ok }
 * The password is write-only (blank = keep the current one) and never returned.
 */
async function dbConfirm(req) {
  await require('../admin/settings').confirmAdmin(req, (req.body || {}).admin_password);
}
const dbBody = (b) => ({ host: b.host, port: b.port, name: b.name, user: b.user, password: b.password });

async function testDb(req, res) {
  await dbConfirm(req);
  res.json(await require('../../services/dbConfig').test(req.body.section, dbBody(req.body)));
}

async function saveDb(req, res) {
  await dbConfirm(req);
  const r = await require('../../services/dbConfig').save(req.body.section, dbBody(req.body));
  res.json({ ok: true, restartNeeded: r.restartNeeded, version: r.version, tables: r.tables });
}

async function resetDb(req, res) {
  await dbConfirm(req);
  require('../../services/dbConfig').reset(req.body.section);
  res.json({ ok: true });
}

async function restartApp(req, res) {
  await dbConfirm(req);
  require('../../services/dbConfig').restart();
  res.json({ ok: true });
}

/**
 * PUT /api/admin/settings/heli { api_key?, model?, clear? } -> { heli } (the key itself is never returned: enabled, source, hint = last 4)
 * POST /api/admin/settings/heli/test { api_key? } -> { ok, hint } (asks OpenAI; with no api_key it tests the key in force)
 */
async function saveHeli(req, res) {
  const heli = require('../../services/heli/heliConfig');
  const b = req.body || {};
  res.json({ heli: await heli.save({ apiKey: b.api_key, model: b.model, clear: b.clear === true }, req.user.id) });
}

async function testHeli(req, res) {
  res.json(await require('../../services/heli/heliConfig').test((req.body || {}).api_key));
}

/** PUT /api/admin/settings/public-url { url } ('' = back to PUBLIC_BASE_URL) -> { config } */
async function savePublicUrl(req, res) {
  await require('../../services/publicUrl').save((req.body || {}).url, req.user.id);
  res.json({ config: systemConfig() });
}

/** PUT /api/admin/settings/ios-app { url } ('' clears it; only https TestFlight / App Store links) -> { ios_app } */
async function saveIosApp(req, res) {
  await iosApp.save(req.body || {}, req.user.id);
  res.json({ ios_app: await iosApp.view() });
}

/**
 * PUT /api/admin/settings/payon { env, appId, merchantId, authUser, authPass, secretKey, bankCode, expireMinutes, enabled }
 * Same rules as the web form: a blank secret keeps the stored one, values locked by the environment are not copied,
 * switching on needs the full connection set and a QR bank from the saved list. -> { message, payon }
 */
async function savePayon(req, res) {
  const r = await payon.saveSettings({ body: { ...(req.body || {}) }, user: req.user });
  res.json({ message: r.message, payon: await payon.settingsPanel() });
}

/** POST /api/admin/settings/payon/test: calls PayOn with the saved keys and saves its QR bank list -> { message, payon } */
async function testPayon(req, res) {
  const r = await payon.testConnection({ user: req.user });
  res.json({ message: r.message, payon: await payon.settingsPanel() });
}

/** POST /api/admin/settings/payon/ip: the address PayOn sees our calls come from -> { message } */
async function payonIp(_req, res) {
  const r = await payon.showServerIp();
  res.json({ message: r.message });
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

module.exports = { get, testDb, saveDb, resetDb, restartApp, saveHeli, testHeli, savePublicUrl, savePrinter, saveIosApp, savePayon, testPayon, payonIp, listUsers, createUser, resetPassword, setActive };
