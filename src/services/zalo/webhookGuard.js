const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const settingsModel = require('../../models/settingsModel');
const zaloBot = require('./zaloBotPlatform');
const zaloConfig = require('./zaloConfig');

/**
 * Keeps the Zalo Bot Platform webhook registered with the CURRENT address and secret.
 *
 * Zalo only calls the webhook it was given with setWebhook({ url, secret_token }). Changing BOT_WEBHOOK_SECRET or
 * ZALO_BOT_TOKEN in hPanel (or the domain) without registering again leaves Zalo calling with the old secret: every
 * message is answered 401 and the bot looks deaf while sending (replies, "Gửi lại bill") still works.
 * At boot (platform mode, https PUBLIC_BASE_URL, secret set) this compares a fingerprint of url + secret with the one
 * stored when the webhook was last registered; when it differs, or Zalo reports another URL, it registers again.
 * Everything is logged (never the token or the secret) so the Hostinger runtime log shows what Zalo has.
 */
const SETTING_KEY = 'zalo.webhookFingerprint';
const fingerprint = (url, secret) => crypto.createHash('sha256').update(`${url}\n${secret}`).digest('hex').slice(0, 32);

/** The fields of getWebhookInfo worth logging (no secret). */
function summarize(info) {
  const out = {};
  for (const [k, v] of Object.entries(info || {})) {
    if (/secret|token/i.test(k)) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return out;
}

async function remembered() {
  try {
    return (await settingsModel.getByPrefix(SETTING_KEY))[SETTING_KEY] || '';
  } catch (_) {
    return '';
  }
}

/** Call after a successful setWebhook (the admin button does too), so boot does not register again. */
async function remember(url, secret) {
  try {
    await settingsModel.setMany({ [SETTING_KEY]: fingerprint(url, secret) }, null);
  } catch (err) {
    logger.warn('Zalo webhook: could not store the registration fingerprint', err);
  }
}

/**
 * @param {{ force?: boolean }} [opts]  force: register even when nothing seems to have changed
 * @returns {Promise<'not_platform'|'no_https_url'|'no_secret'|'ok'|'registered'|'registered_unverified'|'failed'>}
 */
async function ensure({ force = false } = {}) {
  try {
    const cfg = await zaloConfig.get();
    if (cfg.mode !== 'platform' || !cfg.botToken) return 'not_platform';
    const base = (env.publicBaseUrl || '').replace(/\/+$/, '');
    if (!/^https:\/\//.test(base)) {
      logger.info(`Zalo webhook: not checked (PUBLIC_BASE_URL is "${base || 'empty'}", Zalo needs a public https address)`);
      return 'no_https_url';
    }
    const secret = cfg.botWebhookSecret;
    if (!secret || secret.length < 8 || secret.length > 256) {
      logger.warn('Zalo webhook: BOT_WEBHOOK_SECRET is missing or not 8-256 characters, the bot cannot receive messages');
      return 'no_secret';
    }
    const url = `${base}/api/zalo/webhook`;
    const want = fingerprint(url, secret);

    let info = null;
    try {
      info = await zaloBot.getWebhookInfo();
      logger.info(`Zalo webhook info: ${JSON.stringify(summarize(info))}`);
    } catch (err) {
      logger.warn(`Zalo webhook: getWebhookInfo failed (${err.message})`);
    }
    const sameUrl = info && typeof info.url === 'string' && info.url.replace(/\/+$/, '') === url;
    const unchanged = (await remembered()) === want;
    if (!force && sameUrl && unchanged) return 'ok';

    const why = force ? 'forced' : !info || !info.url ? 'Zalo has no webhook for this bot' : !sameUrl ? `Zalo has ${info.url}` : 'secret or token changed since the last registration';
    logger.info(`Zalo webhook: registering ${url} (${why})`);
    const result = await zaloBot.setWebhook(url, secret);
    const v = (result && result.verification) || {};
    logger.info(`Zalo webhook registered: ${JSON.stringify(summarize(result))}`);
    if (v.ok === false) {
      // Zalo could not call the address: do NOT remember it, so the next boot checks again (the address may be fixed by then)
      logger.warn(`Zalo webhook: Zalo's test call failed (${v.outcome || 'unknown'}) ${v.hint || ''}`.trim());
      return 'registered_unverified';
    }
    await remember(url, secret);
    return 'registered';
  } catch (err) {
    logger.error(`Zalo webhook check failed: ${err.message}`);
    return 'failed';
  }
}

module.exports = { ensure, remember, fingerprint, summarize, SETTING_KEY };
