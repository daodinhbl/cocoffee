const env = require('../../config/env');
const logger = require('../../utils/logger');
const settingsModel = require('../../models/settingsModel');
const printerSettings = require('../printerSettings');
const vietQr = require('../vietQr');
const { AppError } = require('../../utils/httpError');

/**
 * What the chatbot tells customers on its own, edited in Web Admin > Zalo > "Trả lời tự động":
 *   - the bank account customers transfer to (VietQR code for "check nợ", and the answer to "stk");
 *   - short answers for the address, Wi-Fi and opening hours questions.
 * Stored in app_settings under "chatbot.*". The address falls back to the receipt printer's shop address.
 */
const PREFIX = 'chatbot.';

async function get() {
  let raw = {};
  try {
    raw = await settingsModel.getByPrefix(PREFIX);
  } catch (err) {
    logger.warn('Chatbot settings unavailable', err);
  }
  const s = (k) => raw[PREFIX + k] || '';
  const printer = await printerSettings.get();
  const bankBin = s('bankBin');
  return {
    bankBin,
    bankName: vietQr.bankName(bankBin),
    bankAccount: s('bankAccount'),
    bankAccountName: s('bankAccountName'),
    address: s('address'),
    shopAddress: printer.shopAddress || '',
    shopPhone: printer.shopPhone || '',
    wifi: s('wifi'),
    hours: s('hours'),
  };
}

const bankReady = (info) => Boolean(info.bankBin && info.bankName && info.bankAccount);

/** "Vietcombank · 0123456789 · NGUYEN VAN A" (or '' when no account is set). */
const bankLine = (info) => (bankReady(info) ? [info.bankName, info.bankAccount, info.bankAccountName].filter(Boolean).join(' · ') : '');

/** Ready-to-send answer for a FAQ key, or null when the shop has not filled it in. */
function faqAnswer(key, info) {
  const shop = env.business.shopName;
  switch (key) {
    case 'address': {
      const address = info.address || info.shopAddress;
      if (!address) return null;
      return [`📍 ${shop}: ${address}`, info.shopPhone ? `☎️ ${info.shopPhone}` : ''].filter(Boolean).join('\n');
    }
    case 'wifi': return info.wifi ? `📶 Wifi của quán: ${info.wifi}` : null;
    case 'hours': return info.hours ? `🕒 Giờ mở cửa: ${info.hours}` : null;
    case 'bank': return bankReady(info) ? `🏦 Chuyển khoản cho ${shop}:\n${bankLine(info)}` : null;
    default: return null;
  }
}

const text = (v, name, max) => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length > max) throw new AppError(400, 'VALIDATION', `${name} tối đa ${max} ký tự.`);
  return t;
};

/** Validate the admin form and save it. An empty bank account switches the QR off. */
async function save(body, userId) {
  const bankBin = text(body.bankBin, 'Ngân hàng', 6);
  if (bankBin && !vietQr.bankName(bankBin)) throw new AppError(400, 'VALIDATION', 'Chọn ngân hàng trong danh sách.');
  const bankAccount = text(body.bankAccount, 'Số tài khoản', 19).replace(/\s+/g, '');
  if (bankAccount && !/^[0-9A-Za-z]{4,19}$/.test(bankAccount)) throw new AppError(400, 'VALIDATION', 'Số tài khoản chỉ gồm chữ và số (4-19 ký tự).');
  if (bankAccount && !bankBin) throw new AppError(400, 'VALIDATION', 'Chọn ngân hàng của tài khoản.');
  const bankAccountName = vietQr.cleanNote(text(body.bankAccountName, 'Tên chủ tài khoản', 50), 50).toUpperCase();
  await settingsModel.setMany({
    [`${PREFIX}bankBin`]: bankAccount ? bankBin : '',
    [`${PREFIX}bankAccount`]: bankAccount,
    [`${PREFIX}bankAccountName`]: bankAccountName,
    [`${PREFIX}address`]: text(body.address, 'Địa chỉ', 200),
    [`${PREFIX}wifi`]: text(body.wifi, 'Wifi', 200),
    [`${PREFIX}hours`]: text(body.hours, 'Giờ mở cửa', 200),
  }, userId);
}

module.exports = { get, save, bankReady, bankLine, faqAnswer };
