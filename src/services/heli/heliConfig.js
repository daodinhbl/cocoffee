const env = require('../../config/env');
const settingsModel = require('../../models/settingsModel');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/httpError');

/**
 * The ChatGPT (OpenAI) key and model of the Heli voice assistant, entered in Web Admin / app > Cài đặt > "Trợ lý Heli".
 * Saved in app_settings ("heli.apiKey", "heli.model"); a saved value wins over OPENAI_API_KEY / OPENAI_MODEL so the owner can
 * change it without the hosting panel, and clearing it falls back to the environment. The key is never sent back to a browser or
 * the app: only whether one is set, where it comes from and its last 4 characters. A running site picks a change made on another
 * worker up within a minute (env.heli reads the overrides below).
 */
const KEY_API = 'heli.apiKey';
const KEY_MODEL = 'heli.model';
const MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];
const BASE = 'https://api.openai.com/v1';

const hint = (v) => (v ? `…${String(v).slice(-4)}` : '');

async function load() {
  try {
    const s = await settingsModel.getByPrefix('heli.');
    env.heliOverride.apiKey = s[KEY_API] || '';
    env.heliOverride.model = s[KEY_MODEL] || '';
  } catch (err) {
    logger.warn('Heli settings unreadable, keeping the current ones', err);
  }
}

function startRefresh() {
  setInterval(() => load().catch(() => {}), 60 * 1000).unref();
}

/** What the screens show: never the key itself. */
function view() {
  const saved = env.heliOverride.apiKey;
  const fromEnv = env.heliEnv.apiKey;
  return {
    enabled: Boolean(env.heli.apiKey),
    source: saved ? 'settings' : (fromEnv ? 'env' : ''),
    hint: hint(env.heli.apiKey),
    model: env.heli.model,
    envModel: env.heliEnv.model,
    models: MODELS,
    sttModel: env.heli.sttModel,
    ttsModel: env.heli.ttsModel,
  };
}

function checkKey(k) {
  if (!/^sk-[A-Za-z0-9_\-]{16,300}$/.test(k)) throw new AppError(400, 'VALIDATION', 'Khóa API không đúng dạng (bắt đầu bằng sk-, không có khoảng trắng). Lấy khóa tại platform.openai.com/api-keys.');
}

function checkModel(m) {
  if (!/^[A-Za-z0-9._:-]{2,60}$/.test(m)) throw new AppError(400, 'VALIDATION', 'Tên mô hình không hợp lệ.');
}

/**
 * @param {{ apiKey?: string, model?: string, clear?: boolean }} input
 *   apiKey blank = keep the stored key; clear = remove the stored key (back to the environment). model blank = back to the default.
 */
async function save(input, userId) {
  const values = {};
  if (input.clear) {
    values[KEY_API] = '';
  } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    const k = input.apiKey.trim();
    checkKey(k);
    values[KEY_API] = k;
  }
  if (input.model !== undefined) {
    const m = String(input.model || '').trim();
    if (m) checkModel(m);
    values[KEY_MODEL] = m;
  }
  if (!Object.keys(values).length) throw new AppError(400, 'VALIDATION', 'Chưa nhập gì để lưu.');
  await settingsModel.setMany(values, userId || null);
  if (KEY_API in values) env.heliOverride.apiKey = values[KEY_API];
  if (KEY_MODEL in values) env.heliOverride.model = values[KEY_MODEL];
  return view();
}

/** Asks OpenAI whether the key in force (or a candidate) is accepted. Never logs or returns the key. */
async function test(candidate) {
  const k = (candidate && candidate.trim()) || env.heli.apiKey;
  if (!k) throw new AppError(400, 'VALIDATION', 'Chưa có khóa API để kiểm tra.');
  if (candidate && candidate.trim()) checkKey(k);
  let res;
  try {
    res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15000) });
  } catch (_) {
    throw new AppError(502, 'HELI_UPSTREAM', 'Không kết nối được OpenAI. Kiểm tra mạng của máy chủ.');
  }
  if (res.status === 401) throw new AppError(400, 'HELI_BAD_KEY', 'OpenAI từ chối khóa này (sai hoặc đã bị thu hồi).');
  if (res.status === 429) throw new AppError(400, 'HELI_QUOTA', 'Khóa hợp lệ nhưng tài khoản OpenAI hết hạn mức hoặc bị giới hạn tốc độ.');
  if (!res.ok) throw new AppError(502, 'HELI_UPSTREAM', `OpenAI trả lỗi ${res.status}.`);
  return { ok: true, hint: hint(k) };
}

module.exports = { load, startRefresh, view, save, test, MODELS, KEY_API, KEY_MODEL };
