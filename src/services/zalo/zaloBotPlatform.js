const axios = require('axios');
const zaloConfig = require('./zaloConfig');

/**
 * Zalo Bot Platform (official bot API, https://bot.zapps.me/docs).
 *   https://bot-api.zaloplatforms.com/bot<BOT_TOKEN>/<method>   - JSON in, { ok, result | description, error_code } out
 * The token is part of the URL, so it must never reach a log: errors are rethrown with the method name only.
 */
// ZALO_BOT_API_BASE only for local end-to-end tests against a stub; production always talks to Zalo.
const API = process.env.ZALO_BOT_API_BASE || 'https://bot-api.zaloplatforms.com';
const MAX_TEXT = 2000;

class ZaloBotError extends Error {
  constructor(method, description, code, status) {
    super(`Zalo Bot ${method} failed: ${description || 'unknown error'}${code ? ` (${code})` : ''}`);
    this.code = 'ZALO_BOT_API';
    this.apiCode = code;
    this.httpStatus = status;
  }
}

/** `token` overrides the configured one (used to check a token before saving it). */
async function call(method, params = {}, token = null) {
  const botToken = token || (await zaloConfig.get()).botToken;
  if (!botToken) throw new ZaloBotError(method, 'chưa có Bot Token');
  let res;
  try {
    res = await axios.post(`${API}/bot${botToken}/${method}`, params, { timeout: 15000, validateStatus: () => true });
  } catch (err) {
    throw new ZaloBotError(method, err.code || 'network error');        // no err.config: it holds the token URL
  }
  const body = res.data || {};
  if (res.status >= 400 || body.ok === false) throw new ZaloBotError(method, body.description || `HTTP ${res.status}`, body.error_code, res.status);
  return body.result;
}

/** Split on line breaks so a long menu or bill stays readable across messages (2000 chars per message). */
function chunks(text) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    const piece = line.length > MAX_TEXT ? line.slice(0, MAX_TEXT) : line;
    if ((cur ? cur.length + 1 : 0) + piece.length > MAX_TEXT) { out.push(cur); cur = piece; } else cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

async function sendText(chatId, text) {
  for (const part of chunks(text)) await call('sendMessage', { chat_id: String(chatId), text: part });
}

/** Picture by public URL (https://bot.zapps.me/docs/apis/sendPhoto/); caption 1-2000 characters. */
async function sendPhoto(chatId, photoUrl, caption) {
  const params = { chat_id: String(chatId), photo: String(photoUrl) };
  if (caption) params.caption = String(caption).slice(0, MAX_TEXT);
  return call('sendPhoto', params);
}

const getMe = (token = null) => call('getMe', {}, token);
const setWebhook = (url, secretToken) => call('setWebhook', { url, secret_token: secretToken });
const getWebhookInfo = () => call('getWebhookInfo');

module.exports = { call, sendText, sendPhoto, getMe, setWebhook, getWebhookInfo, chunks, ZaloBotError };
