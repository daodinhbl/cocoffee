const adminModel = require('../../models/adminModel');
const zaloConfig = require('../../services/zalo/zaloConfig');
const chatbotInfo = require('../../services/zalo/chatbotInfo');
const { BANKS } = require('../../services/vietQr');
const zaloPage = require('../admin/zalo');

/**
 * Zalo screen of the app (admin). The Bot Token can be entered here too (PUT /zalo/bot-token); it is write-only:
 * checked with Zalo, stored on the server, and never sent back, shown, logged or put in an error message.
 */

/** GET /api/admin/zalo -> { connection (no secrets, no token hint), stats, events, drafts, failed, chatbot, banks } */
async function overview(_req, res) {
  const [conn, stats, events, drafts, failed, chatbot] = await Promise.all([
    zaloPage.connection(), adminModel.zaloEventStats(24), adminModel.zaloRecentEvents(25), adminModel.zaloPendingDrafts(20),
    adminModel.receiptErrors(10), chatbotInfo.get(),
  ]);
  const connection = { ...conn };
  delete connection.tokenHint;
  res.json({ connection, stats, events, drafts, failed, chatbot, banks: BANKS });
}

/** PUT /api/admin/zalo/debt-recipient { chatId ('' clears it), chatType: user|group } -> { ok, chatId, chatType } */
async function saveDebtRecipient(req, res) {
  const { chatId, chatType } = zaloConfig.readDebtRecipient(req.body);
  await zaloConfig.saveDebtRecipient(chatId, chatType, req.user.id);
  res.json({ ok: true, chatId, chatType });
}

const CHATBOT_FIELDS = ['bankBin', 'bankAccount', 'bankAccountName', 'address', 'wifi', 'hours'];

/** PUT /api/admin/zalo/chatbot-info: only the fields sent change ('' clears one) -> { chatbot } */
async function saveChatbotInfo(req, res) {
  const current = await chatbotInfo.get();
  const body = {};
  for (const k of CHATBOT_FIELDS) body[k] = req.body[k] !== undefined ? req.body[k] : current[k];
  await chatbotInfo.save(body, req.user.id);
  res.json({ chatbot: await chatbotInfo.get() });
}

/** POST /api/admin/zalo/register-webhook (Zalo Bot Platform) -> { ok, message } */
async function registerWebhook(_req, res) {
  const r = await zaloPage.registerWebhook();
  res.json({ ok: true, message: r.message });
}

/**
 * PUT /api/admin/zalo/bot-token { token } -> { ok, message }. The Web Admin form's logic (admin/zalo.js storeBotToken):
 * format check, getMe with Zalo, store (+ webhook secret), register the webhook. Not under idempotency(): that
 * middleware would keep the response, and nothing about the token may be kept anywhere but app_settings.
 */
async function saveBotToken(req, res) {
  const { message } = await zaloPage.storeBotToken(req.body.token, req.user.id);
  res.json({ ok: true, message });
}

module.exports = { overview, saveDebtRecipient, saveChatbotInfo, registerWebhook, saveBotToken };
