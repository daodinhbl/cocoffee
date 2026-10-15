process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
process.env.PUBLIC_BASE_URL = 'https://cafe.example.test';
process.env.PAYON_APP_ID = ''; process.env.PAYON_SECRET_KEY = ''; process.env.PAYON_ENV = '';   // a developer .env must not leak in
const test = require('node:test');
const assert = require('node:assert/strict');

const crypto = require('../src/services/payon/payonCrypto');
const payonModel = require('../src/models/payonModel');
const orderService = require('../src/services/orderService');
const payonService = require('../src/services/payon/payonService');
const { AppError } = require('../src/utils/httpError');
const { world, ipnItem, signedIpn, paidAnswer, APP, SECRET, CFG } = require('./helpers/payonWorld');

async function makeQr(w) {
  const view = await payonService.createOrderQr(42, { userId: 7 });
  return { view, row: [...w.rows.values()][0] };
}

test('createOrderQr asks PayOn for the order total with our notification URL, stores the QR and returns it', async (t) => {
  const w = world(t);
  const { view, row } = await makeQr(w);
  const [, p] = w.calls.find((c) => c[0] === 'createQr');
  assert.equal(p.amount, 79000);
  assert.equal(p.bankCode, 'VCB');
  assert.equal(p.expireSeconds, 900);
  assert.equal(p.urlNotify, 'https://cafe.example.test/api/payon/ipn');
  assert.match(p.requestId, /^CF261015-00042-[0-9a-f]{6}$/);
  assert.equal(row.order_id, 42);
  assert.equal(row.created_by, 7);
  assert.equal(view.open, true);
  assert.equal(view.qrPay, '00020101021238...');
});

test('an unexpired QR for the same amount is reused; a changed total gets a new one', async (t) => {
  const w = world(t);
  const first = await makeQr(w);
  const again = await payonService.createOrderQr(42, { userId: 7 });
  assert.equal(again.id, first.view.id);
  assert.equal(w.calls.filter((c) => c[0] === 'createQr').length, 1);
  w.order.total = 89000;
  const other = await payonService.createOrderQr(42, { userId: 7 });
  assert.notEqual(other.id, first.view.id);
});

test('createOrderQr refuses when PayOn is off, the order is not payable, or has no amount; a PayOn failure marks the row failed', async (t) => {
  let w = world(t, { cfg: { ...CFG, ready: false } });
  await assert.rejects(payonService.createOrderQr(42), { code: 'PAYON_NOT_READY' });
  t.mock.restoreAll();
  w = world(t, { order: { payment_status: 'paid' } });
  await assert.rejects(payonService.createOrderQr(42), { code: 'ORDER_NOT_PAYABLE' });
  w.order.payment_status = 'unpaid'; w.order.status = 'cancelled';
  await assert.rejects(payonService.createOrderQr(42), { code: 'ORDER_NOT_PAYABLE' });
  w.order.status = 'open'; w.order.total = 0;
  await assert.rejects(payonService.createOrderQr(42), { code: 'ORDER_NOT_PAYABLE' });
  w.order.total = 79000;
  w.createError = new AppError(502, 'PAYON_ERROR', 'PayOn chặn IP');
  await assert.rejects(payonService.createOrderQr(42), { code: 'PAYON_ERROR' });
  assert.equal([...w.rows.values()].at(-1).status, 'failed');
});

test('a signed notification pays the order once (transfer, PayOn reference), tells the owner and the customer', async (t) => {
  const w = world(t);
  const { row } = await makeQr(w);
  w.check = paidAnswer();
  const out = await payonService.handleNotification(signedIpn([ipnItem(row.merchant_request_id)]));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { error_code: '00', error_message: 'Success' });
  assert.equal(w.paid.length, 1);
  assert.equal(w.paid[0].id, 42);
  assert.equal(w.paid[0].method, 'transfer');
  assert.equal(w.paid[0].tendered, 79000, 'payOrder re-checks the amount under its row lock');
  assert.match(w.paid[0].reference, /^PayOn 987654$/);
  assert.equal(w.paid[0].userId, 7);
  assert.equal(w.paid[0].allowDebtSettlement, true);
  assert.equal(w.rows.get(row.id).status, 'paid');
  assert.match(w.notices[0], /Đã nhận chuyển khoản qua QR PayOn[\s\S]*CF261015-00042[\s\S]*79\.000đ/);
  assert.ok(w.calls.some((c) => c[0] === 'notifyOrderPaid' && c[1] === 42));
});

