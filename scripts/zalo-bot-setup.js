/**
 * One-time setup for the official Zalo Bot Platform (ZALO_MODE=platform).
 *
 *   node scripts/zalo-bot-setup.js            # check the bot, register the webhook, show the result
 *   node scripts/zalo-bot-setup.js --info     # only show the current webhook
 *
 * Needs ZALO_BOT_TOKEN (from https://bot.zaloplatforms.com), BOT_WEBHOOK_SECRET (8-256 chars, becomes the
 * secret_token Zalo sends back in X-Bot-Api-Secret-Token) and PUBLIC_BASE_URL (https). The token is never printed.
 */
const env = require('../src/config/env');
const zaloBot = require('../src/services/zalo/zaloBotPlatform');

(async () => {
  const secret = env.zalo.botWebhookSecret;
  if (!env.zalo.botToken) throw new Error('ZALO_BOT_TOKEN is not set.');
  const me = await zaloBot.getMe();
  console.log(`Bot: ${me.account_name || me.display_name || me.name || '(no name)'}  id=${me.id || '?'}`);

  if (!process.argv.includes('--info')) {
    if (!secret || secret.length < 8 || secret.length > 256) throw new Error('BOT_WEBHOOK_SECRET must be 8-256 characters.');
    if (!/^https:\/\//.test(env.publicBaseUrl || '')) throw new Error('PUBLIC_BASE_URL must be the public https address of this app.');
    const url = `${env.publicBaseUrl.replace(/\/+$/, '')}/api/zalo/webhook`;
    const result = await zaloBot.setWebhook(url, secret);
    const v = result.verification || {};
    console.log(`Webhook set: ${result.url || url}`);
    console.log(`Verification: ${v.ok ? 'OK' : 'NOT OK'} ${v.outcome || ''} ${v.hint || ''}`.trim());
  }
  const info = await zaloBot.getWebhookInfo();
  console.log('Current webhook:', JSON.stringify(info, null, 2));
})().catch((err) => { console.error('Setup failed:', err.message); process.exitCode = 1; });
