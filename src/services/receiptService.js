const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const orderModel = require('../models/orderModel');
const zaloApi = require('./zalo/zaloApiService');
const billDelivery = require('./zalo/billDelivery');
const { formatVnd, formatShopTime } = require('../utils/text');

const RECEIPT_DIR = path.join(env.rootDir, 'public', 'receipts');

function buildText(order, items) {
  const when = formatShopTime(order.completed_at || order.created_at);
  const lines = [
    `☕ ${env.business.shopName.toUpperCase()}`,
    `HÓA ĐƠN ${order.order_code}`,
    `Thời gian: ${when}`,
    '────────────────',
    ...items.map((i) => `• ${i.quantity} x ${i.product_name}${i.note ? ` (${i.note})` : ''} — ${formatVnd(i.line_total)}đ`),
    '────────────────',
  ];
  if (order.discount > 0) lines.push(`Tạm tính: ${formatVnd(order.subtotal)}đ`, `Giảm giá: -${formatVnd(order.discount)}đ`);
  lines.push(`TỔNG CỘNG: ${formatVnd(order.total)}đ`);
  lines.push(order.payment_status === 'paid' ? 'Trạng thái: Đã thanh toán ✅' : 'Trạng thái: Chưa thanh toán');
  if (env.business.paymentNote && order.payment_status !== 'paid') lines.push(env.business.paymentNote);
  lines.push('Cảm ơn quý khách!');
  return lines.join('\n');
}

/**
 * Optional PNG receipt (pure JS via `pureimage`, no native libs => works on shared hosting).
 * Needs a TTF with Vietnamese glyphs at RECEIPT_FONT_PATH. Returns a public URL or null.
 */
async function buildImage(order, items) {
  if (!env.receiptImage.enabled) return null;
  if (!env.publicBaseUrl) { logger.warn('Receipt image skipped: PUBLIC_BASE_URL not set'); return null; }
  let PImage;
  try { PImage = require('pureimage'); } catch (_) { logger.warn('Receipt image skipped: pureimage not installed'); return null; }
  if (!fs.existsSync(env.receiptImage.fontPath)) { logger.warn(`Receipt image skipped: font not found at ${env.receiptImage.fontPath}`); return null; }

  PImage.registerFont(env.receiptImage.fontPath, 'Receipt').loadSync();
  const rows = [
    { t: env.business.shopName.toUpperCase(), size: 30, gap: 44, bold: true },
    { t: `HÓA ĐƠN ${order.order_code}`, size: 22, gap: 32 },
    { t: formatShopTime(order.completed_at || order.created_at), size: 20, gap: 36 },
    ...items.map((i) => ({ l: `${i.quantity} x ${i.product_name}${i.note ? ` (${i.note})` : ''}`, r: `${formatVnd(i.line_total)}đ`, size: 22, gap: 32 })),
    { t: '', size: 10, gap: 12 },
    { l: 'TỔNG CỘNG', r: `${formatVnd(order.total)}đ`, size: 28, gap: 46, bold: true },
    { t: order.payment_status === 'paid' ? 'Đã thanh toán' : 'Chưa thanh toán', size: 20, gap: 30 },
    { t: 'Cảm ơn quý khách!', size: 20, gap: 30 },
  ];
  const W = 640;
  const H = 60 + rows.reduce((s, r) => s + r.gap, 0);
  const img = PImage.make(W, H);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#222222';
  let y = 50;
  for (const r of rows) {
    ctx.font = `${r.size}px Receipt`;
    if (r.t !== undefined) {
      const w = ctx.measureText(r.t).width;
      ctx.fillText(r.t, (W - w) / 2, y);
    } else {
      ctx.fillText(r.l, 30, y);
      ctx.fillText(r.r, W - 30 - ctx.measureText(r.r).width, y);
    }
    y += r.gap;
  }

  fs.mkdirSync(RECEIPT_DIR, { recursive: true });
  const file = `${order.order_code}-${crypto.randomBytes(6).toString('hex')}.png`; // unguessable URL
  await PImage.encodePNGToStream(img, fs.createWriteStream(path.join(RECEIPT_DIR, file)));
  return `${env.publicBaseUrl}/receipts/${file}`;
}

/**
 * How to push messages and pictures into the Zalo chat of an order, or null when the channel cannot push (Bot Client mode).
 * { reply(text), image({ url, caption }), textBill() } as billDelivery.deliver expects; pictures go by public URL.
 */