test('the same notification again, or a status check racing it, never pays twice', async (t) => {
  const w = world(t);
  const { row } = await makeQr(w);
  w.check = paidAnswer();
  const ipn = signedIpn([ipnItem(row.merchant_request_id)]);
  await Promise.all([payonService.handleNotification(ipn), payonService.handleNotification(ipn), payonService.refresh(row.id)]);
  await payonService.handleNotification(ipn);
  assert.equal(w.paid.length, 1);
});

test('bad checksum, wrong secret, missing config: refused and nothing changes', async (t) => {
  const w = world(t);
  const { row } = await makeQr(w);
  w.check = paidAnswer();
  let out = await payonService.handleNotification(signedIpn([ipnItem(row.merchant_request_id)], 'not-the-secret'));
  assert.equal(out.status, 401);
  assert.equal(out.body.error_code, '04');
  const tampered = signedIpn([ipnItem(row.merchant_request_id)]);
  tampered.body.data[0].amount = 1; tampered.rawBody = tampered.rawBody.replace('"amount":79000', '"amount":1');
  out = await payonService.handleNotification(tampered);
  assert.equal(out.status, 401);
  assert.equal(w.paid.length, 0);
  assert.equal(w.rows.get(row.id).status, 'pending');
  t.mock.restoreAll();
  world(t, { cfg: { ...CFG, complete: false } });
  assert.equal((await payonService.handleNotification(signedIpn([ipnItem('x')]))).status, 503);
});

test('unknown request ids and another merchant are ignored with a 200 (PayOn must not retry forever)', async (t) => {
  const w = world(t);
  const { row } = await makeQr(w);
  w.check = paidAnswer();
  let out = await payonService.handleNotification(signedIpn([ipnItem('NOPE-123456')]));
  assert.equal(out.status, 200);
  out = await payonService.handleNotification(signedIpn([ipnItem(row.merchant_request_id, { merchant_id: 999 })]));
  assert.equal(out.status, 200);
  assert.equal(w.paid.length, 0);
  assert.equal(w.rows.get(row.id).status, 'pending');
});

test('PayOn itself is asked: a notification claiming success while checkPayment says otherwise applies nothing', async (t) => {
  const w = world(t);
  const { row } = await makeQr(w);
  w.check = paidAnswer({ status: 1 });
  await payonService.handleNotification(signedIpn([ipnItem(row.merchant_request_id)]));
  assert.equal(w.paid.length, 0);
  assert.equal(w.rows.get(row.id).status, 'pending');
});

test('when PayOn cannot be asked, the signed notification is trusted', async (t) => {
  const w = world(t);
  const { row } = await makeQr(w);
  w.check = new AppError(502, 'PAYON_UNREACHABLE', 'down');
  await payonService.handleNotification(signedIpn([ipnItem(row.merchant_request_id)]));
  assert.equal(w.paid.length, 1);
});

test('money that cannot be applied is parked as manual with the reason and the owner is alerted (never paid twice)', async (t) => {
  for (const [label, order, pattern] of [
    ['paid another way', { payment_status: 'paid' }, /thu bằng cách khác[\s\S]*hoàn 79\.000đ/],
    ['cancelled', { status: 'cancelled' }, /bị hủy[\s\S]*hoàn/],
    ['total went up', { total: 99000 }, /chuyển 79\.000đ nhưng đơn CF261015-00042 hiện là 99\.000đ/],
  ]) {
    t.mock.restoreAll();
    const w = world(t);
    const { row } = await makeQr(w);
    Object.assign(w.order, order);
    w.check = paidAnswer();
    await payonService.handleNotification(signedIpn([ipnItem(row.merchant_request_id)]));
    const saved = w.rows.get(row.id);
    assert.equal(saved.status, 'manual', label);
    assert.match(saved.note, pattern, label);
    assert.equal(w.paid.length, 0, label);
    assert.match(w.notices[0], /CẦN XỬ LÝ/, label);
  }
});

test('an order that got cheaper still gets paid (the customer paid at least the total)', async (t) => {
  const w = world(t);
  const { row } = await makeQr(w);
  w.order.total = 70000;
  w.check = paidAnswer();
  await payonService.handleNotification(signedIpn([ipnItem(row.merchant_request_id)]));
  assert.equal(w.paid.length, 1);
  assert.equal(w.rows.get(row.id).status, 'paid');
});

