const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const orderModel = require('../../models/orderModel');
const customerModel = require('../../models/customerModel');
const printerSettings = require('../printerSettings');
const receiptImage = require('../receiptImage');
const vietQr = require('../vietQr');
const chatbotInfo = require('./chatbotInfo');
const statementService = require('./statementService');
const { parseDay } = require('../../utils/shopTime');

/**
 * Pictures the chatbot sends after a customer confirms an order:
 *   - receipt: the 80 mm PNG bill (services/receiptImage.js);
 *   - payQr:   the VietQR code of the shop's bank account (Admin > Zalo > "Trả lời tự động & chuyển khoản") for the
 *              amount of that order, with the order code as transfer content.
 * Channels that can only send a public URL (Zalo Bot Platform sendPhoto, OA media) get
 *   GET /api/zalo/receipt/<token>.png  and  GET /api/zalo/pay-qr/<token>.png
 * The token carries only { kind, order id, expiry } and an HMAC; the picture is rebuilt from the database on each
 * request, so a link cannot be edited into another order or amount. The Bot Client gets the PNG inline (base64).
 */
const TTL_MS = 7 * 24 * 3600 * 1000;
const KEY = crypto.createHmac('sha256', env.jwt.secret).update('cocoffee-fnb:bill-media:v1').digest();
const mac = (body) => crypto.createHmac('sha256', KEY).update(body).digest('base64url').slice(0, 22);
const KINDS = { receipt: 'r', payQr: 'q', statement: 's', reconciliation: 'c' };
// Debt tables carry customers' balances: their links live one day, not a week (Zalo fetches the picture at once).
const STATEMENT_TTL_MS = 24 * 3600 * 1000;

function signData(kind, data, ttl, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ k: KINDS[kind], ...data, e: now + ttl })).toString('base64url');
  return `${body}.${mac(body)}`;
}

function sign(kind, orderId, now = Date.now()) {
  return signData(kind, { o: orderId }, TTL_MS, now);
}

/** @returns {{kind:'receipt'|'payQr', orderId:number}|{kind:'statement', customerId:number, from:string, to:string}|{kind:'reconciliation', from:string, to:string}|null} */
function verify(token, now = Date.now()) {
  const m = /^([A-Za-z0-9_-]{10,200})\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  if (!m) return null;
  const expected = Buffer.from(mac(m[1]));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return null; }
  const kind = Object.keys(KINDS).find((k) => KINDS[k] === data.k);
  if (!kind || !(data.e > now)) return null;
  if (kind === 'statement') {
    const from = parseDay(data.f);
    const to = parseDay(data.t);
    return Number.isInteger(data.c) && data.c > 0 && from && to ? { kind, customerId: data.c, from, to } : null;
  }
  if (kind === 'reconciliation') {
    const from = parseDay(data.f);
    const to = parseDay(data.t);
    return from && to ? { kind, from, to } : null;
  }
  if (!Number.isInteger(data.o) || data.o <= 0) return null;
  return { kind, orderId: data.o };
}

/** Transfer content for an order: "CF261013 00042" (banks keep letters, digits and spaces). */
const transferNote = (order) => vietQr.cleanNote(order.order_code);

async function loadOrder(orderId) {
  const order = await orderModel.getById(orderId);
  if (!order) return null;
  return { order, items: await orderModel.getItems(orderId) };
}

/** PNG bytes of the 80 mm receipt, or null. */
async function receiptPng(orderId) {
  const data = await loadOrder(orderId);
  if (!data) return null;
  return receiptImage.render({ ...data, printer: await printerSettings.get() });
}

/** PNG bytes of the payment QR for the order's amount, or null when no bank account is configured. */
async function payQrPng(orderId, info) {
  const order = await orderModel.getById(orderId);
  if (!order || order.payment_status === 'paid' || Number(order.total) <= 0) return null;
  const settings = info || (await chatbotInfo.get());
  if (!chatbotInfo.bankReady(settings)) return null;
  return vietQr.png(vietQr.payload({ bin: settings.bankBin, account: settings.bankAccount, amount: Math.round(Number(order.total)), note: transferNote(order) }));
}

/** PNG for a verified link token. */
async function pngFor(t) {
  if (t.kind === 'statement') return statementService.customerPng(t);
  if (t.kind === 'reconciliation') return statementService.allPng(t);
  return t.kind === 'receipt' ? receiptPng(t.orderId) : payQrPng(t.orderId);
}

const urlFor = (kind, route, orderId) => (env.publicBaseUrl ? `${env.publicBaseUrl}/api/zalo/${route}/${sign(kind, orderId)}.png` : null);

async function picture(kind, route, orderId, bytes) {
  const buf = await bytes;
  if (!buf) return null;
  return { url: urlFor(kind, route, orderId), base64: buf.toString('base64'), mime: 'image/png' };
}