function channelFor(order, mode, text = '') {
  const noUrl = () => { throw new Error('PUBLIC_BASE_URL chưa đặt: Zalo không có địa chỉ công khai để lấy ảnh.'); };
  if (mode === 'platform') {
    const bot = require('./zalo/zaloBotPlatform');
    const chatId = order.zalo_chat_id;
    return {
      reply: (t) => bot.sendText(chatId, t),
      image: async ({ url, caption }) => { if (!url) noUrl(); await bot.sendPhoto(chatId, url, caption); },
      textBill: () => bot.sendText(chatId, text),
    };
  }
  if (mode === 'oa') {
    const target = { chatType: order.zalo_chat_type, chatId: order.zalo_chat_id };
    return {
      reply: (t) => zaloApi.sendText(target, t),
      image: async ({ url, caption }) => { if (!url) noUrl(); await zaloApi.sendImageWithText(target, caption || '', url); },
      textBill: () => zaloApi.sendText(target, text),
    };
  }
  return null;
}

/**
 * Send the bill back to the Zalo chat that placed the order (the admin's "Gửi lại bill"): the 80 mm PNG receipt, then the
 * bank account and VietQR for an unpaid order, exactly as the chatbot does after "ok" (services/zalo/billDelivery.js);
 * the text bill when the picture cannot be sent. Called AFTER the DB commit and never throws: a failed delivery must
 * not undo a finalized sale; it is recorded on the order (orders.receipt_error) and can be retried.
 * @returns {Promise<{sent:boolean, error?:string, bill?:string, paymentInfo?:boolean, qr?:boolean, pictureError?:string|null}>}
 */
const inflight = new Set();       // orders whose bill is being sent right now: a double click must not send the whole set twice

/** Plain text bill only (no picture, no payment info): what the OA channel's "ok" reply uses as the text fallback. */
async function sendTextBill(orderId) {
  const { mode } = await require('./zalo/zaloConfig').get();
  const order = await orderModel.getById(orderId);
  if (!order || order.source !== 'zalo' || !order.zalo_chat_id) throw new Error('not a Zalo order');
  const io = channelFor(order, mode, buildText(order, await orderModel.getItems(orderId)));
  if (!io) throw new Error('this Zalo mode cannot push messages');
  try {
    await io.textBill();
    await orderModel.markReceipt(orderId, null);
  } catch (err) {
    await orderModel.markReceipt(orderId, err.message).catch(() => {});
    throw err;
  }
}

async function sendReceipt(orderId) {
  const key = Number(orderId);
  if (inflight.has(key)) return { sent: false, error: 'Đang gửi bill cho đơn này, vui lòng đợi vài giây rồi thử lại.' };
  inflight.add(key);
  try {
    return await sendReceiptNow(orderId);
  } finally {
    inflight.delete(key);
  }
}

async function sendReceiptNow(orderId) {
  const { mode } = await require('./zalo/zaloConfig').get();
  // Bot Client mode: the server cannot push into Zalo; bills travel in the webhook response when the customer confirms.
  if (mode !== 'platform' && mode !== 'oa') return { sent: false, error: 'Chế độ Zalo bot: bill được gửi vào nhóm khi khách chốt đơn. Hãy in hóa đơn hoặc gửi tay.' };
  try {
    const order = await orderModel.getById(orderId);
    if (!order || order.source !== 'zalo' || !order.zalo_chat_id) return { sent: false, error: 'not a Zalo order' };
    const items = await orderModel.getItems(orderId);
    const text = buildText(order, items);
    const io = channelFor(order, mode, text);
    const r = await billDelivery.deliver(io, orderId);
    if (r.bill === 'none') throw new Error(r.error || r.pictureError || 'Không gửi được bill.');
    // what the owner sees on the order: the bill went as text because of the picture, or the payment info was not delivered
    const problem = r.bill === 'text' && r.pictureError ? `Đã gửi bill chữ: ${r.pictureError}` : (r.error ? `Đã gửi bill, chưa gửi được thông tin thanh toán: ${r.error}` : null);
    await orderModel.markReceipt(orderId, problem);
    return { sent: true, ...r };
  } catch (err) {
    logger.error(`Receipt delivery failed for order ${orderId}`, err);
    await orderModel.markReceipt(orderId, err.message).catch(() => {});
    return { sent: false, error: err.message };
  }
}

module.exports = { buildText, buildImage, sendReceipt, sendTextBill, channelFor };
