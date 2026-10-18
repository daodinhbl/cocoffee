const env = require('../config/env');
const settingsModel = require('../models/settingsModel');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');

/**
 * The public address of this site ("Tên miền công khai": what QR codes, the Zalo webhook, PayOn and bill pictures point at).
 * Normally the PUBLIC_BASE_URL environment variable; the owner can also change it in Cài đặt (web and app), which saves it in
 * app_settings "app.publicBaseUrl" and wins over the environment. That is what makes a changing tunnel address (ngrok) or a
 * newly bought domain a two-tap change instead of a hosting-panel visit. A running site picks a change made elsewhere up
 * within a minute.
 */
const KEY = 'app.publicBaseUrl';

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i;

/** Normalises and checks an address; throws AppError(400) with a Vietnamese reason. '' means "clear". */
function normalize(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try { u = new URL(withScheme); } catch (_) { throw new AppError(400, 'VALIDATION', 'Địa chỉ không hợp lệ. Ví dụ: https://quan-cua-toi.ngrok-free.app'); }
  if (u.username || u.password) throw new AppError(400, 'VALIDATION', 'Địa chỉ không được chứa tên đăng nhập hoặc mật khẩu.');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new AppError(400, 'VALIDATION', 'Chỉ nhập tên miền (không kèm đường dẫn), ví dụ https://quan-cua-toi.com.');
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(u.hostname) && !/^\[[0-9a-f:]+\]$/i.test(u.hostname)) throw new AppError(400, 'VALIDATION', 'Tên miền chứa ký tự không hợp lệ.');
  if (u.protocol === 'http:' && !PRIVATE_HOST.test(u.hostname)) throw new AppError(400, 'VALIDATION', 'Tên miền công khai phải dùng https (http chỉ cho phép trong mạng nội bộ).');
  return `${u.protocol}//${u.host}`;
}

/** Reads the saved address into env. Never throws; an unreadable database keeps the current value. */
async function load() {
  try {
    const raw = (await settingsModel.getByPrefix(KEY))[KEY] || '';
    if (raw !== env.publicUrlOverride.value) logger.info(`Public address is now ${raw || env.publicUrlEnv || '(not set)'}`);
    env.publicUrlOverride.value = raw;
  } catch (err) {
    logger.warn('Public address setting unreadable, keeping the current one', err);
  }
  return env.publicBaseUrl;
}

/** Saves a new address ('' = go back to PUBLIC_BASE_URL). The Zalo webhook is re-registered for the new address in the background. */
async function save(input, userId) {
  const url = normalize(input);
  await settingsModel.setMany({ [KEY]: url }, userId || null);
  env.publicUrlOverride.value = url;
  require('./zalo/webhookGuard').ensure().catch((err) => logger.warn('Zalo webhook not re-registered after the address change', err));
  return env.publicBaseUrl;
}

function startRefresh() {
  setInterval(() => load().catch(() => {}), 60 * 1000).unref();
}

module.exports = { KEY, normalize, load, save, startRefresh };
