const crypto = require('crypto');
const env = require('../../config/env');
const settingsModel = require('../../models/settingsModel');
const logger = require('../../utils/logger');

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

module.exports = { get, invalidate, saveBotToken };