test('a refused payOrder (409) parks the money; an unexpected error does too, without leaking its text', async (t) => {
  let w = world(t);
  let { row } = await makeQr(w);
  w.check = paidAnswer();
  orderService.payOrder.mock.mockImplementationOnce(async () => { throw new AppError(409, 'ORDER_NOT_PAYABLE', 'Order is cancelled/unpaid'); });
  await payonService.handleNotification(signedIpn([ipnItem(row.merchant_request_id)]));
  assert.equal(w.rows.get(row.id).status, 'manual');
  assert.match(w.rows.get(row.id).note, /Order is cancelled/);
  t.mock.restoreAll();
  w = world(t);
  ({ row } = await makeQr(w));
  w.check = paidAnswer();
  orderService.payOrder.mock.mockImplementationOnce(async () => { throw new Error('ER_LOCK_DEADLOCK secret-db-detail'); });
  await payonService.handleNotification(signedIpn([ipnItem(row.merchant_request_id)]));
  assert.equal(w.rows.get(row.id).status, 'manual');
  assert.doesNotMatch(w.rows.get(row.id).note, /secret-db-detail/);
});

test('a manual payment can be applied later (retry) and then pays the order once', async (t) => {
  const w = world(t);
  const { row } = await makeQr(w);
  w.order.status = 'cancelled';
  w.check = paidAnswer();
  await payonService.handleNotification(signedIpn([ipnItem(row.merchant_request_id)]));
  assert.equal(w.rows.get(row.id).status, 'manual');
  w.order.status = 'open';
  const saved = await payonModel.getById(row.id);
  await payonService.settle(saved, payonService.normalise(paidAnswer()), 'retry');
  assert.equal(w.rows.get(row.id).status, 'paid');
  assert.equal(w.paid.length, 1);
});

test('refresh: paid -> applied; failed -> failed; still open -> pending; long expired -> expired', async (t) => {
  const w = world(t);
  const { row } = await makeQr(w);
  w.check = paidAnswer({ status: 1 });
  assert.equal((await payonService.refresh(row.id)).status, 'pending');
  w.check = paidAnswer({ status: 3 });
  assert.equal((await payonService.refresh(row.id)).status, 'failed');
  t.mock.restoreAll();
  const w2 = world(t);
  const second = await makeQr(w2);
  w2.check = paidAnswer();
  assert.equal((await payonService.refresh(second.row.id)).status, 'paid');
  assert.equal(w2.paid.length, 1);
  t.mock.restoreAll();
  const w3 = world(t);
  const third = await makeQr(w3);
  w3.rows.get(third.row.id).expires_at = new Date(Date.now() - 10 * 60 * 1000);
  w3.check = new AppError(502, 'PAYON_ERROR', 'không tìm thấy');
  assert.equal((await payonService.refresh(third.row.id)).status, 'expired');
  await assert.rejects(payonService.refresh(9999), { code: 'NOT_FOUND' });
});

test('an encrypted-string notification (data like a request) is accepted too', async (t) => {
  const w = world(t);
  const { row } = await makeQr(w);
  w.check = paidAnswer();
  const data = crypto.encrypt(JSON.stringify([ipnItem(row.merchant_request_id)]), SECRET);
  const body = { data, checksum: crypto.checksum(APP, data, SECRET) };
  const out = await payonService.handleNotification({ body, rawBody: JSON.stringify(body), ip: '1.2.3.4' });
  assert.equal(out.status, 200);
  assert.equal(w.paid.length, 1);
});

test('normalise takes what the shop receives (order_amount) over the amount the payer was charged, and reads shop time', () => {
  const n = payonService.normalise({ status: '2', amount: 81500, fee: 2500, transaction_detail: { order_amount: 79000 }, time_performed: '2026-10-15 16:40:00', payment_id: 5 });
  assert.equal(n.status, 2);
  assert.equal(n.amount, 79000);
  assert.equal(n.fee, 2500);
  assert.equal(n.paymentId, 5);
  assert.equal(n.performedAt.toISOString(), '2026-10-15T09:40:00.000Z');
  assert.equal(payonService.parsePerformed('garbage'), null);
  assert.equal(payonService.parsePerformed('2026-10-15T09:40:00Z').toISOString(), '2026-10-15T09:40:00.000Z');
  assert.equal(payonService.normalise({}).amount, null);
});
