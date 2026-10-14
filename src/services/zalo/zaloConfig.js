const crypto = require('crypto');
const env = require('../../config/env');
const settingsModel = require('../../models/settingsModel');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/httpError');

/**
 * Effective Zalo chatbot configuration. The Zalo Bot Platform token and webhook secret can come from the
 * environment (hPanel) or be entered in Web Admin > Zalo (stored in app_settings); the environment wins.
 *   mode: ZALO_MODE when set explicitly, otherwise 'platform' when a bot token exists, else 'bot'.
 * Cached briefly: the webhook is hot, the settings rarely change (save() refreshes the cache).
 */
const PREFIX = 'zalo.';
const TTL_MS = 30 * 1000;
let cache = null;

async function readStored() {
  try {
    return await settingsModel.getByPrefix(PREFIX);
  } catch (err) {
    logger.warn('Zalo settings unavailable, using environment only', err);
    return {};
  }
}

async function get() {
  if (cache && cache.until > Date.now()) return cache.value;
  const stored = await readStored();
  const botToken = env.zalo.botToken || stored[`${PREFIX}botToken`] || '';
  const botWebhookSecret = env.zalo.botWebhookSecret || stored[`${PREFIX}webhookSecret`] || '';
  const explicit = ['platform', 'bot', 'oa'].includes(process.env.ZALO_MODE) ? process.env.ZALO_MODE : null;
  const value = {
    mode: explicit || (botToken ? 'platform' : 'bot'),
    botToken,
    botWebhookSecret,
    tokenSource: env.zalo.botToken ? 'env' : stored[`${PREFIX}botToken`] ? 'admin' : null,
    secretSource: env.zalo.botWebhookSecret ? 'env' : stored[`${PREFIX}webhookSecret`] ? 'admin' : null,
    tokenHint: botToken ? `…${botToken.slice(-4)}` : '',
    debtOwnerChatId: stored[PREFIX + 'debtOwnerChatId'] || '',
    debtOwnerChatType: stored[PREFIX + 'debtOwnerChatType'] === 'group' ? 'group' : 'user',
  };
  cache = { value, until: Date.now() + TTL_MS };
  return value;
}

const invalidate = () => { cache = null; };

/** Save the bot token from the admin screen; a webhook secret is generated once if none exists. */
async function saveBotToken(token, userId) {
  const stored = await readStored();
  const values = { [`${PREFIX}botToken`]: token };
  if (!env.zalo.botWebhookSecret && !stored[`${PREFIX}webhookSecret`]) values[`${PREFIX}webhookSecret`] = crypto.randomBytes(24).toString('hex');
  await settingsModel.setMany(values, userId);
  invalidate();
  return get();
}

/** Validate the "debt notices go to" form/JSON: { chatId ('' clears it), chatType: user|group }. */
function readDebtRecipient(body = {}) {
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  const chatType = body.chatType === 'group' ? 'group' : body.chatType === 'user' ? 'user' : '';
  if (chatId && !/^[A-Za-z0-9._:-]{1,100}$/.test(chatId)) {
    throw new AppError(400, 'VALIDATION', 'Chat ID không hợp lệ. Hãy sao chép nguyên mã bot trả về.');
  }
  if (!chatType) throw new AppError(400, 'VALIDATION', 'Chọn loại chat nhận thông báo.');
  return { chatId, chatType };
}

async function saveDebtRecipient(chatId, chatType, userId) {
  await settingsModel.setMany({
    [PREFIX + 'debtOwnerChatId']: chatId,
    [PREFIX + 'debtOwnerChatType']: chatType,
  }, userId);
  invalidate();
  return get();
}

module.exports = { get, invalidate, saveBotToken, saveDebtRecipient, readDebtRecipient };
