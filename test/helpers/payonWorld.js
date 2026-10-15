// In-memory PayOn world for tests: payon_payments rows with the model's atomic claim, one order, recorded side effects.
const crypto = require('../../src/services/payon/payonCrypto');
const payonConfig = require('../../src/services/payon/payonConfig');
const payonClient = require('../../src/services/payon/payonClient');
const payonModel = require('../../src/models/payonModel');
const orderModel = require('../../src/models/orderModel');
const orderService = require('../../src/services/orderService');
const ownerNotice = require('../../src/services/zalo/ownerNotice');
const paymentNotification = require('../../src/services/zalo/paymentNotificationService');

const APP = '160088PayON';
const SECRET = 'S3cretKey';
const CFG = { enabled: true, complete: true, ready: true, env: 'sandbox', baseUrl: 'https://dev.example', appId: APP, merchantId: '12345', authUser: 'u', authPass: 'p', secretKey: SECRET, bankCode: 'VCB', bankName: 'Vietcombank', expireMinutes: 15 };

/** A world in memory: payon_payments rows with the model's atomic claim, one order, recorded side effects. */
function world(t, { cfg = CFG, order = {} } = {}) {
  const rows = new Map();
  let seq = 0;
  const w = { rows, calls: [], notices: [], paid: [], order: { id: 42, order_code: 'CF261015-00042', status: 'open', payment_status: 'unpaid', total: 79000, ...order } };
  t.mock.method(payonConfig, 'get', async () => cfg);
  t.mock.method(payonModel, 'create', async (r) => { seq += 1; rows.set(seq, { id: seq, merchant_request_id: r.requestId, kind: r.kind, order_id: r.orderId, amount: r.amount, status: 'pending', expires_at: r.expiresAt, created_by: r.userId, qr_pay: null, note: null }); return seq; });
  t.mock.method(payonModel, 'setQr', async (id, q) => { Object.assign(rows.get(id), { payment_id: q.paymentId, qr_pay: q.qrPay, qr_image: q.qrImage }); });
  t.mock.method(payonModel, 'getById', async (id) => (rows.has(id) ? { ...rows.get(id) } : null));
  t.mock.method(payonModel, 'getByRequestId', async (rid) => { const r = [...rows.values()].find((x) => x.merchant_request_id === rid); return r ? { ...r } : null; });
  t.mock.method(payonModel, 'listForOrder', async (oid) => [...rows.values()].filter((r) => r.order_id === oid).sort((a, b) => b.id - a.id).map((r) => ({ ...r })));
  t.mock.method(payonModel, 'claim', async (id, from, f) => { const r = rows.get(id); if (!r || !from.includes(r.status)) return false; Object.assign(r, { status: 'applying', payon_status: f.payonStatus, payment_id: f.paymentId ?? r.payment_id, received: f.received, fee: f.fee, paid_at: f.paidAt }); return true; });
  t.mock.method(payonModel, 'finish', async (id, status, note) => { Object.assign(rows.get(id), { status, note: note || null }); });
  t.mock.method(orderModel, 'getById', async () => (w.order ? { ...w.order } : null));
  t.mock.method(orderService, 'payOrder', async (id, opts) => { w.paid.push({ id, ...opts }); w.order.payment_status = 'paid'; return { order: w.order }; });
  t.mock.method(ownerNotice, 'notifyOwner', async (text) => { w.notices.push(text); return 'sent'; });
  t.mock.method(paymentNotification, 'notifyOrderPaid', async (id) => { w.calls.push(['notifyOrderPaid', id]); return 'sent'; });
  w.check = null;
  t.mock.method(payonClient, 'checkPayment', async (rid) => { w.calls.push(['checkPayment', rid]); if (w.check instanceof Error) throw w.check; return w.check; });
  t.mock.method(payonClient, 'createQr', async (p) => { w.calls.push(['createQr', p]); if (w.createError) throw w.createError; return { payment_id: 987654, qrcode_pay: '00020101021238...', qrcode_image: '', amount_payment: p.amount, order_amount: p.amount }; });
  return w;
}

const ipnItem = (rid, over = {}) => ({ merchant_id: 12345, merchant_request_id: rid, payment_id: 987654, transaction_id: 'T-1', time_performed: '2026-10-15 16:40:00', amount: 79000, fee: 0, status: 2, transaction_detail: { order_amount: 79000 }, ...over });
const signedIpn = (items, secret = SECRET) => { const rawBody = JSON.stringify({ data: items, checksum: crypto.checksum(APP, crypto.phpJsonEncode(items), secret) }); return { body: JSON.parse(rawBody), rawBody, ip: '1.2.3.4' }; };
const paidAnswer = (over = {}) => ({ status: 2, amount: 79000, fee: 0, payment_id: 987654, transaction_id: 'T-1', time_performed: '2026-10-15 16:40:00', ...over });

module.exports = { world, ipnItem, signedIpn, paidAnswer, APP, SECRET, CFG };
