const env = require('../config/env');
const settingsModel = require('../models/settingsModel');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');

/**
 * Store / household-business profile, edited in Web Admin > Cài đặt > "Thông tin cửa hàng / hộ kinh doanh" and stored
 * in app_settings under "shop.*". Blank = use the SHOP_* environment value. `apply()` copies the effective values
 * into env.business (the one place the rest of the app reads the shop's name, address, phone, e-mail from), so
 * receipts, the Zalo bot, the landing page etc. all follow what was saved here. Workers refresh it every
 * REFRESH_MS, a save refreshes the saving process at once.
 *
 * Fields beyond the old SHOP_* ones (legalName, ownerName, taxCode, regNo, businessLine, declarationPeriod) are the
 * household-business data the tax books and declarations need (docs/thiet-ke-bao-cao-thue-hkd.md).
 */
const PREFIX = 'shop.';
const REFRESH_MS = 30 * 1000;
const PERIODS = [{ code: 'quarter', label: 'Theo quý' }, { code: 'month', label: 'Theo tháng' }];

// [key, label, max length, kind]
const FIELDS = [
  ['name', 'Tên cửa hàng', 80, 'text'],
  ['legalName', 'Tên hộ kinh doanh (theo giấy đăng ký)', 120, 'text'],
  ['ownerName', 'Chủ hộ kinh doanh', 80, 'text'],
  ['taxCode', 'Mã số thuế', 14, 'tax'],
  ['regNo', 'Số giấy chứng nhận đăng ký hộ kinh doanh', 40, 'text'],
  ['address', 'Địa chỉ kinh doanh', 200, 'text'],
  ['phone', 'Điện thoại', 30, 'text'],
  ['email', 'Email', 100, 'email'],
  ['businessLine', 'Ngành nghề kinh doanh', 120, 'text'],
];

let lastLoad = 0;

function envDefaults() {
  return {
    name: process.env.SHOP_NAME || 'CoCoffee', address: process.env.SHOP_ADDRESS || '', phone: process.env.SHOP_PHONE || '', email: process.env.SHOP_EMAIL || '',
    legalName: '', ownerName: '', taxCode: '', regNo: '', businessLine: 'Dịch vụ ăn uống (quán cà phê)', declarationPeriod: 'quarter',
  };
}

/** Values as stored (blank where nothing was saved) plus the effective ones. */
async function get() {
  let raw = {};
  try {
    raw = await settingsModel.getByPrefix(PREFIX);
  } catch (err) {
    logger.warn('Shop profile unavailable, using the environment', err);
  }
  const d = envDefaults();
  const stored = {};
  const effective = {};
  for (const [key] of FIELDS) {
    stored[key] = typeof raw[PREFIX + key] === 'string' ? raw[PREFIX + key] : '';
    effective[key] = stored[key] || d[key];
  }
  stored.declarationPeriod = PERIODS.some((p) => p.code === raw[`${PREFIX}declarationPeriod`]) ? raw[`${PREFIX}declarationPeriod`] : '';
  effective.declarationPeriod = stored.declarationPeriod || d.declarationPeriod;
  return { stored, effective, defaults: d };
}

/** Copies the effective profile into env.business. Never throws. */
async function apply() {
  try {
    const { effective: p } = await get();
    Object.assign(env.business, {
      shopName: p.name, address: p.address, phone: p.phone, email: p.email,
      legalName: p.legalName, ownerName: p.ownerName, taxCode: p.taxCode, regNo: p.regNo, businessLine: p.businessLine, declarationPeriod: p.declarationPeriod,
    });
    lastLoad = Date.now();
  } catch (err) {
    logger.warn('Shop profile not applied', err);
  }
}

/** Cheap call for the request path: re-reads at most every 30 s. */
async function refresh() {
  if (Date.now() - lastLoad > REFRESH_MS) { lastLoad = Date.now(); await apply(); }
}

async function save(body, userId) {
  const out = {};
  for (const [key, label, max, kind] of FIELDS) {
    const t = typeof body[key] === 'string' ? body[key].trim() : '';
    if (t.length > max) throw new AppError(400, 'VALIDATION', `${label} tối đa ${max} ký tự.`);
    if (kind === 'tax' && t && !/^\d{10}(-\d{3})?$/.test(t)) throw new AppError(400, 'VALIDATION', 'Mã số thuế gồm 10 chữ số, hoặc 13 chữ số dạng 0123456789-001.');
    if (kind === 'email' && t && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) throw new AppError(400, 'VALIDATION', 'Email không hợp lệ.');
    out[PREFIX + key] = t;
  }
  if (!out[`${PREFIX}name`]) throw new AppError(400, 'VALIDATION', 'Tên cửa hàng không được để trống.');
  const period = PERIODS.some((p) => p.code === body.declarationPeriod) ? body.declarationPeriod : '';
  out[`${PREFIX}declarationPeriod`] = period;
  await settingsModel.setMany(out, userId);
  await apply();
}

module.exports = { FIELDS, PERIODS, get, apply, refresh, save };
