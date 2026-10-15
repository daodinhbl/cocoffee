const axios = require('axios');
const crypto = require('./payonCrypto');
const payonConfig = require('./payonConfig');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/httpError');

/**
 * Calls the PayOn merchant API (docs.nextpay.vn > Thanh toán online): POST {base}/{function} with HTTP Basic auth and
 * { app_id, data: AES(JSON), checksum: md5(app_id + data + secret), ref_code }. The answer is
 * { error_code, error_message, data }; "00" is success. `data` comes back as an object or as an encrypted string
 * (the documentation shows both): both are handled.
 */
const TIMEOUT_MS = 15 * 1000;
const REF_CODE = 'CoCoffee';

/** Vietnamese texts for the error codes of the PayOn documentation. */
const ERRORS = {
  '01': 'PayOn báo giao dịch thất bại.',
  '02': 'PayOn chặn địa chỉ IP của máy chủ này (chưa khai báo). Gửi IP máy chủ cho NextPay để khai báo.',
  '03': 'PayOn từ chối phương thức HTTP.',
  '04': 'PayOn báo sai mã kiểm tra (checksum): kiểm tra lại APP_ID và MC_SECRET_KEY.',
  '05': 'PayOn báo tham số không hợp lệ.',
  '06': 'PayOn không tìm thấy dịch vụ được yêu cầu.',
  '07': 'PayOn báo sai tham số.',
  '08': 'PayOn không tìm thấy yêu cầu thanh toán.',
  '09': 'PayOn báo sai mã merchant (MC_ID).',
  98: 'PayOn không phản hồi kịp (timeout).',
  99: 'PayOn báo lỗi không xác định.',
  '1001-02': 'Mã yêu cầu thanh toán đã tồn tại.',
};

function parseData(data, secret) {
  if (typeof data !== 'string') return data ?? {};
  const plain = crypto.decrypt(data, secret);
  const candidates = plain !== null ? [plain, data] : [data];
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (_) { /* try the next form */ }
  }
  return {};
}

/** @returns {Promise<object>} the `data` of a successful answer */
async function call(fn, params, { config } = {}) {
  const cfg = config || await payonConfig.get();
  if (!cfg.complete) throw new AppError(409, 'PAYON_NOT_CONFIGURED', 'Chưa cấu hình PayOn.');
  const data = crypto.encrypt(JSON.stringify(params), cfg.secretKey);
  const body = { app_id: cfg.appId, data, checksum: crypto.checksum(cfg.appId, data, cfg.secretKey), ref_code: REF_CODE };
  let res;
  try {
    res = await axios.post(`${cfg.baseUrl}/${fn}`, body, {
      auth: { username: cfg.authUser, password: cfg.authPass },
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch (err) {
    logger.warn(`PayOn ${fn}: no answer (${err.code || err.message})`);
    throw new AppError(502, 'PAYON_UNREACHABLE', 'Không kết nối được tới PayOn. Thử lại sau ít phút.');
  }
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    logger.warn(`PayOn ${fn}: HTTP ${res.status}`);
    throw new AppError(502, 'PAYON_HTTP', `PayOn trả về lỗi HTTP ${res.status}.`);
  }
  const code = String(res.data.error_code ?? '');
  if (code !== '00') {
    logger.warn(`PayOn ${fn}: error_code ${code} ${res.data.error_message || ''}`);
    throw new AppError(502, 'PAYON_ERROR', ERRORS[code] || `PayOn báo lỗi ${code}${res.data.error_message ? `: ${res.data.error_message}` : ''}.`, { payonCode: code });
  }
  return parseData(res.data.data, cfg.secretKey);
}

const QR_SERVICE = { service_type_code: 'PAYNOW', service_code: 'PAYNOW_QRLOCALBANK_DYNAMIC', method_code: 'LOCALBANK' };

/** Banks that can show a dynamic QR. @returns {Promise<Array<{code:string, name:string}>>} */
async function qrBanks(config) {
  const data = await call('getQrBankCode', QR_SERVICE, { config });
  const banks = data.Banks ?? data.banks ?? data;
  const list = Array.isArray(banks) ? banks : Object.values(banks || {});
  return list.filter((b) => b && b.code).map((b) => ({ code: String(b.code), name: String(b.trade_name || b.full_name || b.code) }));
}

/**
 * Dynamic bank QR for one payment.
 * @returns {Promise<{payment_id, payment_token, qrcode_pay, qrcode_image, amount_payment, order_amount, time_expired}>}
 */
async function createQr({ requestId, amount, description, expireSeconds, bankCode, urlNotify, urlRedirect, urlCancel }) {
  const cfg = await payonConfig.get();
  return call('createQRCode', {
    merchant_id: Number(cfg.merchantId),
    ...QR_SERVICE,
    merchant_request_id: requestId,
    amount: Math.round(amount),
    time_expire: expireSeconds,
    bank_code: bankCode,
    description,
    currency: 'VND',
    url_redirect: urlRedirect,
    url_notify: urlNotify,
    url_cancel: urlCancel,
  }, { config: cfg });
}

/** The authoritative state of a payment: { status, amount, fee, payment_id, time_performed, ... } (status 2 = paid). */
function checkPayment(requestId) {
  return call('checkPayment', { merchant_request_id: requestId });
}

module.exports = { call, qrBanks, createQr, checkPayment, ERRORS };
