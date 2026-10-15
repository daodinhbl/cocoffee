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
 *     reason, and the owner is told, so a person decides (usually a refund) — nothing is ever paid twice. Money that
 *     arrives after the QR expired is applied the same way.
 *  4. A claim that never finished (the process died) is recovered by recoverStale(): applied if the order already
 *     carries the payment, otherwise released so the next notification / check applies it.
 * PayOn status 2 = success; 3 failed; 6 rejected; 1 / 4 still open.
 */
const PAID = 2;
const FAILED = [3, 6];
const CLAIMABLE = ['pending', 'manual', 'expired', 'failed'];     // a success answer is applied from any of these
const STALE_MINUTES = 2;
const REF_PREFIX = 'PayOn';
const money = (n) => `${formatVnd(Math.round(Number(n) || 0))}đ`;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const notifyUrl = () => `${env.publicBaseUrl}/api/payon/ipn`;

function newRequestId(orderCode) {
  return `${String(orderCode).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** DATETIME text in the database timezone's wall clock is what mysql2 writes for a JS Date: pass Dates. */
const inSeconds = (s) => new Date(Date.now() + s * 1000);

/** What the order page needs to show a payment (no secrets; the QR content is a one-off token). */
function publicView(row, extra = {}) {
  if (!row) return null;
  const drawable = Boolean(row.qr_pay || row.qr_image);
  return {
    id: row.id, status: row.status, amount: Number(row.amount), expiresAt: row.expires_at, paidAt: row.paid_at, note: row.note,
    qrPay: row.qr_pay || '', qrImage: row.qr_image || '', requestId: row.merchant_request_id, received: row.received === null || row.received === undefined ? null : Number(row.received),
    open: row.status === 'pending' && drawable && new Date(row.expires_at).getTime() > Date.now(),
    ...extra,
  };
}

// --------------------------------------------------------------------------------------------------------- create

/**
 * A QR for an order. Earlier QRs of the order are reconciled with PayOn first (a customer may have paid a QR that looks
 * expired); an unexpired QR for the same amount is reused (the customer may already have scanned it).
 * @returns {Promise<object>} publicView of the payment
 */
async function createOrderQr(orderId, { userId } = {}) {
  const cfg = await payonConfig.get();
  if (!cfg.ready) throw new AppError(409, 'PAYON_NOT_READY', 'Thanh toán QR PayOn chưa được bật. Vào Cài đặt để cấu hình.');
  if (!env.publicBaseUrl) throw new AppError(409, 'PAYON_NO_PUBLIC_URL', 'Chưa đặt PUBLIC_BASE_URL nên PayOn không có địa chỉ để báo tiền về.');
  for (const earlier of await payonModel.listForOrder(orderId, 5)) {
    if (earlier.status === 'pending') await refresh(earlier.id).catch(() => {});      // a late payment settles the order first
  }
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
    await payonModel.finish(id, 'failed', err.message, ['pending']).catch(() => {});
    throw err;
  }
  return publicView(await payonModel.getById(id));
}

// --------------------------------------------------------------------------------------------------------- settle

/** Records the outcome; a failure to save it must not leave the payment hanging in "applying" unnoticed. */
async function saveOutcome(row, outcome) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (await payonModel.finish(row.id, outcome.status, outcome.note, ['applying'])) return true;
      return false;                                          // somebody else already settled it
    } catch (err) {
      logger.error(`PayOn payment ${row.id}: saving the outcome failed (attempt ${attempt})`, err);
    }
  }
  ownerNotice.notifyOwner(`⚠️ CẦN XỬ LÝ: giao dịch PayOn ${row.merchant_request_id} đã xử lý nhưng không lưu được kết quả (lỗi cơ sở dữ liệu). Kiểm tra đơn ${row.order_id}.`).catch(() => {});
  return false;
}

/**
 * Turns "PayOn says it was paid" into a paid order, once. `result` = { status, amount, fee, paymentId, transactionId,
 * performedAt } normalised from a notification or checkPayment.
 * @returns {Promise<object>} the payment row afterwards
 */
async function settle(row, result, source) {
  if (FAILED.includes(result.status)) {
    if (row.status === 'pending') await payonModel.finish(row.id, 'failed', `PayOn báo trạng thái ${result.status}`, ['pending']);
    return payonModel.getById(row.id);
  }
  if (result.status !== PAID) return row;
  const wasManual = row.status === 'manual';
  const late = row.status === 'expired' || row.status === 'failed';
  const claimed = await payonModel.claim(row.id, CLAIMABLE, {
    payonStatus: PAID, paymentId: result.paymentId, transactionId: result.transactionId, received: result.amount, fee: result.fee,
    paidAt: result.performedAt || new Date(),
  });
  if (!claimed) return payonModel.getById(row.id);   // already applied (or being applied) by the other path
  if (late) logger.warn(`PayOn payment ${row.id} (${row.merchant_request_id}): money arrived after the QR was marked ${row.status}`);

  let outcome = { status: 'paid', note: late ? 'Khách thanh toán sau khi QR đã hết hạn.' : null };
  let order = null;
  try {
    order = await orderModel.getById(row.order_id);
    if (!order) outcome = { status: 'manual', note: 'Không tìm thấy đơn hàng để ghi nhận tiền.' };
    else if (order.payment_status === 'paid') outcome = { status: 'manual', note: `Đơn ${order.order_code} đã được thu bằng cách khác: cần hoàn ${money(result.amount)} cho khách.` };
    else if (order.status === 'cancelled' || order.status === 'draft') outcome = { status: 'manual', note: `Đơn ${order.order_code} đã ${order.status === 'draft' ? 'ở dạng nháp' : 'bị hủy'}: cần hoàn ${money(result.amount)} cho khách.` };
    else if (Number(result.amount) < Number(order.total)) outcome = { status: 'manual', note: `Khách chuyển ${money(result.amount)} nhưng đơn ${order.order_code} hiện là ${money(order.total)} (đơn đã đổi hoặc khách trả thiếu).` };
    else {
      // `tendered` makes payOrder check the amount again under the order's row lock, against the total as it is NOW
      await orderService.payOrder(order.id, {
        method: 'transfer', tendered: result.amount, reference: `${REF_PREFIX} ${result.paymentId || row.merchant_request_id}`.slice(0, 100),
        userId: row.created_by, allowDebtSettlement: true,
      });
      const extra = Number(result.amount) - Number(order.total);
      if (extra > 0) outcome = { status: 'paid', note: `Khách chuyển dư ${money(extra)}: cần hoàn cho khách.`, overpaid: extra };
    }
  } catch (err) {
    const known = err instanceof AppError;
    if (!known) logger.error(`PayOn payment ${row.id}: applying failed`, err);
    outcome = { status: 'manual', note: known ? `Không ghi nhận được vào đơn: ${err.message}` : 'Lỗi hệ thống khi ghi nhận tiền; kiểm tra lại đơn.' };
  }
  // The same unapplied money seen again (a duplicate notification, a retry) keeps its first explanation and alerts once.
  const repeat = wasManual && outcome.status === 'manual';
  if (repeat) outcome.note = row.note || outcome.note;
  if (!(await saveOutcome(row, outcome))) return payonModel.getById(row.id);
  logger.info(`PayOn payment ${row.id} (${row.merchant_request_id}) via ${source}: ${outcome.status}${outcome.note ? ` — ${outcome.note}` : ''}`);

  const label = order ? order.order_code : `#${row.order_id}`;
  if (outcome.status === 'paid') {
    ownerNotice.notifyOwner(`💳 Đã nhận chuyển khoản qua QR PayOn\nĐơn: ${label}\nSố tiền: ${money(result.amount)}${outcome.overpaid ? `\n⚠️ ${outcome.note}` : ''}`).catch(() => {});
    if (order) paymentNotification.notifyOrderPaid(order.id).catch(() => {});   // the Zalo customer gets the paid receipt
  } else if (!repeat) {
    ownerNotice.notifyOwner(`⚠️ CẦN XỬ LÝ: PayOn báo đã nhận ${money(result.amount)} cho đơn ${label} nhưng chưa ghi nhận được.\n${outcome.note}`).catch(() => {});
  }
  return payonModel.getById(row.id);
}