/**
 * Copy of every receipt the bot sends, kept under public/uploads/receipts/ (RECEIPT_SAVE_DIR to move it) as
 *   <khách hàng>/<yyyy>/<mm>/<dd>/<order code>-<hash>.png        (date of the order in shop time, UTC+7)
 * <khách hàng> is KH<id>-<name without accents> for a customer linked to the Zalo account, zalo-<zalo id> for an
 * unlinked Zalo account and khach-le otherwise. The file name ends in a keyed hash of the order: the same order
 * overwrites its copy and the name cannot be guessed from the order code (the directory is served as static files).
 * A deploy replaces public/, so the copies are not permanent. Never throws.
 */
const SAVE_DIR = path.resolve(env.rootDir, process.env.RECEIPT_SAVE_DIR || 'public/uploads/receipts');
const slug = (text, max = 40) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, max);

async function customerDir(order) {
  try {
    const customer = order.customer_id ? await customerModel.getById(order.customer_id) : (order.zalo_user_id ? await customerModel.findByZaloUser(order.zalo_user_id) : null);
    if (customer) return `KH${customer.id}${slug(customer.name) ? `-${slug(customer.name)}` : ''}`;
  } catch (err) {
    logger.warn('Receipt copy: customer lookup failed', err);
  }
  return order.zalo_user_id && slug(order.zalo_user_id, 64) ? `zalo-${slug(order.zalo_user_id, 64)}` : 'khach-le';
}

/** [yyyy, mm, dd] of the order in shop time. */
function dayParts(order) {
  const d = new Date(new Date(order.completed_at || order.created_at || Date.now()).getTime() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return [String(d.getUTCFullYear()), p(d.getUTCMonth() + 1), p(d.getUTCDate())];
}

async function saveCopy(orderId, buf) {
  try {
    const order = await orderModel.getById(orderId);
    const tag = crypto.createHmac('sha256', KEY).update(`saved:${orderId}`).digest('hex').slice(0, 12);
    const name = `${String((order && order.order_code) || orderId).replace(/[^A-Za-z0-9_-]/g, '')}-${tag}.png`;
    const dir = path.join(SAVE_DIR, await customerDir(order || {}), ...dayParts(order || {}));
    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    const tmp = `${target}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, target);
    return target;
  } catch (err) {
    logger.warn(`Receipt copy of order ${orderId} not saved`, err);
    return null;
  }
}

/** { url, base64, mime } of the receipt PNG (also saved to the uploads folder), or null when it cannot be drawn. */
async function receipt(orderId) {
  const buf = await receiptPng(orderId);
  if (!buf) return null;
  await saveCopy(orderId, buf);
  return picture('receipt', 'receipt', orderId, buf);
}

/** { url, base64, mime } of the payment QR, or null when there is no bank account (or nothing left to pay). */
const payQr = (orderId, info) => picture('payQr', 'pay-qr', orderId, payQrPng(orderId, info));

/** Text under the QR: account, amount, transfer content. */
function paymentText(order, info) {
  return [
    `💳 THANH TOÁN ĐƠN ${order.order_code}`,
    `Số tiền: ${new Intl.NumberFormat('vi-VN').format(Math.round(Number(order.total)))}đ`,
    `Chuyển khoản: ${chatbotInfo.bankLine(info)}`,
    `Nội dung: ${transferNote(order)}`,
    'Hoặc quét mã QR bên dưới. Có thể thanh toán tiền mặt tại quầy.',
  ].join('\n');
}

/** { url, base64, mime } of a customer's debt statement picture, or null. The link is good for a day. */
async function statementPicture({ customerId, from, to }) {
  const buf = await statementService.customerPng({ customerId, from, to });
  if (!buf) return null;
  const url = env.publicBaseUrl ? `${env.publicBaseUrl}/api/zalo/statement/${signData('statement', { c: customerId, f: from, t: to }, STATEMENT_TTL_MS)}.png` : null;
  return { url, base64: buf.toString('base64'), mime: 'image/png' };
}

/** { url, base64, mime } of the all-customers reconciliation picture (for the shop owner), or null. */
async function reconciliationPicture({ from, to }) {
  const buf = await statementService.allPng({ from, to });
  if (!buf) return null;
  const url = env.publicBaseUrl ? `${env.publicBaseUrl}/api/zalo/reconciliation/${signData('reconciliation', { f: from, t: to }, STATEMENT_TTL_MS)}.png` : null;
  return { url, base64: buf.toString('base64'), mime: 'image/png' };
}

module.exports = { statementPicture, reconciliationPicture, signData, sign, verify, pngFor, receipt, payQr, paymentText, transferNote, receiptPng, payQrPng, saveCopy, SAVE_DIR, TTL_MS };
