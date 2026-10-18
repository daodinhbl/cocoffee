const crypto = require('crypto');
const fs = require('fs');

/**
 * The licence format shared by the vendor tool (license-tool.js), the issuing page (license-server.js) and checked by the
 * Windows manager (desktop/lib/core/license.dart): base64url(payload JSON) + "." + base64url(Ed25519 signature of the first segment).
 */
const MACHINE_RE = /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/;
const FEATURES = ['pos', 'sync', 'zalo', 'tax'];
const b64u = (b) => Buffer.from(b).toString('base64url');

const publicHex = (publicKey) => publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const publicFromHex = (hex) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
const loadPrivate = (file) => crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));

class LicenseError extends Error {}

/** Validates the inputs and returns the payload to sign. */
function buildPayload({ machine, customer, days, features, now = new Date() }) {
  const m = String(machine || '').trim().toUpperCase();
  if (!MACHINE_RE.test(m)) throw new LicenseError('Mã máy không đúng dạng (8 nhóm 4 ký tự 0-9 A-F, ví dụ A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90).');
  const c = String(customer || '').trim();
  if (c.length < 2 || c.length > 80) throw new LicenseError('Tên khách hàng cần 2-80 ký tự.');
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 3660) throw new LicenseError('Số ngày phải từ 1 đến 3660.');
  const f = [...new Set((Array.isArray(features) ? features : String(features || 'pos').split(',')).map((s) => String(s).trim()).filter(Boolean))];
  if (!f.length || f.some((x) => !FEATURES.includes(x))) throw new LicenseError(`Tính năng không hợp lệ (cho phép: ${FEATURES.join(', ')}).`);
  return { v: 1, customer: c, machine: m, issued: now.toISOString(), expires: new Date(now.getTime() + d * 86400000).toISOString(), features: f };
}

function sign(payload, privateKey) {
  const seg = b64u(JSON.stringify(payload));
  return `${seg}.${b64u(crypto.sign(null, Buffer.from(seg), privateKey))}`;
}

function decode(code) {
  const [seg, sig, extra] = String(code || '').trim().split('.');
  if (!seg || !sig || extra !== undefined) throw new LicenseError('Không phải mã kích hoạt.');
  try { return { seg, sig, payload: JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) }; } catch (_) { throw new LicenseError('Không đọc được mã kích hoạt.'); }
}

function verify(code, pubHex) {
  const { seg, sig, payload } = decode(code);
  return { ok: crypto.verify(null, Buffer.from(seg), publicFromHex(pubHex), Buffer.from(sig, 'base64url')), payload };
}

module.exports = { MACHINE_RE, FEATURES, buildPayload, sign, decode, verify, publicHex, publicFromHex, loadPrivate, LicenseError };
