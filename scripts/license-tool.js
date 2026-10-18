#!/usr/bin/env node
/**
 * Vendor tool for the Windows installer's licences (the machine binding). Run it on YOUR PC; the private key never ships.
 *
 *   node scripts/license-tool.js keygen [--dir D:\FNB-secrets]        make the Ed25519 key pair (once); prints the PUBLIC key to put in
 *                                                                      desktop/lib/core/license.dart (kLicensePublicKeyHex)
 *   node scripts/license-tool.js issue --machine XXXX-XXXX-... --customer "Quán A" --days 365 [--features pos,sync] [--key <private.pem>]
 *                                                                      prints the activation code to send to the customer
 *   node scripts/license-tool.js show <code>                           decodes a code (no key needed)
 *   node scripts/license-tool.js verify <code> [--pub <hex>]           checks the signature
 *
 * The code is  base64url(payload JSON) + "." + base64url(Ed25519 signature of the payload segment's bytes).
 * Payload: { v:1, customer, machine, issued (ISO), expires (ISO), features: [..] }. The customer's machine id is shown in the manager's
 * "Giấy phép" tab. Changing PC / disk = a new code for the new id (the old one stops working there).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const b64u = (b) => Buffer.from(b).toString('base64url');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const DEFAULT_DIR = 'D:\\FNB-secrets';
const keyFile = () => arg('key', path.join(arg('dir', DEFAULT_DIR), 'license-private.pem'));

function publicHex(publicKey) { return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'); }
function publicFromHex(hex) {
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function keygen() {
  const dir = arg('dir', DEFAULT_DIR);
  const file = path.join(dir, 'license-private.pem');
  if (fs.existsSync(file)) throw new Error(`${file} already exists: refusing to overwrite the private key.`);
  fs.mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`Private key written to ${file}. BACK IT UP somewhere safe and never commit it.`);
  console.log(`Public key (hex): ${publicHex(publicKey)}`);
}

function issue() {
  const machine = String(arg('machine', '')).trim().toUpperCase();
  if (!/^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/.test(machine)) throw new Error('--machine must be the id shown in the manager (8 groups of 4 hex characters).');
  const customer = String(arg('customer', '')).trim();
  if (!customer) throw new Error('--customer is required.');
  const days = Number(arg('days', '365'));
  if (!(days >= 1 && days <= 3660)) throw new Error('--days must be between 1 and 3660.');
  const now = new Date();
  const payload = {
    v: 1, customer, machine, issued: now.toISOString(),
    expires: new Date(now.getTime() + days * 86400000).toISOString(),
    features: String(arg('features', 'pos')).split(',').map((s) => s.trim()).filter(Boolean),
  };
  const priv = crypto.createPrivateKey(fs.readFileSync(keyFile(), 'utf8'));
  const seg = b64u(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(seg), priv);
  console.log(`${seg}.${b64u(sig)}`);
  console.error(`Issued to "${customer}" for machine ${machine}, valid until ${payload.expires.slice(0, 10)}.`);
}

function decode(code) {
  const [seg, sig] = String(code || '').trim().split('.');
  if (!seg || !sig) throw new Error('Not a licence code.');
  return { seg, sig, payload: JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) };
}

function show() { console.log(JSON.stringify(decode(process.argv[3]).payload, null, 2)); }

function verify() {
  const { seg, sig, payload } = decode(process.argv[3]);
  const hex = arg('pub', null) || publicHex(crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(keyFile(), 'utf8'))));
  const ok = crypto.verify(null, Buffer.from(seg), publicFromHex(hex), Buffer.from(sig, 'base64url'));
  console.log(ok ? `VALID: ${payload.customer}, machine ${payload.machine}, until ${payload.expires.slice(0, 10)}` : 'INVALID signature');
  process.exitCode = ok ? 0 : 1;
}

try {
  const cmd = process.argv[2];
  if (cmd === 'keygen') keygen();
  else if (cmd === 'issue') issue();
  else if (cmd === 'show') show();
  else if (cmd === 'verify') verify();
  else console.log('usage: node scripts/license-tool.js keygen|issue|show|verify (see the header of the file)');
} catch (e) { console.error(e.message); process.exitCode = 1; }

module.exports = { publicFromHex, publicHex };
