const axios = require('axios');
const env = require('../../config/env');
const auth = require('./zaloAuthService');
const { AppError } = require('../../utils/httpError');

const MAX_TEXT = 2000;           // Zalo limit for message.text
const INVALID_TOKEN = -216;      // "access_token is invalid / expired"

// target = { chatType: 'user' | 'group', chatId }
const ENDPOINT = {
  user: '/v3.0/oa/message/cs',        // consultation message to one user (needs interaction within 7 days)
  group: '/v3.0/oa/group/message',    // GMF group message (OA must hold the group_id)
};

function buildBody(target, message) {
  const recipient = target.chatType === 'group' ? { group_id: target.chatId } : { user_id: target.chatId };
  return { recipient, message };
}

async function post(target, message, retry = true) {
  const token = await auth.getAccessToken();
  const res = await axios.post(`${env.zalo.apiBase}${ENDPOINT[target.chatType]}`, buildBody(target, message), {
    headers: { access_token: token, 'Content-Type': 'application/json' },
    timeout: 10000,
    validateStatus: () => true,
  });
  const d = res.data || {};
  if (d.error === INVALID_TOKEN && retry) {
    await auth.forceRefresh(token);
    return post(target, message, false);
  }
  if (d.error !== 0) {
    throw new AppError(502, 'ZALO_SEND_FAILED', `Zalo send failed (${d.error}): ${d.message || res.status}`, d);
  }
  return d.data;
}

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

/** Plain text message. */
function sendText(target, text) {
  return post(target, { text: clip(text) });
}

/** Image (public jpg/png URL, <= 1MB) with the receipt text as its caption. */
function sendImageWithText(target, text, imageUrl) {
  return post(target, {
    text: clip(text),
    attachment: {
      type: 'template',
      payload: { template_type: 'media', elements: [{ media_type: 'image', url: imageUrl }] },
    },
  });
}

module.exports = { sendText, sendImageWithText };
