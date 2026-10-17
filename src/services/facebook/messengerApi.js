const crypto = require('crypto');
const axios = require('axios');
const env = require('../../config/env');
const { AppError } = require('../../utils/httpError');

const MAX_TEXT = 2000;          // Messenger limit for message.text
const MAX_QUICK_REPLIES = 13;

const enabled = () => Boolean(env.facebook.pageAccessToken && env.facebook.appSecret);

/** True when `signature` ("sha256=<hex>") is HMAC-SHA256 of the untouched body under the app secret. */
function verifySignature(rawBody, signature) {
  if (!env.facebook.appSecret || typeof rawBody !== 'string' || typeof signature !== 'string') return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', env.facebook.appSecret).update(rawBody, 'utf8').digest('hex')}`);
  const got = Buffer.from(signature);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/**
 * Text reply to one person (PSID) who messaged the page within the last 24 h.
 * @param {string} psid
 * @param {string} text
 * @param {{ title: string, payload: string }[]} [quickReplies] tap-to-answer buttons under the message (title <= 20 chars)
 */
async function sendText(psid, text, quickReplies = []) {
  const message = { text: clip(text) };
  if (quickReplies.length) {
    message.quick_replies = quickReplies.slice(0, MAX_QUICK_REPLIES).map((q) => ({
      content_type: 'text', title: q.title.slice(0, 20), payload: q.payload,
    }));
  }
  const res = await axios.post(
    `https://graph.facebook.com/${env.facebook.graphVersion}/me/messages`,
    { recipient: { id: psid }, messaging_type: 'RESPONSE', message },
    { headers: { Authorization: `Bearer ${env.facebook.pageAccessToken}` }, timeout: 10000, validateStatus: () => true }
  );
  if (res.status >= 300) {
    const e = res.data?.error || {};
    throw new AppError(502, 'FACEBOOK_SEND_FAILED', `Facebook send failed (${e.code ?? res.status}): ${e.message || 'unknown'}`);
  }
  return res.data;
}

module.exports = { enabled, verifySignature, sendText };
