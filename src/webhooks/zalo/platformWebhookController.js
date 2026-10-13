const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const keyedQueue = require('../../utils/keyedQueue');
const orderModel = require('../../models/orderModel');
const { eventModel } = require('../../models/zaloModel');
const receiptService = require('../../services/receiptService');
const zaloBot = require('../../services/zalo/zaloBotPlatform');
const conversation = require('./zaloConversationService');

/**
 * POST /api/zalo/webhook  (ZALO_MODE=platform: official Zalo Bot Platform, https://bot.zapps.me/docs)
 *
 * Zalo calls us with header X-Bot-Api-Secret-Token = the secret_token given to setWebhook, and a body
 *   { "ok": true, "result": { "event_name": "message.text.received",
 *       "message": { "message_id", "date", "text", "from": { "id", "display_name", "is_bot" },
 *                    "chat": { "id", "chat_type": "PRIVATE" | "GROUP" } } } }
 * We verify -> record the event (idempotent on message_id) -> ACK 200 at once -> process in the background
 * and answer with sendMessage to chat.id. Groups are Beta on Zalo's side; the bot stays silent on group
 * chatter (only orders / commands of the sender with a draft are answered).
 */
function authorized(req) {
  const secret = env.zalo.botWebhookSecret;
  const got = String(req.get('x-bot-api-secret-token') || '');
  if (!secret || !got) return false;
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

/** In groups people may address the bot with a leading "@Bot Name"; drop such a mention before parsing. */
const stripMention = (text) => String(text).replace(/^\s*@\S+\s*[:,-]?\s*/u, '').trim();

async function billText(orderId) {
  const order = await orderModel.getById(orderId);
  return receiptService.buildText(order, await orderModel.getItems(orderId));
}

async function handle(req, res) {
  if (!env.zalo.botToken || !env.zalo.botWebhookSecret) return res.status(503).json({ ok: false, error: 'zalo_bot_not_configured' });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const update = req.body?.result || req.body || {};
  const msg = update.message || {};
  const eventName = String(update.event_name || '');
  const chatId = msg.chat?.id ? String(msg.chat.id) : '';
  const senderId = msg.from?.id ? String(msg.from.id) : '';
  const chatType = String(msg.chat?.chat_type || '').toUpperCase() === 'GROUP' ? 'group' : 'user';
  const messageId = msg.message_id ? String(msg.message_id) : '';
  const key = (messageId ? `zbot:${messageId}` : `zbot:${crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex')}`).slice(0, 100);

  let isNew;
  try {
    isNew = await eventModel.insertIfNew({ key, eventName: eventName || 'unknown', chatId, senderId, payload: update, numRetry: 0 });
  } catch (err) {
    logger.error('zalo_events insert failed (zalo bot)', err);
    return res.status(500).json({ ok: false, error: 'storage_unavailable' });
  }
  res.status(200).json({ ok: true });                 // ACK first; replies go out through sendMessage
  if (!isNew) return undefined;

  if (eventName !== 'message.text.received' || !chatId || !senderId || msg.from?.is_bot || typeof msg.text !== 'string') {
    return eventModel.mark(key, 'ignored').catch(() => {});
  }
  const text = chatType === 'group' ? stripMention(msg.text) : msg.text.trim();
  if (!text) return eventModel.mark(key, 'ignored').catch(() => {});

  const io = {
    reply: (t) => zaloBot.sendText(chatId, t),
    onConfirmed: async (orderId) => {
      try {
        await zaloBot.sendText(chatId, await billText(orderId));
        await orderModel.markReceipt(orderId, null);
      } catch (err) {
        await orderModel.markReceipt(orderId, err.message).catch(() => {});
        throw err;
      }
    },
  };
  return keyedQueue
    .run(`${chatType}:${chatId}:${senderId}`, () => conversation.handleText({ chatType, chatId, userId: senderId, text, msgId: messageId || null }, io))
    .then((action) => eventModel.mark(key, action === 'ignored' ? 'ignored' : 'processed'))
    .catch((err) => {
      logger.error(`Zalo bot event ${key} failed`, err);
      return eventModel.mark(key, 'failed', err.message).catch(() => {});
    });
}

const ping = (_req, res) => res.status(200).json({ ok: true, mode: 'platform' });

module.exports = { handle, ping, authorized, stripMention };
