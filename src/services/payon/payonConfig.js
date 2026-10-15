const env = require('../../config/env');
const settingsModel = require('../../models/settingsModel');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/httpError');

/**
 * PayOn (NextPay) connection settings. Values come from the environment (hPanel) or from Web Admin > Cài đặt (stored in
 * app_settings under "payon."); the environment wins. The secrets are never sent back to a page: `view()` carries only a
 * "set / not set" flag and the last characters.
 * Cached briefly: the notification endpoint is hot, the settings rarely change (save() refreshes the cache).
 */
const PREFIX = 'payon.';
const TTL_MS = 30 * 1000;
const URLS = {
  sandbox: 'https://dev-api-merchant.payon.vn/v1/merchant',
  production: 'https://sdk.payon.vn/v1/merchant',
};
const SECRET_FIELDS = ['authPass', 'secretKey'];
let cache = null;

async function readStored() {
  try {
    return await settingsModel.getByPrefix(PREFIX);
  } catch (err) {
    logger.warn('PayOn settings unavailable, using environment only', err);
    return {};
  }
}

const hint = (v) => (v ? `…${String(v).slice(-4)}` : '');

async function get() {
  if (cache && cache.until > Date.now()) return cache.value;
  const stored = await readStored();
  const pick = (envValue, key) => envValue || stored[PREFIX + key] || '';
  const mode = ['sandbox', 'production'].includes(env.payon.env) ? env.payon.env : (stored[`${PREFIX}env`] === 'production' ? 'production' : 'sandbox');
  const value = {
    enabled: stored[`${PREFIX}enabled`] === '1',
    env: mode,
    baseUrl: URLS[mode],
    appId: pick(env.payon.appId, 'appId'),
    merchantId: pick(env.payon.merchantId, 'merchantId'),
    authUser: pick(env.payon.authUser, 'authUser'),
    authPass: pick(env.payon.authPass, 'authPass'),
    secretKey: pick(env.payon.secretKey, 'secretKey'),
    bankCode: stored[`${PREFIX}bankCode`] || '',
    bankName: stored[`${PREFIX}bankName`] || '',
    expireMinutes: Math.min(60, Math.max(3, parseInt(stored[`${PREFIX}expireMinutes`], 10) || 15)),
  };
  value.complete = Boolean(value.appId && /^\d+$/.test(value.merchantId) && value.authUser && value.authPass && value.secretKey);
  value.ready = value.enabled && value.complete && Boolean(value.bankCode);
  cache = { value, until: Date.now() + TTL_MS };
  return value;
}

const invalidate = () => { cache = null; };

/** What the admin page may show: no secret values. */
async function view() {
  const c = await get();
  return {
    enabled: c.enabled, env: c.env, baseUrl: c.baseUrl, complete: c.complete, ready: c.ready,
    appId: c.appId, merchantId: c.merchantId, authUser: c.authUser, bankCode: c.bankCode, bankName: c.bankName, expireMinutes: c.expireMinutes,
    authPassSet: Boolean(c.authPass), authPassHint: hint(c.authPass), secretKeySet: Boolean(c.secretKey), secretKeyHint: hint(c.secretKey),
    fromEnv: {
      env: ['sandbox', 'production'].includes(env.payon.env), appId: Boolean(env.payon.appId), merchantId: Boolean(env.payon.merchantId),
      authUser: Boolean(env.payon.authUser), authPass: Boolean(env.payon.authPass), secretKey: Boolean(env.payon.secretKey),
    },
  };
}

const text = (v, name, max) => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length > max) throw new AppError(400, 'VALIDATION', `${name} tối đa ${max} ký tự.`);
  return t;
};

/**
 * Save the admin form. A blank secret keeps the stored one (the page never shows it); a blank text field clears it.
 * Switching on needs the full connection set and a QR bank.
 */
async function save(body, userId) {
  const stored = await readStored();
  const values = {};
  const mode = body.env === 'production' ? 'production' : 'sandbox';
  values[`${PREFIX}env`] = mode;
  values[`${PREFIX}appId`] = text(body.appId, 'APP_ID', 60);
  const merchantId = text(body.merchantId, 'Mã merchant (MC_ID)', 20);
  if (merchantId && !/^\d+$/.test(merchantId)) throw new AppError(400, 'VALIDATION', 'Mã merchant (MC_ID) phải là số.');
  values[`${PREFIX}merchantId`] = merchantId;
  values[`${PREFIX}authUser`] = text(body.authUser, 'MC_AUTH_USER', 100);
  for (const f of SECRET_FIELDS) {
    const v = text(body[f], f, 200);
    if (v) values[PREFIX + f] = v;                                  // blank = keep
  }
  values[`${PREFIX}bankCode`] = text(body.bankCode, 'Ngân hàng QR', 40);
  values[`${PREFIX}bankName`] = text(body.bankName, 'Tên ngân hàng', 100);
  const minutes = parseInt(body.expireMinutes, 10);
  values[`${PREFIX}expireMinutes`] = String(Number.isInteger(minutes) ? Math.min(60, Math.max(3, minutes)) : 15);
  const wantOn = ['1', 'on', 'true'].includes(String(Array.isArray(body.enabled) ? body.enabled[body.enabled.length - 1] : body.enabled));
  const merged = (k, envValue) => envValue || values[PREFIX + k] || stored[PREFIX + k] || '';
  const complete = merged('appId', env.payon.appId) && /^\d+$/.test(merged('merchantId', env.payon.merchantId)) && merged('authUser', env.payon.authUser)
    && merged('authPass', env.payon.authPass) && merged('secretKey', env.payon.secretKey);
  if (wantOn && !complete) throw new AppError(400, 'VALIDATION', 'Nhập đủ APP_ID, MC_ID, MC_AUTH_USER, MC_AUTH_PASS và MC_SECRET_KEY trước khi bật.');
  if (wantOn && !values[`${PREFIX}bankCode`]) throw new AppError(400, 'VALIDATION', 'Bấm "Kiểm tra kết nối" rồi chọn ngân hàng QR trước khi bật.');
  values[`${PREFIX}enabled`] = wantOn ? '1' : '0';
  await settingsModel.setMany(values, userId);
  invalidate();
  return get();
}

module.exports = { get, view, save, invalidate, URLS };
