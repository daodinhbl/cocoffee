const crypto = require('crypto');
const logger = require('../../utils/logger');
const keyedQueue = require('../../utils/keyedQueue');
const orderModel = require('../../models/orderModel');
const { eventModel } = require('../../models/zaloModel');
const receiptService = require('../../services/receiptService');
const zaloBot = require('../../services/zalo/zaloBotPlatform');
const conversation = require('./zaloConversationService');
const zaloConfig = require('../../services/zalo/zaloConfig');

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
let lastRefusalLogged = 0;
function logRefusal(req, secret) {
  if (Date.now() - lastRefusalLogged < 60 * 1000) return;   // one line a minute, however many calls Zalo retries
  lastRefusalLogged = Date.now();
  const got = String(req.get('x-bot-api-secret-token') || '');
  require('../../utils/logger').warn(`Zalo webhook REFUSED: ${got ? 'X-Bot-Api-Secret-Token does not match BOT_WEBHOOK_SECRET (register the webhook again in Admin > Zalo)' : 'no X-Bot-Api-Secret-Token header'}`);
}

function authorized(req, secret) {
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
  const cfg = await zaloConfig.get();
  if (!cfg.botToken || !cfg.botWebhookSecret) return res.status(503).json({ ok: false, error: 'zalo_bot_not_configured' });
  if (!authorized(req, cfg.botWebhookSecret)) { logRefusal(req, cfg.botWebhookSecret); return res.status(401).json({ ok: false, error: 'unauthorized' }); }

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
  logger.info(`Zalo event ${eventName || 'unknown'} ${chatType} ${isNew ? 'received' : 'duplicate'}`);
  if (!isNew) return undefined;

  if (eventName !== 'message.text.received' || !chatId || !senderId || msg.from?.is_bot || typeof msg.text !== 'string') {
    if (NON_TEXT.has(eventName) && chatType === 'user' && chatId && !msg.from?.is_bot) hintTextOnly(chatId);
    return eventModel.mark(key, 'ignored').catch(() => {});
  }
  const text = chatType === 'group' ? stripMention(msg.text) : msg.text.trim();
  if (!text) return eventModel.mark(key, 'ignored').catch(() => {});

  const mentioned = chatType === 'group' && /^\s*@\S/.test(msg.text);   // stripped above, but FAQ answers in groups need it
  const io = {
    reply: (t) => zaloBot.sendText(chatId, t),
    // sendPhoto takes a public URL (served by GET /api/zalo/qr/<signed token>.png)
    image: async ({ url, caption }) => {
      if (!url) throw new Error('PUBLIC_BASE_URL is not set: no public URL for the picture');
      await zaloBot.sendPhoto(chatId, url, caption);
    },
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
    .run(`${chatType}:${chatId}:${senderId}`, () => conversation.handleText({ chatType, chatId, userId: senderId, text, msgId: messageId || null, mentioned }, io))
    .then((action) => { logger.info(`Zalo event ${eventName} ${chatType} -> ${action}`); return eventModel.mark(key, action === 'ignored' ? 'ignored' : 'processed'); })
    .catch((err) => {
      logger.error(`Zalo bot event ${key} failed`, err);
      return eventModel.mark(key, 'failed', err.message).catch(() => {});
    });
}

// A customer who sends a photo, sticker or voice note gets one hint (at most every 10 minutes per chat): the bot reads text.
const NON_TEXT = new Set(['message.image.received', 'message.sticker.received', 'message.voice.received']);
const hinted = new Map();
const TEXT_ONLY_HINT = 'Mình là bot nên chưa xem được ảnh, sticker hay tin thoại 🙏 Nếu bạn vừa chuyển khoản, quán sẽ đối chiếu và xác nhận với bạn. Muốn đặt món, bạn nhắn chữ, ví dụ "2 cà phê sữa ít đường", hoặc nhắn "menu" nhé!';
function hintTextOnly(chatId) {
  const now = Date.now();
  if (now - (hinted.get(chatId) || 0) < 10 * 60 * 1000) return;
  if (hinted.size > 500) hinted.clear();
  hinted.set(chatId, now);
  zaloBot.sendText(chatId, TEXT_ONLY_HINT).catch((err) => logger.warn('Zalo text-only hint not delivered', err));
}

const ping = (_req, res) => res.status(200).json({ ok: true, mode: 'platform' });

module.exports = { handle, ping, authorized, stripMention };
