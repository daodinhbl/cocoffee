const crypto = require('crypto');
const env = require('../config/env');
const settingsModel = require('../models/settingsModel');
const licenseCore = require('../../scripts/license-core');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');

/**
 * ngrok broker: gives a shop with a valid licence its own public domain WITHOUT the shop having an ngrok account, using the
 * VENDOR's ngrok account. The vendor's API key stays here, in the environment variable NGROK_API_KEY (never in a database, a log or
 * the installer). For each licensed machine the broker
 *   1. checks the activation code (Ed25519 signature of the vendor, same machine id, not expired),
 *   2. reserves a domain  <shop-slug>-<random>.<NGROK_DOMAIN_SUFFIX>  on the vendor's account,
 *   3. makes a tunnel credential (authtoken) whose ACL is only "bind:<that domain>", so the shop's token cannot open any other
 *      address nor manage the account,
 * and remembers the answer in app_settings ("ngrok.claim.<machine>") so asking again returns the same domain and token.
 * Needs a paid ngrok plan (many domains) and NGROK_API_KEY set in hPanel; without the key the endpoint answers 503.
 */
const API = 'https://api.ngrok.com';
const PREFIX = 'ngrok.claim.';
const suffix = () => (process.env.NGROK_DOMAIN_SUFFIX || 'ngrok.app').replace(/^\.+/, '');
const apiKey = () => process.env.NGROK_API_KEY || '';
const publicKeyHex = () => process.env.LICENSE_PUBLIC_KEY || '31c141ea52b315af09d337bfb19d817f98bff5c9b6d07032188ccd63eb78d9ff';

let http = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey()}`, 'Ngrok-Version': '2', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let json = null;
  try { json = await r.json(); } catch (_) { /* no body */ }
  return { status: r.status, json };
};
/** Tests plug in a fake. */
const setHttp = (f) => { http = f; };

const slugOf = (name) => String(name || 'pos').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'pos';

function checkLicence(machine, code, now) {
  if (!licenseCore.MACHINE_RE.test(String(machine || ''))) throw new AppError(400, 'VALIDATION', 'Mã máy không hợp lệ.');
  let r;
  try { r = licenseCore.verify(code, publicKeyHex()); } catch (_) { throw new AppError(403, 'BAD_LICENCE', 'Mã kích hoạt không hợp lệ.'); }
  if (!r.ok || r.payload.machine !== machine) throw new AppError(403, 'BAD_LICENCE', 'Mã kích hoạt không hợp lệ cho máy này.');
  if (!(new Date(r.payload.expires) > now)) throw new AppError(403, 'LICENCE_EXPIRED', 'Mã kích hoạt đã hết hạn.');
  return r.payload;
}

const readClaim = async (machine) => {
  const key = `${PREFIX}${machine}`;
  const v = (await settingsModel.getByPrefix(key))[key];
  try { return v ? JSON.parse(v) : null; } catch (_) { return null; }
};

/**
 * @param {{ machine: string, code: string, shopName?: string, now?: Date }} input
 * @returns {Promise<{ domain: string, authtoken: string, reused: boolean }>}
 */
async function claim({ machine, code, shopName, now = new Date() }) {
  if (!apiKey()) throw new AppError(503, 'NOT_CONFIGURED', 'Máy chủ cấp tên miền chưa được bật.');
  const payload = checkLicence(machine, code, now);
  const existing = await readClaim(machine);
  if (existing && existing.domain && existing.authtoken) return { domain: existing.domain, authtoken: existing.authtoken, reused: true };

  const base = slugOf(shopName || payload.customer);
  let domain = null;
  for (let i = 0; i < 4 && !domain; i++) {
    const candidate = `${base}-${crypto.randomBytes(2).toString('hex')}.${suffix()}`;
    const r = await http('POST', '/reserved_domains', { domain: candidate, description: `POS ${payload.customer} ${machine}`.slice(0, 250) });
    if (r.status >= 200 && r.status < 300) domain = (r.json && r.json.domain) || candidate;
    else if (r.status === 401 || r.status === 403) throw new AppError(502, 'NGROK_DENIED', 'ngrok từ chối khóa API của máy chủ cấp tên miền.');
    else if (r.status === 429) throw new AppError(503, 'NGROK_BUSY', 'ngrok đang giới hạn tốc độ, thử lại sau vài phút.');
    else if (r.status !== 400 && r.status !== 409) throw new AppError(502, 'NGROK_ERROR', `ngrok trả lỗi ${r.status} khi tạo tên miền.`);
  }
  if (!domain) throw new AppError(502, 'NGROK_ERROR', 'Không tạo được tên miền, thử lại sau.');

  const c = await http('POST', '/credentials', { description: `POS ${payload.customer} ${machine}`.slice(0, 250), acl: [`bind:${domain}`] });
  if (!(c.status >= 200 && c.status < 300) || !c.json || !c.json.token) {
    logger.error(`ngrok credential for ${domain} failed: HTTP ${c.status}`);
    throw new AppError(502, 'NGROK_ERROR', 'Không tạo được mã tunnel cho tên miền.');
  }
  await settingsModel.setMany({ [`${PREFIX}${machine}`]: JSON.stringify({ domain, authtoken: c.json.token, credentialId: c.json.id || null, at: now.toISOString() }) }, null);
  logger.info(`ngrok domain ${domain} issued to machine ${machine.slice(0, 9)}…`);
  return { domain, authtoken: c.json.token, reused: false };
}

module.exports = { claim, setHttp, slugOf, checkLicence };
