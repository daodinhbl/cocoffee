const crypto = require('crypto');
const logger = require('../../utils/logger');
const keyedQueue = require('../../utils/keyedQueue');
const orderModel = require('../../models/orderModel');
const { eventModel } = require('../../models/zaloModel');
const receiptService = require('../../services/receiptService');
const conversation = require('./zaloConversationService');
const zaloConfig = require('../../services/zalo/zaloConfig');

/**
 * POST /api/zalo/webhook  (ZALO_MODE=bot, the default)
 *
 * A Bot Client running OUTSIDE Hostinger (PC/VPS) is logged in to a personal Zalo account. For every
 * text message it receives it POSTs the message here and sends back to the same chat whatever we return
 * in `replies`. All POS logic (menu matching, draft orders, the confirm transaction, stock) stays here.
 *
 *   Authorization: Bearer <BOT_WEBHOOK_SECRET>
 *   { "groupId": "g123" | null, "senderId": "u456", "senderName": "Lan", "message": "2 cà phê sữa", "messageId": "m789" }
 *   -> 200 { "ok": true, "action": "draft", "replies": [{ "type": "text", "text": "🧾 ĐƠN TẠM ..." }] }
 *
 * Synchronous on purpose: the bot needs the reply text. Messages of the same sender in the same chat are
 * serialized (keyedQueue) so "2 cà phê" followed at once by "ok" is processed in order. A repeated
 * messageId (bot retry) is answered with no replies, so an order is never created or confirmed twice.
 */
const MAX_TEXT = 2000;

/** Constant-time comparison of the bearer token (hashing first equalizes the lengths). */
function authorized(req, secret) {
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!secret || !token) return false;
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');

/** Bill text for the group once the order is committed; marks the receipt as delivered. */
async function billText(orderId) {
  const order = await orderModel.getById(orderId);
  const items = await orderModel.getItems(orderId);
  await orderModel.markReceipt(orderId, null).catch(() => {});
  return receiptService.buildText(order, items);
}

async function handle(req, res) {
  const { botWebhookSecret } = await zaloConfig.get();
  if (!botWebhookSecret) return res.status(503).json({ ok: false, error: 'bot_not_configured' });
  if (!authorized(req, botWebhookSecret)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const body = req.body || {};
  const message = str(body.message, MAX_TEXT);
  const senderId = str(body.senderId, 64);
  const groupId = str(body.groupId, 64);
  const messageId = str(body.messageId, 80);
  if (!senderId || !message) return res.status(400).json({ ok: false, error: 'senderId and message are required' });

  const chatType = groupId ? 'group' : 'user';
  const chatId = groupId || senderId;
  const key = messageId ? `bot:${messageId}` : `bot:${crypto.createHash('sha256').update(`${chatId}|${senderId}|${message}|${Date.now()}`).digest('hex')}`;

  let isNew;
  try {
    isNew = await eventModel.insertIfNew({
      key: key.slice(0, 100), eventName: groupId ? 'bot_group_text' : 'bot_user_text', chatId, senderId,
      payload: { groupId: groupId || null, senderId, senderName: str(body.senderName, 100) || null, message, messageId: messageId || null },
      numRetry: 0,
    });
  } catch (err) {
    logger.error('zalo_events insert failed (bot)', err);
    return res.status(500).json({ ok: false, error: 'storage_unavailable' });
  }
  if (!isNew) return res.json({ ok: true, duplicate: true, action: 'ignored', replies: [] });

  const replies = [];
  const io = {
    reply: async (text) => { replies.push({ type: 'text', text }); },
    onConfirmed: async (orderId) => { replies.push({ type: 'text', text: await billText(orderId) }); },
  };

  try {
    const action = await keyedQueue.run(`${chatType}:${chatId}:${senderId}`, () =>
      conversation.handleText({ chatType, chatId, userId: senderId, text: message, msgId: messageId || null }, io));
    await eventModel.mark(key.slice(0, 100), action === 'ignored' ? 'ignored' : 'processed').catch(() => {});
    return res.json({ ok: true, action: action || 'ignored', chat: { groupId: groupId || null, senderId }, replies });
  } catch (err) {
    logger.error(`Bot message ${key} failed`, err);
    await eventModel.mark(key.slice(0, 100), 'failed', err.message).catch(() => {});
    return res.status(500).json({ ok: false, error: 'processing_failed', replies: [] });
  }
}

/** GET /api/zalo/webhook - liveness probe for the Bot Client. */
const ping = (_req, res) => res.status(200).json({ ok: true, mode: 'bot' });

module.exports = { handle, ping, authorized };
