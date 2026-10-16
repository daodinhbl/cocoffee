const env = require('../../config/env');
const { tokenModel } = require('../../models/zaloModel');
const adminModel = require('../../models/adminModel');
const logger = require('../../utils/logger');
const { render } = require('./common');
const orders = require('./orders');
const { AppError } = require('../../utils/httpError');
const zaloBot = require('../../services/zalo/zaloBotPlatform');
const zaloConfig = require('../../services/zalo/zaloConfig');
const webhookGuard = require('../../services/zalo/webhookGuard');
const chatbotInfo = require('../../services/zalo/chatbotInfo');
const { BANKS } = require('../../services/vietQr');

/** Connection facts for the Zalo screen. Secret / token VALUES are never read into the view model. */
async function connection() {
  const cfg = await zaloConfig.get();
  if (cfg.mode !== 'oa') {
    return {
      mode: cfg.mode,
      platform: cfg.mode === 'platform',
      tokenSet: Boolean(cfg.botToken),
      tokenSource: cfg.tokenSource,
      tokenHint: cfg.tokenHint,
      secretSource: cfg.secretSource,
      explicitMode: ['platform', 'bot', 'oa'].includes(process.env.ZALO_MODE),
      configured: Boolean(cfg.botWebhookSecret) && (cfg.mode !== 'platform' || Boolean(cfg.botToken)),
      webhookUrl: `${env.publicBaseUrl || 'https://<tên-miền-của-bạn>'}/api/zalo/webhook`,
      draftTtlMinutes: env.zalo.draftTtlMinutes,
      debtOwnerChatId: cfg.debtOwnerChatId,
      debtOwnerChatType: cfg.debtOwnerChatType,
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
    debtOwnerChatId: cfg.debtOwnerChatId,
    debtOwnerChatType: cfg.debtOwnerChatType,
    bootstrapPending: configured && !token && Boolean(env.zalo.bootstrapRefreshToken),
    webhookUrl: `${env.publicBaseUrl || 'https://<tên-miền-của-bạn>'}/api/zalo/webhook`,
    verifySignature: env.zalo.verifySignature,
    draftTtlMinutes: env.zalo.draftTtlMinutes,
  };
}

async function page(_req, res) {
  const [conn, stats, events, drafts, failed, chatbot] = await Promise.all([
    connection(), adminModel.zaloEventStats(24), adminModel.zaloRecentEvents(25), adminModel.zaloPendingDrafts(20), adminModel.receiptErrors(10),
    chatbotInfo.get(),
  ]);
  await render(res, 'zalo', {
    title: conn.mode === 'oa' ? 'Zalo OA' : 'Zalo bot', activeMenu: 'zalo', breadcrumbs: [{ label: 'Phân tích', href: '#' }, { label: conn.mode === 'oa' ? 'Zalo OA' : 'Zalo bot' }],
  }, { conn, stats, events, drafts, failed, chatbot, banks: BANKS });
}

/** Zalo's reason without the "Zalo Bot x failed: " prefix, and never containing [token] (some APIs echo what they were sent). */
const zaloReason = (err, token) => String(err.message).replace(/^Zalo Bot \w+ failed: /, '').split(token).join('…');

/**
 * Zalo Bot Platform: getMe + setWebhook from the server itself, with the token from the environment, so the
 * owner never has to copy the token anywhere else. Zalo test-calls the webhook right away and reports back.
 */
async function registerWebhook() {
  const cfg = await zaloConfig.get();
  if (cfg.mode !== 'platform') throw new AppError(409, 'NOT_PLATFORM', 'Chưa có Bot Token: nhập token ở ô "Zalo Bot Platform" trước.');
  const secret = cfg.botWebhookSecret;
  if (!secret || secret.length < 8 || secret.length > 256) throw new AppError(400, 'VALIDATION', 'BOT_WEBHOOK_SECRET phải dài 8–256 ký tự (đặt trong hPanel).');
  if (!/^https:\/\//.test(env.publicBaseUrl || '')) throw new AppError(400, 'VALIDATION', `Zalo chỉ gọi được địa chỉ https công khai, còn app này đang chạy ở ${env.publicBaseUrl || '(chưa đặt PUBLIC_BASE_URL)'}. Hãy đăng ký webhook trên site thật (trang /admin/zalo của tên miền https).`);
  const url = `${env.publicBaseUrl.replace(/\/+$/, '')}/api/zalo/webhook`;
  let me;
  let result;
  try {
    me = await zaloBot.getMe();
    result = await zaloBot.setWebhook(url, secret);
  } catch (err) {
    throw new AppError(502, 'ZALO_BOT_API', `Zalo từ chối: ${zaloReason(err, cfg.botToken)}`);
  }
  const v = result.verification || {};
  if (v.ok !== false) await webhookGuard.remember(url, secret);
  const name = me.account_name || me.display_name || me.name || 'bot';
  return {
    message: v.ok === false
      ? `Đã lưu webhook cho ${name}, nhưng Zalo gọi thử chưa thành công (${v.outcome || 'không rõ'}). ${v.hint || ''}`.trim()
      : `Đã đăng ký webhook cho ${name}: Zalo gọi thử thành công.`,
    to: '/admin/zalo',
  };
}

const BOT_TOKEN_FORMAT = /^[A-Za-z0-9:_\-.]{10,200}$/;

/**
 * Check a Bot Token with Zalo (getMe), store it (a webhook secret is generated once), then register the webhook.
 * The one implementation behind the Web Admin form (saveBotToken) and PUT /api/admin/zalo/bot-token of the app.
 * The token is secret: it is never put into a message, a log line or a response, only into app_settings.
 * @returns {Promise<{ message: string }>}
 */
async function storeBotToken(rawToken, userId) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!BOT_TOKEN_FORMAT.test(token)) throw new AppError(400, 'VALIDATION', 'Bot Token không hợp lệ: dán đúng chuỗi token lấy ở bot.zaloplatforms.com.');
  if (env.zalo.botToken) throw new AppError(409, 'ENV_TOKEN', 'Token đang được đặt trong hPanel (ZALO_BOT_TOKEN); sửa ở đó.');
  try {
    await zaloBot.getMe(token);
  } catch (err) {
    throw new AppError(400, 'ZALO_BOT_API', `Zalo không chấp nhận token này: ${zaloReason(err, token)}`);
  }
  await zaloConfig.saveBotToken(token, userId);
  let reg;
  try {
    reg = await registerWebhook();
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    throw new AppError(err.status, err.code, `Đã lưu Bot Token, nhưng chưa đăng ký được webhook. ${err.message}`, err.details);
  }
  return { message: `Đã lưu Bot Token. ${reg.message}` };
}

/** Save the Bot Token typed in the admin (checked with getMe first), then register the webhook. */
async function saveBotToken(req) {
  const { message } = await storeBotToken(req.body.botToken, req.user.id);
  return { message, to: '/admin/zalo' };
}

async function saveDebtRecipient(req) {
  const { chatId, chatType } = zaloConfig.readDebtRecipient(req.body);
  await zaloConfig.saveDebtRecipient(chatId, chatType, req.user.id);
  return {
    message: chatId ? 'Đã lưu nơi nhận thông báo công nợ qua Zalo.' : 'Đã xóa nơi nhận thông báo công nợ qua Zalo.',
    to: '/admin/zalo',
  };
}

/** Bank account for the "check nợ" QR and the answers to address / wifi / opening-hours questions. */
async function saveChatbotInfo(req) {
  await chatbotInfo.save(req.body, req.user.id);
  return { message: 'Đã lưu nội dung trả lời tự động.', to: '/admin/zalo' };
}

module.exports = { page, connection, registerWebhook, storeBotToken, saveBotToken, saveDebtRecipient, saveChatbotInfo, resendReceipt: orders.resendReceipt };
