const env = require('../../config/env');
const { AppError } = require('../../utils/httpError');
const logger = require('../../utils/logger');

const BASE = 'https://api.openai.com/v1';

function key() {
  if (!env.heli.apiKey) throw new AppError(503, 'HELI_DISABLED', 'Heli chưa được bật trên máy chủ');
  return env.heli.apiKey;
}

/** One call to OpenAI. Logs the status only, never the request body (it holds the shop's questions) or the key. */
async function call(path, init) {
  const auth = `Bearer ${key()}`;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers: { ...init.headers, Authorization: auth }, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    logger.error(`Heli: OpenAI ${path} unreachable (${e.name})`);
    throw new AppError(502, 'HELI_UPSTREAM', 'Heli tạm thời không phản hồi');
  }
  if (!res.ok) {
    logger.error(`Heli: OpenAI ${path} answered ${res.status}`);
    throw new AppError(502, 'HELI_UPSTREAM', 'Heli tạm thời không phản hồi');
  }
  return res;
}

/** Chat completion with optional tools -> the assistant message. */
async function chat(messages, tools) {
  const body = { model: env.heli.model, max_tokens: 1024, messages };
  if (tools && tools.length) body.tools = tools;
  const res = await call('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  return json.choices[0].message;
}

/** Audio bytes -> Vietnamese text. */
async function transcribe(buffer, ext) {
  const form = new FormData();
  form.append('model', env.heli.sttModel);
  form.append('language', 'vi');
  form.append('file', new Blob([buffer]), `speech.${ext}`);
  const res = await call('/audio/transcriptions', { method: 'POST', headers: {}, body: form });
  const json = await res.json();
  return String(json.text || '').trim();
}

/** Text -> mp3 bytes. */
async function speak(text) {
  const res = await call('/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.heli.ttsModel, voice: env.heli.ttsVoice, input: text, response_format: 'mp3' }),
  });
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { chat, transcribe, speak };
