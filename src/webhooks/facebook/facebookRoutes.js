const express = require('express');
const rateLimit = require('../../middlewares/rateLimit');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const messenger = require('../../services/facebook/messengerApi');
const consultBot = require('../../services/facebook/consultBot');
const leadModel = require('../../models/leadModel');
const appRelease = require('../../services/appRelease');
const ownerNotice = require('../../services/zalo/ownerNotice');

/**
 * Facebook Messenger consultation bot. Mounted at /api/facebook:
 *   GET  /api/facebook/webhook   one-time verification handshake (hub.verify_token must equal FB_VERIFY_TOKEN)
 *   POST /api/facebook/webhook   events from the page; the body is signed (X-Hub-Signature-256) with the app secret
 * Facebook retries a webhook that does not answer 200 quickly, so the answer is sent first and the work happens after.
 */
const router = express.Router();

router.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && env.facebook.verifyToken && token === env.facebook.verifyToken && challenge) {
    return res.status(200).type('text/plain').send(String(challenge));
  }
  return res.sendStatus(403);
});

router.post('/webhook', rateLimit({ windowMs: 60 * 1000, max: 300 }), (req, res) => {
  if (!messenger.enabled() || !messenger.verifySignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(403);
  res.sendStatus(200);
  const base = appRelease.baseUrl(req);
  handle(req.body, base).catch((err) => logger.error('Facebook webhook handling failed', err));
});

/** Everything people sent in one delivery; one failing message never stops the others. */
async function handle(body, base) {
  if (body?.object !== 'page') return;
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      try { await handleEvent(ev, base); } catch (err) { logger.warn('Facebook message failed', err); }
    }
  }
}

async function handleEvent(ev, base) {
  const psid = ev?.sender?.id;
  if (!psid || ev.message?.is_echo) return;                       // our own messages come back as echoes
  const text = ev.message?.text ?? ev.postback?.title ?? '';
  const payload = ev.message?.quick_reply?.payload ?? ev.postback?.payload ?? '';
  if (!text && !payload) return;                                  // stickers, images: nothing to answer

  const answer = consultBot.reply(text, { payload, base });
  if (answer.phone) await saveLead(answer.phone, psid, text);
  if (answer.wantsHuman) ownerNotice.notifyOwner(`💬 Khách Facebook muốn gặp nhân viên (mở Inbox Fanpage để trả lời).\nTin nhắn: ${String(text).slice(0, 200)}`).catch(() => {});
  await messenger.sendText(psid, answer.text, answer.quickReplies);
}

async function saveLead(phone, psid, text) {
  if (await leadModel.recentByPhone(phone)) return;
  await leadModel.create({ name: 'Khách Messenger', phone, need: 'Tư vấn qua Facebook', source: 'facebook', note: `PSID ${psid}: ${String(text).slice(0, 400)}` });
  ownerNotice.notifyOwner(`🔧 Khách mới từ Facebook Messenger\nSĐT: ${phone}\nTin nhắn: ${String(text).slice(0, 300)}`).catch(() => {});
}

module.exports = router;
module.exports.processBody = handle;
