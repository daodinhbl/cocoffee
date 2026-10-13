const env = require('../../config/env');
const { tokenModel } = require('../../models/zaloModel');
const adminModel = require('../../models/adminModel');
const logger = require('../../utils/logger');
const { render } = require('./common');
const orders = require('./orders');
const { AppError } = require('../../utils/httpError');
const zaloBot = require('../../services/zalo/zaloBotPlatform');

/** Connection facts for the Zalo screen. Secret / token VALUES are never read into the view model. */
async function connection() {
  if (env.zalo.mode !== 'oa') {
    return {
      mode: env.zalo.mode,
      platform: env.zalo.mode === 'platform',
      tokenSet: Boolean(env.zalo.botToken),
      configured: Boolean(env.zalo.botWebhookSecret) && (env.zalo.mode !== 'platform' || Boolean(env.zalo.botToken)),
      webhookUrl: `${env.publicBaseUrl || 'https://<tên-miền-của-bạn>'}/api/zalo/webhook`,
      draftTtlMinutes: env.zalo.draftTtlMinutes,
    };
  }
  const configured = Boolean(env.zalo.appId && env.zalo.oaSecretKey && env.zalo.appSecretKey);
  let token = null;
  let readError = false;
  try {
    const row = await tokenModel.get(null);
    if (row) token = { accessExpiresAt: row.access_expires_at, needsRefresh: Boolean(row.needs_refresh) };
  } catch (err) {
    readError = true;
    logger.warn('Zalo screen: could not read token state', err);
  }
  return {
    mode: 'oa', configured, token, readError,
    bootstrapPending: configured && !token && Boolean(env.zalo.bootstrapRefreshToken),
    webhookUrl: `${env.publicBaseUrl || 'https://<tên-miền-của-bạn>'}/api/zalo/webhook`,
    verifySignature: env.zalo.verifySignature,
    draftTtlMinutes: env.zalo.draftTtlMinutes,
  };
}

async function page(_req, res) {
  const [conn, stats, events, drafts, failed] = await Promise.all([
    connection(), adminModel.zaloEventStats(24), adminModel.zaloRecentEvents(25), adminModel.zaloPendingDrafts(20), adminModel.receiptErrors(10),
  ]);
  await render(res, 'zalo', {
    title: conn.mode === 'oa' ? 'Zalo OA' : 'Zalo bot', activeMenu: 'zalo', breadcrumbs: [{ label: 'Phân tích', href: '#' }, { label: conn.mode === 'oa' ? 'Zalo OA' : 'Zalo bot' }],
  }, { conn, stats, events, drafts, failed });
}

/**
 * Zalo Bot Platform: getMe + setWebhook from the server itself, with the token from the environment, so the
 * owner never has to copy the token anywhere else. Zalo test-calls the webhook right away and reports back.
 */
async function registerWebhook() {
  if (env.zalo.mode !== 'platform') throw new AppError(409, 'NOT_PLATFORM', 'Chưa có ZALO_BOT_TOKEN: đặt biến này trong hPanel trước.');
  const secret = env.zalo.botWebhookSecret;
  if (!secret || secret.length < 8 || secret.length > 256) throw new AppError(400, 'VALIDATION', 'BOT_WEBHOOK_SECRET phải dài 8–256 ký tự (đặt trong hPanel).');
  if (!/^https:\/\//.test(env.publicBaseUrl || '')) throw new AppError(400, 'VALIDATION', 'PUBLIC_BASE_URL phải là địa chỉ https công khai của app.');
  const url = `${env.publicBaseUrl.replace(/\/+$/, '')}/api/zalo/webhook`;
  let me;
  let result;
  try {
    me = await zaloBot.getMe();
    result = await zaloBot.setWebhook(url, secret);
  } catch (err) {
    throw new AppError(502, 'ZALO_BOT_API', `Zalo từ chối: ${err.message.replace(/^Zalo Bot \w+ failed: /, '')}`);
  }
  const v = result.verification || {};
  const name = me.account_name || me.display_name || me.name || 'bot';
  return {
    message: v.ok === false
      ? `Đã lưu webhook cho ${name}, nhưng Zalo gọi thử chưa thành công (${v.outcome || 'không rõ'}). ${v.hint || ''}`.trim()
      : `Đã đăng ký webhook cho ${name}: Zalo gọi thử thành công.`,
    to: '/admin/zalo',
  };
}

module.exports = { page, connection, registerWebhook, resendReceipt: orders.resendReceipt };
