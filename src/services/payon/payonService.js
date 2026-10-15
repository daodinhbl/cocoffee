const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/httpError');
const { formatVnd } = require('../../utils/text');
const orderModel = require('../../models/orderModel');
const payonModel = require('../../models/payonModel');
const orderService = require('../orderService');
const payonConfig = require('./payonConfig');
const payonClient = require('./payonClient');
const payonCrypto = require('./payonCrypto');
const ownerNotice = require('../zalo/ownerNotice');
const paymentNotification = require('../zalo/paymentNotificationService');

/**
 * PayOn QR payments for orders.
 *  1. createOrderQr: a dynamic bank QR for the order's total (merchant_request_id = order code + random suffix).
 *  2. The customer pays; PayOn calls our notification endpoint (handleNotification) and/or an admin screen asks
 *     (refresh -> checkPayment). Both end in settle(): the order is paid once, whoever gets there first.
 *  3. Money that cannot be applied (order cancelled / paid another way / changed) is parked as status 'manual' with the
 *     reason, and the owner is told, so a person decides (usually a refund) — nothing is ever paid twice.
 * PayOn status 2 = success; 3 failed; 6 rejected; 1 / 4 still open.
 */
const PAID = 2;
const FAILED = [3, 6];
const SUCCESS_NOTE = 'PayOn';
const money = (n) => `${formatVnd(Math.round(Number(n) || 0))}đ`;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const notifyUrl = () => `${env.publicBaseUrl}/api/payon/ipn`;