/** PayOn's answer (checkPayment / one item of a notification) -> the shape settle() takes. */
function normalise(answer) {
  const d = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};   // a thin/odd answer must not crash a poll
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
 * Asks PayOn about a payment and applies the answer (the order page's check button and its polling). When PayOn cannot
 * be asked, the view says so (`checkError`) instead of pretending nothing happened.
 * @returns {Promise<object>} publicView (+ checkError when the check itself failed)
 */
async function refresh(paymentId) {
  const row = await payonModel.getById(paymentId);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy giao dịch QR.');
  if (row.status !== 'pending') return publicView(row);
  const now = Date.now();
  let current = row;
  let checkError = null;
  try {
    const r = normalise(await payonClient.checkPayment(row.merchant_request_id));
    if (r.status === PAID && (r.paymentId === null || r.paymentId === undefined)) r.paymentId = row.payment_id;
    current = await settle(row, r, 'check');
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'PAYON_NOT_CONFIGURED') throw err;
    logger.warn(`PayOn check of ${row.merchant_request_id} failed: ${err.code}`);   // keep the row: the notification may still come
    checkError = err.message;
  }
  if (current.status === 'pending' && new Date(current.expires_at).getTime() + 5 * 60 * 1000 < now) {
    await payonModel.finish(current.id, 'expired', 'QR đã hết hạn', ['pending']);     // a late payment can still be applied from "expired"
    current = await payonModel.getById(current.id);
  }
  return publicView(current, checkError ? { checkError } : {});
}

// --------------------------------------------------------------------------------------------------------- recovery

/**
 * Claims left in "applying" by a process that died: if the order already carries this payment (reference "PayOn <id>")
 * the payment is finished as paid; otherwise it goes back to pending so the next notification / check applies it.
 */
