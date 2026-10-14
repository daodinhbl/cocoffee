const crypto = require('crypto');
const env = require('../../config/env');
const vietQr = require('../vietQr');
const chatbotInfo = require('./chatbotInfo');

/**
 * The VietQR picture sent with a "check nợ" answer.
 * Zalo's sendPhoto (Bot Platform) and the OA media message take a public image URL, so the picture is served
 * at GET /api/zalo/qr/<token>.png. The token carries only { customer id, amount, expiry } and an HMAC, so a
 * URL cannot be guessed or edited into another amount; the image itself is rebuilt from the bank settings.
 * The Bot Client gets the same PNG inline (base64), it never has to fetch the URL.
 */
const TTL_MS = 7 * 24 * 3600 * 1000;
const KEY = crypto.createHmac('sha256', env.jwt.secret).update('cocoffee-fnb:debt-qr:v1').digest();
const mac = (body) => crypto.createHmac('sha256', KEY).update(body).digest('base64url').slice(0, 22);

/** Transfer content that lets the shop match the payment to the customer: "NO KH5". */
const transferNote = (customerId) => `NO KH${customerId}`;

function sign({ customerId, amount }, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ c: customerId, a: Math.round(amount), e: now + TTL_MS })).toString('base64url');
  return `${body}.${mac(body)}`;
}

/** @returns {{customerId:number, amount:number}|null} */
function verify(token, now = Date.now()) {
  const m = /^([A-Za-z0-9_-]{10,200})\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  if (!m) return null;
  const expected = Buffer.from(mac(m[1]));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!Number.isInteger(data.c) || !Number.isInteger(data.a) || data.a <= 0 || !(data.e > now)) return null;
  return { customerId: data.c, amount: data.a };
}

/** PNG for a customer's debt, or null when the shop has no bank account set. */
async function png({ customerId, amount }, info) {
  const settings = info || (await chatbotInfo.get());
  if (!chatbotInfo.bankReady(settings)) return null;
  return vietQr.png(vietQr.payload({ bin: settings.bankBin, account: settings.bankAccount, amount, note: transferNote(customerId) }));
}

/**
 * Everything a channel needs to send the picture: a public URL (when PUBLIC_BASE_URL is set) and the PNG
 * itself. null when no bank account is configured.
 */
async function image({ customerId, amount }, info) {
  const buf = await png({ customerId, amount }, info);
  if (!buf) return null;
  const url = env.publicBaseUrl ? `${env.publicBaseUrl}/api/zalo/qr/${sign({ customerId, amount })}.png` : null;
  return { url, base64: buf.toString('base64'), mime: 'image/png' };
}

module.exports = { sign, verify, png, image, transferNote, TTL_MS };
