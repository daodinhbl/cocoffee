const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const tenantContext = require('../config/tenantContext');
const { pool } = require('../config/db');
const userModel = require('../models/userModel');
const settingsModel = require('../models/settingsModel');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');

/**
 * First-run setup, like WordPress's install.php: a database with the tables but no accounts is "not installed" and the
 * whole site shows /cai-dat until an owner is created there. The owner chooses a blank shop, or one filled with sample
 * data (the demo tables from database/seed.sql plus the CoCoffee menu board).
 */
const DB_DIR = path.join(env.rootDir, 'database');
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 'yes' is remembered per shop for good; 'no' is re-checked on every request (2 s cache) so the gate lifts right after the setup.
const known = new Map();      // tenant key -> { installed, at }

/** true / false, or null when the database cannot say (down, or no tables yet: see hasTables). */
async function isInstalled() {
  if (!env.db.installWizard) return true;
  const k = tenantContext.key();
  const hit = known.get(k);
  if (hit && (hit.installed || Date.now() - hit.at < 2000)) return hit.installed;
  try {
    const installed = (await userModel.count()) > 0;
    known.set(k, { installed, at: Date.now() });
    return installed;
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') return false;
    logger.warn('Install check: database unavailable, treating the site as installed', err);
    return true;                                  // never lock a running shop out because of a database hiccup
  }
}

async function hasTables() {
  try { await userModel.count(); return true; } catch (_) { return false; }
}

const forget = () => known.delete(tenantContext.key());

/** seed.sql without its default admin/admin account (the owner creates their own). Statements are split on ";" at a line end. */
function sampleStatements() {
  const sql = fs.readFileSync(path.join(DB_DIR, 'seed.sql'), 'utf8');
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^(\s*--[^\n]*\n)+/g, '').trim())
    .filter((s) => s && !/^SET NAMES/i.test(s) && !/^INSERT INTO users\b/i.test(s));
}

function validate(b) {
  const fail = (m, field) => { const e = new AppError(400, 'VALIDATION', m); e.field = field; throw e; };
  const shopName = String(b.shopName || '').trim();
  const username = String(b.username || '').trim().toLowerCase();
  const fullName = String(b.fullName || '').trim();
  const email = String(b.email || '').trim();
  const password = String(b.password || '');
  if (shopName.length < 2 || shopName.length > 80) fail('Tên quán cần 2-80 ký tự.', 'shopName');
  if (fullName.length < 2 || fullName.length > 100) fail('Họ tên chủ quán cần 2-100 ký tự.', 'fullName');
  if (!USER_RE.test(username)) fail('Tên đăng nhập gồm 3-30 ký tự: chữ thường, số, dấu chấm, gạch ngang hoặc gạch dưới.', 'username');
  if (email && (!EMAIL_RE.test(email) || email.length > 100)) fail('Email không hợp lệ.', 'email');
  if (password.length < 10 || password.length > 72) fail('Mật khẩu cần 10-72 ký tự.', 'password');
  if (password !== String(b.password2 ?? '')) fail('Hai lần nhập mật khẩu chưa giống nhau.', 'password2');
  if (!['blank', 'sample'].includes(b.data)) fail('Chọn dữ liệu ban đầu: trống hoặc mẫu.', 'data');
  if (env.db.installToken && String(b.token || '') !== env.db.installToken) fail('Mã cài đặt không đúng.', 'token');
  return { shopName, username, fullName, email, password, sample: b.data === 'sample' };
}

/** Creates the owner (only while there is no account at all), the shop name, and the chosen starting data. */
async function install(body) {
  if (!(await hasTables())) throw new AppError(409, 'CONFLICT', 'Database chưa có bảng. Bật AUTO_BOOTSTRAP_DB=true rồi khởi động lại, hoặc nhập database/schema.sql.');
  if (await isInstalled()) throw new AppError(409, 'CONFLICT', 'Trang web đã được cài đặt.');
  const f = validate(body);
  // One statement: the account is inserted only if the table is still empty, so two people submitting at once cannot both win.
  const [res] = await pool.query(
    "INSERT INTO users (username, password_hash, full_name, role) SELECT ?, ?, ?, 'admin' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM users)",
    [f.username, bcrypt.hashSync(f.password, 12), f.fullName]
  );
  if (!res.affectedRows) throw new AppError(409, 'CONFLICT', 'Trang web vừa được cài đặt bởi người khác.');
  forget();
  const values = { 'shop.name': f.shopName, 'shop.ownerName': f.fullName };
  if (f.email) values['shop.email'] = f.email;
  await settingsModel.setMany(values, res.insertId);
  if (f.sample) await loadSample();
  else await settingsModel.setMany({ 'seed.menu_v1': '"skipped-empty"' }, res.insertId);   // blank means blank: the printed menu is never injected later (same marker menuSeed writes for an empty database)
  known.set(tenantContext.key(), { installed: true, at: Date.now() });
  logger.info(`Install finished for "${f.shopName}" (${f.sample ? 'sample data' : 'blank'})`);
  return { shopName: f.shopName, sample: f.sample };
}

async function loadSample() {
  for (const stmt of sampleStatements()) await pool.query(stmt);
  const menuSeed = require('../config/menuSeed');
  await menuSeed.ensureMenuSeed();
  await menuSeed.ensureMenuAliases();
  await require('../config/menuPhotos').ensureMenuPhotos();
  require('../models/productModel').invalidateCatalog();
}

module.exports = { isInstalled, hasTables, install, validate, sampleStatements, forget };
