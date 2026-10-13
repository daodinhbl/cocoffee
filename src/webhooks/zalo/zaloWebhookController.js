const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const keyedQueue = require('../../utils/keyedQueue');
const { eventModel } = require('../../models/zaloModel');
const { verifySignature } = require('../../services/zalo/zaloSignature');
const conversation = require('./zaloConversationService');

// Text events we act on. Everything else (oa_send_*, follows, images, ...) is logged as 'ignored';
// ignoring oa_send_group_text also prevents the bot from reacting to its own group messages.
const TEXT_EVENTS = { user_send_text: 'user', user_send_group_text: 'group' };

const eventKey = (event, rawBody) => {
  const msgId = event.message?.msg_id || event.message?.message_id;
  return msgId
    ? `${event.event_name}:${msgId}`.slice(0, 100)
    : crypto.createHash('sha256').update(rawBody).digest('hex');
};

/**
 * POST /api/zalo/webhook
 * Zalo requires HTTP 200 within 2 seconds, so: verify -> record (idempotent) -> ACK -> process async.
 * Retries (+30s, 5m, 15m, 30m, 1h; header `num_retry`) carry the same msg_id and are dropped by the
 * UNIQUE event_key in zalo_events.
 */
async function handle(req, res) {
  const event = req.body;
  if (!event || typeof event !== 'object' || !event.event_name) return res.status(200).json({ ok: true }); // pings

  if (!env.zalo.appId || !env.zalo.oaSecretKey) return res.status(503).json({ error: 'zalo_not_configured' });
  if (String(event.app_id) !== env.zalo.appId) return res.status(401).json({ error: 'wrong_app' });

  if (env.zalo.verifySignature) {
    const ok = verifySignature({
      appId: env.zalo.appId,
      rawBody: req.rawBody,
      timestamp: event.timestamp,
      oaSecretKey: env.zalo.oaSecretKey,
      header: req.get('X-ZEvent-Signature'),
    });
    if (!ok) return res.status(401).json({ error: 'invalid_signature' });
  }

  const chatType = TEXT_EVENTS[event.event_name];
  const senderId = event.sender?.id ? String(event.sender.id) : null;
  const chatId = chatType === 'group' ? event.recipient?.id : senderId; // group events: recipient = group id
  const key = eventKey(event, req.rawBody);

  let isNew;
  try {
    isNew = await eventModel.insertIfNew({
      key, eventName: event.event_name, chatId, senderId, payload: event, numRetry: Number(req.get('num_retry')) || 0,
    });
  } catch (err) {
    logger.error('zalo_events insert failed', err);
    return res.status(500).json({ error: 'storage_unavailable' });
  }

  res.status(200).json({ ok: true });          // ACK first (< 2s), work happens below
  if (!isNew) return undefined;                // duplicate / retry

  if (!chatType || !chatId || !senderId || typeof event.message?.text !== 'string') {
    return eventModel.mark(key, 'ignored').catch(() => {});
  }

  // Serialize per chat so "2 ca phe" and an immediate "ok" are processed in order.
  return keyedQueue
    .run(`${chatType}:${chatId}:${senderId}`, () => conversation.handleText({
      chatType, chatId: String(chatId), userId: senderId, text: event.message.text, msgId: event.message.msg_id,
    }))
    .then(() => eventModel.mark(key, 'processed'))
    .catch((err) => {
      logger.error(`Zalo event ${key} failed`, err);
      return eventModel.mark(key, 'failed', err.message).catch(() => {});
    });
}

/** GET /api/zalo/webhook - liveness probe for Zalo's URL check / manual curl. */
const ping = (_req, res) => res.status(200).send('ok');

module.exports = { handle, ping };
