const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const orderModel = require('../models/orderModel');
const zaloApi = require('./zalo/zaloApiService');
const { formatVnd, formatShopTime } = require('../utils/text');

const RECEIPT_DIR = path.join(env.rootDir, 'public', 'receipts');

function buildText(order, items) {
  const when = formatShopTime(order.completed_at || order.created_at);
  const lines = [
    `☕ ${env.business.shopName.toUpperCase()}`,
    `HÓA ĐƠN ${order.order_code}`,
    `Thời gian: ${when}`,
    '────────────────',
    ...items.map((i) => `• ${i.quantity} x ${i.product_name} — ${formatVnd(i.line_total)}đ`),
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
    ...items.map((i) => ({ l: `${i.quantity} x ${i.product_name}`, r: `${formatVnd(i.line_total)}đ`, size: 22, gap: 32 })),
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
 * Send the bill back to the Zalo chat that placed the order. Called AFTER the DB commit and never
 * throws: a failed delivery must not undo a finalized sale; it is recorded on the order instead
 * (orders.receipt_error) and can be retried via POST /api/orders/:id/resend-receipt.
 * @returns {Promise<{sent:boolean,error?:string}>}
 */
async function sendReceipt(orderId) {
  if (env.zalo.mode === 'platform') {
    try {
      const order = await orderModel.getById(orderId);
      if (!order || order.source !== 'zalo' || !order.zalo_chat_id) return { sent: false, error: 'not a Zalo order' };
      await require('./zalo/zaloBotPlatform').sendText(order.zalo_chat_id, buildText(order, await orderModel.getItems(orderId)));
      await orderModel.markReceipt(orderId, null);
      return { sent: true };
    } catch (err) {
      logger.error(`Receipt delivery failed for order ${orderId}`, err);
      await orderModel.markReceipt(orderId, err.message).catch(() => {});
      return { sent: false, error: err.message };
    }
  }
  // Bot Client mode: the server cannot push into Zalo; bills travel in the webhook response when the customer confirms.
  if (env.zalo.mode !== 'oa') return { sent: false, error: 'Chế độ Zalo bot: bill được gửi vào nhóm khi khách chốt đơn. Hãy in hóa đơn hoặc gửi tay.' };
  try {
    const order = await orderModel.getById(orderId);
    if (!order || order.source !== 'zalo' || !order.zalo_chat_id) return { sent: false, error: 'not a Zalo order' };
    const items = await orderModel.getItems(orderId);
    const target = { chatType: order.zalo_chat_type, chatId: order.zalo_chat_id };
    const text = buildText(order, items);

    let imageUrl = null;
    try { imageUrl = await buildImage(order, items); } catch (err) { logger.warn('Receipt image failed, falling back to text', err); }

    try {
      if (imageUrl) await zaloApi.sendImageWithText(target, text, imageUrl);
      else await zaloApi.sendText(target, text);
    } catch (err) {
      if (!imageUrl) throw err;
      await zaloApi.sendText(target, text); // image rejected by Zalo -> still deliver the bill
    }
    await orderModel.markReceipt(orderId, null);
    return { sent: true };
  } catch (err) {
    logger.error(`Receipt delivery failed for order ${orderId}`, err);
    await orderModel.markReceipt(orderId, err.message).catch(() => {});
    return { sent: false, error: err.message };
  }
}

module.exports = { buildText, buildImage, sendReceipt };
