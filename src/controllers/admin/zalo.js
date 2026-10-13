const env = require('../../config/env');
const { tokenModel } = require('../../models/zaloModel');
const adminModel = require('../../models/adminModel');
const logger = require('../../utils/logger');
const { render } = require('./common');
const orders = require('./orders');

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

module.exports = { page, connection, resendReceipt: orders.resendReceipt };