function newRequestId(orderCode) {
  return `${String(orderCode).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** DATETIME text in the database timezone's wall clock is what mysql2 writes for a JS Date: pass Dates. */
const inSeconds = (s) => new Date(Date.now() + s * 1000);

/** What the order page needs to show a payment (no secrets; the QR content is a one-off token). */
function publicView(row) {
  if (!row) return null;
  return {
    id: row.id, status: row.status, amount: Number(row.amount), expiresAt: row.expires_at, paidAt: row.paid_at, note: row.note,
    qrPay: row.qr_pay || '', qrImage: row.qr_image || '', requestId: row.merchant_request_id, received: row.received === null ? null : Number(row.received),
    open: row.status === 'pending' && new Date(row.expires_at).getTime() > Date.now(),
  };
}

// --------------------------------------------------------------------------------------------------------- create

/**
 * A QR for an order. An unexpired QR for the same amount is reused (the customer may already have scanned it).
 * @returns {Promise<object>} publicView of the payment
 */
async function createOrderQr(orderId, { userId } = {}) {
  const cfg = await payonConfig.get();
  if (!cfg.ready) throw new AppError(409, 'PAYON_NOT_READY', 'Thanh toán QR PayOn chưa được bật. Vào Cài đặt để cấu hình.');
  if (!env.publicBaseUrl) throw new AppError(409, 'PAYON_NO_PUBLIC_URL', 'Chưa đặt PUBLIC_BASE_URL nên PayOn không có địa chỉ để báo tiền về.');
  const order = await orderModel.getById(orderId);
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy đơn.');
  const payable = order.status === 'open' || (order.status === 'completed' && order.payment_status === 'unpaid');
  if (!payable || order.payment_status === 'paid') throw new AppError(409, 'ORDER_NOT_PAYABLE', 'Đơn này không còn chờ thu tiền.');
  const amount = Math.round(Number(order.total));
  if (!(amount > 0)) throw new AppError(409, 'ORDER_NOT_PAYABLE', 'Đơn chưa có số tiền để thu.');

  const existing = (await payonModel.listForOrder(orderId, 5)).find((p) => p.status === 'pending' && Number(p.amount) === amount && new Date(p.expires_at).getTime() > Date.now() + 30 * 1000 && p.qr_pay);
  if (existing) return publicView(existing);

  const requestId = newRequestId(order.order_code);
  const expireSeconds = cfg.expireMinutes * 60;
  const id = await payonModel.create({ requestId, kind: 'order', orderId, amount, expiresAt: inSeconds(expireSeconds), userId });
  try {
    const qr = await payonClient.createQr({
      requestId, amount, expireSeconds, bankCode: cfg.bankCode,
      description: `Thanh toan ${order.order_code}`.slice(0, 100),
      urlNotify: notifyUrl(), urlRedirect: `${env.publicBaseUrl}/admin/orders/${orderId}`, urlCancel: `${env.publicBaseUrl}/admin/orders/${orderId}`,
    });
    if (!qr.qrcode_pay && !qr.qrcode_image) throw new AppError(502, 'PAYON_ERROR', 'PayOn không trả về mã QR.');
    await payonModel.setQr(id, { paymentId: qr.payment_id, qrPay: qr.qrcode_pay, qrImage: qr.qrcode_image });
  } catch (err) {
    await payonModel.finish(id, 'failed', err.message).catch(() => {});
    throw err;
  }
  return publicView(await payonModel.getById(id));
}

// --------------------------------------------------------------------------------------------------------- settle

/**
 * Turns "PayOn says it was paid" into a paid order, once. `result` = { status, amount, fee, paymentId, transactionId,
 * performedAt } normalised from a notification or checkPayment.
 * @returns {Promise<object>} the payment row afterwards
 */
async function settle(row, result, source) {
  if (FAILED.includes(result.status)) {
    if (row.status === 'pending') await payonModel.finish(row.id, 'failed', `PayOn báo trạng thái ${result.status}`);
    return payonModel.getById(row.id);
  }
  if (result.status !== PAID) return row;
  const claimed = await payonModel.claim(row.id, ['pending', 'manual'], {
    payonStatus: PAID, paymentId: result.paymentId, transactionId: result.transactionId, received: result.amount, fee: result.fee,
    paidAt: result.performedAt || new Date(),
  });
  if (!claimed) return payonModel.getById(row.id);   // already applied (or being applied) by the other path

  let outcome = { status: 'paid', note: null };
  let order = null;
  try {
    order = await orderModel.getById(row.order_id);
    if (!order) outcome = { status: 'manual', note: 'Không tìm thấy đơn hàng để ghi nhận tiền.' };
    else if (order.payment_status === 'paid') outcome = { status: 'manual', note: `Đơn ${order.order_code} đã được thu bằng cách khác: cần hoàn ${money(result.amount)} cho khách.` };
    else if (order.status === 'cancelled' || order.status === 'draft') outcome = { status: 'manual', note: `Đơn ${order.order_code} đã ${order.status === 'draft' ? 'ở dạng nháp' : 'bị hủy'}: cần hoàn ${money(result.amount)} cho khách.` };
    else if (Number(result.amount) < Number(order.total)) outcome = { status: 'manual', note: `Khách chuyển ${money(result.amount)} nhưng đơn ${order.order_code} hiện là ${money(order.total)} (đơn đã đổi hoặc khách trả thiếu).` };
    else {
      await orderService.payOrder(order.id, {
        method: 'transfer', reference: `${SUCCESS_NOTE} ${result.paymentId || row.merchant_request_id}`.slice(0, 100), userId: row.created_by, allowDebtSettlement: true,
      });
    }
  } catch (err) {
    const known = err instanceof AppError;
    if (!known) logger.error(`PayOn payment ${row.id}: applying failed`, err);
    outcome = { status: 'manual', note: known ? `Không ghi nhận được vào đơn: ${err.message}` : 'Lỗi hệ thống khi ghi nhận tiền; kiểm tra lại đơn.' };
  }
  await payonModel.finish(row.id, outcome.status, outcome.note);
  logger.info(`PayOn payment ${row.id} (${row.merchant_request_id}) via ${source}: ${outcome.status}${outcome.note ? ` — ${outcome.note}` : ''}`);

  const label = order ? order.order_code : `#${row.order_id}`;
  if (outcome.status === 'paid') {
    ownerNotice.notifyOwner(`💳 Đã nhận chuyển khoản qua QR PayOn\nĐơn: ${label}\nSố tiền: ${money(result.amount)}`).catch(() => {});
    if (order) paymentNotification.notifyOrderPaid(order.id).catch(() => {});   // the Zalo customer gets the paid receipt
  } else {
    ownerNotice.notifyOwner(`⚠️ CẦN XỬ LÝ: PayOn báo đã nhận ${money(result.amount)} cho đơn ${label} nhưng chưa ghi nhận được.\n${outcome.note}`).catch(() => {});
  }
  return payonModel.getById(row.id);
}

/** PayOn's answer (checkPayment / one item of a notification) -> the shape settle() takes. */
function normalise(answer) {
  const d = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};   // a thin/odd answer from PayOn must not crash a poll
  const detail = d.transaction_detail && typeof d.transaction_detail === 'object' ? d.transaction_detail : {};
  const received = num(detail.order_amount) ?? num(d.order_amount) ?? num(d.amount);
  return {
    status: num(d.status),
    amount: received,
    fee: num(d.fee),
    paymentId: d.payment_id ?? detail.payment_id ?? null,
    transactionId: d.transaction_id ?? detail.transaction_id ?? null,
    performedAt: parsePerformed(d.time_performed),
  };
}

