const env = require('../config/env');
const settingsModel = require('../models/settingsModel');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');
const imageStore = require('./imageStore');

/**
 * Receipt printer configuration, edited in Web Admin > Cài đặt > Máy in hóa đơn.
 * Stored in app_settings under "printer.*"; anything never saved falls back to the environment defaults
 * (RECEIPT_PAPER_MM, SHOP_ADDRESS, SHOP_PHONE, SHOP_PAYMENT_NOTE), so a fresh install prints sensibly.
 *
 * Browsers cannot pick a printer by name: `printerName` is a label for the cashier ("set this one as the
 * default printer of the tablet"), and copies are printed as repeated receipts in a single print job.
 */
const PREFIX = 'printer.';
const PAPERS = [58, 80];
// Logo width on the receipt in mm (small / medium / large); the picture itself is stored once, at most 480 px wide.
const LOGO_SIZES = { s: 22, m: 32, l: 44 };

function defaults() {
  return {
    paperMm: env.receiptPaper.widthMm,
    autoPrint: true,
    copies: 1,
    printerName: '',
    shopAddress: env.business.address || '',
    shopPhone: env.business.phone || '',
    footer: env.business.paymentNote || 'Cảm ơn quý khách — hẹn gặp lại!',
    showVat: true,
    vatRate: 8,
    logoUrl: '',
    logoSize: 'm',
    wifiName: '',
    wifiPassword: '',
  };
}

const bool = (v, fallback) => (v === undefined || v === null ? fallback : v === '1' || v === 'true');
const int = (v, fallback, min, max) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** Current settings. Never throws: a database problem prints with the defaults. */
async function get() {
  const d = defaults();
  let raw = {};
  try {
    raw = await settingsModel.getByPrefix(PREFIX);
  } catch (err) {
    logger.warn('Printer settings unavailable, using defaults', err);
  }
  const s = (k) => raw[PREFIX + k];
  const paper = int(s('paperMm'), d.paperMm, 58, 80);
  return {
    paperMm: PAPERS.includes(paper) ? paper : d.paperMm,
    autoPrint: bool(s('autoPrint'), d.autoPrint),
    copies: int(s('copies'), d.copies, 1, 3),
    printerName: s('printerName') ?? d.printerName,
    shopAddress: s('shopAddress') || d.shopAddress,          // blank -> the shop profile
    shopPhone: s('shopPhone') || d.shopPhone,
    shopName: env.business.shopName,
    legalName: env.business.legalName || '',
    taxCode: env.business.taxCode || '',
    footer: s('footer') ?? d.footer,
    showVat: bool(s('showVat'), d.showVat),
    vatRate: int(s('vatRate'), d.vatRate, 0, 20),
    logoUrl: /^\/media\/\d+-[a-z0-9-]+\.(jpg|png)$/.test(s('logoUrl') || '') ? s('logoUrl') : '',
    logoSize: LOGO_SIZES[s('logoSize')] ? s('logoSize') : d.logoSize,
    wifiName: s('wifiName') ?? d.wifiName,
    wifiPassword: s('wifiPassword') ?? d.wifiPassword,
  };
}

const text = (v, name, max) => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length > max) throw new AppError(400, 'VALIDATION', `${name} tối đa ${max} ký tự.`);
  return t;
};

/** Validate a form body (checkbox pairs send "0"/"1") and save it. */
async function save(body, userId) {
  const paper = Number(body.paperMm);
  if (!PAPERS.includes(paper)) throw new AppError(400, 'VALIDATION', 'Khổ giấy chỉ có thể là 58mm hoặc 80mm.');
  const copies = Number(body.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > 3) throw new AppError(400, 'VALIDATION', 'Số liên in từ 1 đến 3.');
  const vatRate = Number(body.vatRate);
  if (!Number.isInteger(vatRate) || vatRate < 0 || vatRate > 20) throw new AppError(400, 'VALIDATION', 'Thuế VAT từ 0 đến 20%.');
  const flag = (v) => ([].concat(v).includes('1') ? '1' : '0');   // hidden "0" + checkbox "1"
  const logoSize = LOGO_SIZES[body.logoSize] ? body.logoSize : 'm';
  if (body.image_data) {                                           // validate before anything is written
    if (imageStore.decode(body.image_data).ext === 'webp') throw new AppError(400, 'VALIDATION', 'Logo dùng ảnh PNG hoặc JPEG.');
  }
  const currentLogo = (await get()).logoUrl;
  let logoUrl = currentLogo;
  if (body.image_data) logoUrl = await imageStore.save(body.image_data, 'logo', 'logo');
  else if (body.image_remove === '1') logoUrl = '';
  await settingsModel.setMany({
    [`${PREFIX}logoUrl`]: logoUrl,
    [`${PREFIX}logoSize`]: logoSize,
    [`${PREFIX}wifiName`]: text(body.wifiName, 'Tên Wi-Fi', 60),
    [`${PREFIX}wifiPassword`]: text(body.wifiPassword, 'Mật khẩu Wi-Fi', 60),
    [`${PREFIX}paperMm`]: paper,
    [`${PREFIX}autoPrint`]: flag(body.autoPrint),
    [`${PREFIX}copies`]: copies,
    [`${PREFIX}printerName`]: text(body.printerName, 'Tên máy in', 100),
    [`${PREFIX}shopAddress`]: text(body.shopAddress, 'Địa chỉ', 200),
    [`${PREFIX}shopPhone`]: text(body.shopPhone, 'Điện thoại', 30),
    [`${PREFIX}footer`]: text(body.footer, 'Lời chào cuối hóa đơn', 255),
    [`${PREFIX}showVat`]: flag(body.showVat),
    [`${PREFIX}vatRate`]: vatRate,
  }, userId);
  if (currentLogo && currentLogo !== logoUrl) await imageStore.remove(currentLogo);   // after the new one is saved
}

module.exports = { get, save, defaults, PAPERS, LOGO_SIZES };