async function recoverStale() {
  let rows = [];
  try { rows = await payonModel.listStaleApplying(STALE_MINUTES); } catch (err) { logger.warn('PayOn recovery: cannot list', err); return 0; }
  let n = 0;
  for (const row of rows) {
    try {
      const refs = [row.payment_id, row.merchant_request_id].filter(Boolean).map((x) => `${REF_PREFIX} ${x}`);
      const payments = row.order_id ? await orderModel.getPayments(row.order_id) : [];
      if (payments.some((p) => refs.includes(String(p.reference || '')))) {
        if (await payonModel.finish(row.id, 'paid', 'Đã ghi nhận (khôi phục sau sự cố).', ['applying'])) {
          logger.warn(`PayOn payment ${row.id}: recovered as paid`);
          paymentNotification.notifyOrderPaid(row.order_id).catch(() => {});
          n += 1;
        }
      } else if (await payonModel.release(row.id)) {
        logger.warn(`PayOn payment ${row.id}: released for another attempt`);
        n += 1;
      }
    } catch (err) {
      logger.warn(`PayOn recovery of ${row.id} failed`, err);
    }
  }
  return n;
}

/** Sweep every few minutes (never keeps the process alive); also run before each notification. */
function startRecovery() {
  setInterval(() => { recoverStale().catch(() => {}); }, 5 * 60 * 1000).unref();
}

// --------------------------------------------------------------------------------------------------- notification

/**
 * PayOn's order notification (IPN). The checksum proves it came from PayOn (it needs the merchant secret) and the items
 * acted on are exactly the signed ones. For every payment we know, PayOn is also asked directly (checkPayment, as the
 * documentation advises) so the amount and status applied are PayOn's own; when PayOn cannot be reached the signed
 * notification is trusted.
 * @returns {Promise<{status:number, body:object}>} what to answer
 */
async function handleNotification({ body, rawBody, ip }) {
  let cfg = await payonConfig.get();
  if (!cfg.complete) cfg = await payonConfig.get({ fresh: true });          // a worker that has not seen the save yet
  if (!cfg.complete) return { status: 503, body: { error_code: '99', error_message: 'Chưa cấu hình PayOn' } };
  let verdict = payonCrypto.verifyNotification({ appId: cfg.appId, secret: cfg.secretKey, body, rawBody });
  if (!verdict.ok) {
    const fresh = await payonConfig.get({ fresh: true });                   // the key may have just changed on another worker
    if (fresh.secretKey !== cfg.secretKey || fresh.appId !== cfg.appId) {
      cfg = fresh;
      verdict = payonCrypto.verifyNotification({ appId: cfg.appId, secret: cfg.secretKey, body, rawBody });
    }
  }
  if (!verdict.ok) {
    logger.warn(`PayOn notification refused: bad checksum (from ${ip || 'unknown'})`);
    return { status: 401, body: { error_code: '04', error_message: 'Invalid checksum' } };
  }
  let items = verdict.data;
  if (typeof items === 'string') {                                          // the encrypted form
    try { items = JSON.parse(payonCrypto.decrypt(items, cfg.secretKey) || 'null'); } catch (_) { items = null; }
  }
  items = Array.isArray(items) ? items : (items && typeof items === 'object' ? [items] : []);
  await recoverStale().catch(() => {});
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

// --------------------------------------------------------------------------------------------------- operator actions

/** Retry applying a payment that needs a person (ask PayOn again, apply from "manual"). */
async function retryApply(paymentId) {
  const row = await payonModel.getById(paymentId);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy giao dịch QR.');
  if (row.status !== 'manual') throw new AppError(409, 'NOT_APPLICABLE', 'Giao dịch này không ở trạng thái cần xử lý.');
  const r = normalise(await payonClient.checkPayment(row.merchant_request_id));
  if (r.status !== PAID) throw new AppError(409, 'NOT_PAID', 'PayOn không xác nhận khoản tiền này.');
  if (r.paymentId === null || r.paymentId === undefined) r.paymentId = row.payment_id;
  return publicView(await settle(row, r, 'retry'));
}

/** A person dealt with the money (usually refunded the customer outside the app): close the item with a note. */
async function resolve(paymentId, { note, userId }) {
  const text = String(note || '').trim();
  if (!text) throw new AppError(400, 'VALIDATION', 'Ghi chú cách xử lý (ví dụ "đã hoàn tiền cho khách ngày …").');
  const row = await payonModel.getById(paymentId);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy giao dịch QR.');
  const changed = await payonModel.finish(paymentId, 'resolved', `${text} (xử lý bởi người dùng #${userId || '?'})`, ['manual']);
  if (!changed) throw new AppError(409, 'NOT_APPLICABLE', 'Giao dịch này không còn ở trạng thái cần xử lý.');
  return publicView(await payonModel.getById(paymentId));
}

module.exports = {
  createOrderQr, refresh, handleNotification, settle, normalise, publicView, parsePerformed, newRequestId, recoverStale, startRecovery,
  retryApply, resolve, PAID, STALE_MINUTES,
};