/** "2026-10-15 16:40:00" (shop time) or an ISO text -> Date, null when unreadable. */
function parsePerformed(v) {
  if (!v) return null;
  const t = new Date(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(v)) ? '' : '+07:00'));
  return Number.isNaN(t.getTime()) ? null : t;
}

// --------------------------------------------------------------------------------------------------------- refresh

/**
 * Asks PayOn about a payment and applies the answer (used by the order page's check button and its polling).
 * @returns {Promise<object>} publicView
 */
async function refresh(paymentId) {
  const row = await payonModel.getById(paymentId);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy giao dịch QR.');
  if (row.status !== 'pending') return publicView(row);
  const now = Date.now();
  let current = row;
  try {
    const answer = await payonClient.checkPayment(row.merchant_request_id);
    const r = normalise(answer);
    if (r.status === PAID && (r.paymentId === null || r.paymentId === undefined)) r.paymentId = row.payment_id;
    current = await settle(row, r, 'check');
  } catch (err) {
    if (!(err instanceof AppError) || err.code === 'PAYON_NOT_CONFIGURED') throw err;
    logger.warn(`PayOn check of ${row.merchant_request_id} failed: ${err.code}`);   // keep the row: the notification may still come
  }
  if (current.status === 'pending' && new Date(current.expires_at).getTime() + 5 * 60 * 1000 < now) {
    await payonModel.finish(current.id, 'expired', 'QR đã hết hạn');
    current = await payonModel.getById(current.id);
  }
  return publicView(current);
}

// --------------------------------------------------------------------------------------------------- notification

/**
 * PayOn's order notification (IPN). The checksum proves it came from PayOn (it needs the merchant secret). For every payment
 * we know, PayOn is also asked directly (checkPayment, as the documentation advises) so the amount and status applied are
 * PayOn's own; when PayOn cannot be reached the signed notification is trusted.
 * @returns {Promise<{status:number, body:object}>} what to answer
 */
async function handleNotification({ body, rawBody, ip }) {
  const cfg = await payonConfig.get();
  if (!cfg.complete) return { status: 503, body: { error_code: '99', error_message: 'Chưa cấu hình PayOn' } };
  const verdict = payonCrypto.verifyNotification({ appId: cfg.appId, secret: cfg.secretKey, body, rawBody });
  if (!verdict.ok) {
    logger.warn(`PayOn notification refused: bad checksum (from ${ip || 'unknown'})`);
    return { status: 401, body: { error_code: '04', error_message: 'Invalid checksum' } };
  }
  let items = body.data;
  if (typeof items === 'string') {                                  // the encrypted form
    try { items = JSON.parse(payonCrypto.decrypt(items, cfg.secretKey) || 'null'); } catch (_) { items = null; }
  }
  items = Array.isArray(items) ? items : (items && typeof items === 'object' ? [items] : []);
  for (const item of items) {
    try {
      await handleItem(item, cfg);
    } catch (err) {
      logger.error('PayOn notification item failed', err);
      return { status: 500, body: { error_code: '99', error_message: 'Error' } };   // PayOn may retry
    }
  }
  return { status: 200, body: { error_code: '00', error_message: 'Success' } };
}

async function handleItem(item, cfg) {
  const requestId = item && item.merchant_request_id;
  if (!requestId) return;
  if (item.merchant_id !== undefined && String(item.merchant_id) !== String(cfg.merchantId)) {
    logger.warn(`PayOn notification for merchant ${item.merchant_id}, expected ${cfg.merchantId}: ignored`);
    return;
  }
  const row = await payonModel.getByRequestId(String(requestId));
  if (!row) {
    logger.warn(`PayOn notification for unknown request ${requestId}`);
    return;
  }
  let result = normalise(item);
  try {
    const confirmed = normalise(await payonClient.checkPayment(row.merchant_request_id));
    if (confirmed.status !== null) result = { ...result, ...confirmed, paymentId: confirmed.paymentId ?? result.paymentId, transactionId: confirmed.transactionId ?? result.transactionId, amount: confirmed.amount ?? result.amount };
  } catch (err) {
    logger.warn(`PayOn confirmation of ${requestId} unavailable (${err.code || err.message}): trusting the signed notification`);
  }
  await settle(row, result, 'ipn');
}

module.exports = { createOrderQr, refresh, handleNotification, settle, normalise, publicView, parsePerformed, newRequestId, PAID };
