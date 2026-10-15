/**
 * After "ok": the 80 mm PNG receipt (also saved under uploads), then the shop's bank account and a VietQR code for the
 * order amount. Falls back to the text bill when the picture cannot be made. Bot Client channel, data layer faked.
 */
process.env.FNB_NO_LISTEN = '1';
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
process.env.ZALO_MODE = 'bot';
process.env.BOT_WEBHOOK_SECRET = 'test-bot-secret-0123456789';
process.env.PUBLIC_BASE_URL = 'https://cafe.example.test';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.RECEIPT_SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bills-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mock } = require('node:test');

test('bill delivery after confirm', async (t) => {
  const db = require('../src/config/db');
  const productModel = require('../src/models/productModel');
  const orderModel = require('../src/models/orderModel');
  const orderService = require('../src/services/orderService');
  const settingsModel = require('../src/models/settingsModel');
  const { sessionModel, eventModel } = require('../src/models/zaloModel');
  const billMedia = require('../src/services/zalo/billMedia');
  const vietQr = require('../src/services/vietQr');
  const customerModel = require('../src/models/customerModel');

  mock.method(eventModel, 'insertIfNew', async () => true);
  mock.method(eventModel, 'mark', async () => {});
  mock.method(db, 'withTransaction', async (fn) => fn({}));
  mock.method(productModel, 'listForMatching', async () => [{ id: 2, name: 'Cà phê sữa đá', price: 25000, category_name: 'Đồ uống', keywords: new Set(['ca phe sua da']) }]);
  const session = { id: 1, draft_order_id: null, is_expired: 0 };
  mock.method(sessionModel, 'lockOrCreate', async () => session);
  mock.method(sessionModel, 'find', async () => session);
  mock.method(sessionModel, 'setDraft', async (_c, _id, orderId) => { session.draft_order_id = orderId; });
  mock.method(sessionModel, 'clearDraft', async () => { session.draft_order_id = null; });
  const order = {
    id: 700, order_code: 'CF261014-00700', total: 50000, subtotal: 50000, discount: 0, status: 'draft', payment_status: 'unpaid', source: 'zalo', zalo_user_id: 'z-lan', created_at: new Date(),
    items: [{ product_name: 'Cà phê sữa đá', quantity: 2, unit_price: 25000, line_total: 50000, note: 'ít đường' }],
  };
  mock.method(orderService, 'upsertZaloDraft', async () => 700);
  mock.method(orderService, 'getWithItems', async () => order);
  mock.method(orderService, 'confirmDraft', async () => { order.status = 'completed'; order.completed_at = new Date(); });
  mock.method(customerModel, 'findByZaloUser', async (z) => (z === 'z-lan' ? { id: 5, name: 'Chị Lan' } : null));
  mock.method(customerModel, 'getById', async (id) => (id === 5 ? { id: 5, name: 'Chị Lan' } : null));
  mock.method(orderModel, 'getById', async () => order);
  mock.method(orderModel, 'getItems', async () => order.items);
  const marks = [];
  mock.method(orderModel, 'markReceipt', async (id, err) => { marks.push([id, err]); });
  const SETTINGS = new Map([['printer.shopAddress', '12 Lê Lợi, Q.1']]);
  mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries([...SETTINGS].filter(([k]) => k.startsWith(p))));

  const app = require('../app');
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); fs.rmSync(process.env.RECEIPT_SAVE_DIR, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  const say = async (message) => (await fetch(`${base}/api/zalo/webhook`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-bot-secret-0123456789', 'Content-Type': 'application/json' },
    body: JSON.stringify({ senderId: 'z-lan', message, messageId: `b-${++n}` }),
  })).json();
  const listPngs = (dir = process.env.RECEIPT_SAVE_DIR) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listPngs(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const pngSize = (b64) => { const b = Buffer.from(b64, 'base64'); return { magic: b.subarray(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

  await t.test('no bank account: the 80 mm PNG only, saved to the uploads folder, served by its signed link', async () => {
    await say('2 cà phê sữa đá ít đường');
    const r = await say('ok');
    assert.equal(r.action, 'confirmed');
    assert.deepEqual(r.replies.map((x) => x.type), ['image']);
    const img = r.replies[0];
    const size = pngSize(img.base64);
    assert.equal(size.magic, 'PNG');
    assert.equal(size.w, 576, '80 mm paper = 576 dots');
    assert.ok(size.h > 300);
    assert.deepEqual(marks.at(-1), [700, null], 'receipt marked as delivered');

    const saved = listPngs();
    assert.equal(saved.length, 1);
    const rel = path.relative(process.env.RECEIPT_SAVE_DIR, saved[0]).split(path.sep);
    const shopDay = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10).split('-');
    assert.deepEqual(rel.slice(0, 4), ['KH5-chi-lan', ...shopDay], 'khách hàng/yyyy/mm/dd');
    assert.match(rel[4], /^CF261014-00700-[0-9a-f]{12}\.png$/, 'unguessable name');
    assert.deepEqual(fs.readFileSync(saved[0]), Buffer.from(img.base64, 'base64'));

    const served = await fetch(base + new URL(img.url).pathname);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.from(img.base64, 'base64'));
    const token = new URL(img.url).pathname.split('/').pop();
    assert.equal((await fetch(`${base}/api/zalo/pay-qr/${token}`)).status, 404, 'a receipt link is not a QR link');
  });

  await t.test('with a bank account: receipt, then account + amount + transfer content, then the VietQR for that amount', async () => {
    SETTINGS.set('chatbot.bankBin', '970436').set('chatbot.bankAccount', '0123456789').set('chatbot.bankAccountName', 'NGUYEN VAN A');
    order.status = 'draft';
    await say('2 cà phê sữa đá');
    const r = await say('ok');
    assert.deepEqual(r.replies.map((x) => x.type), ['image', 'text', 'image']);
    assert.match(r.replies[1].text, /THANH TOÁN ĐƠN CF261014-00700/);
    assert.match(r.replies[1].text, /Số tiền: 50\.000đ/);
    assert.match(r.replies[1].text, /Vietcombank · 0123456789 · NGUYEN VAN A/);
    assert.match(r.replies[1].text, /Nội dung: CF261014 00700/);
    const qr = r.replies[2];
    const expected = await vietQr.png(vietQr.payload({ bin: '970436', account: '0123456789', amount: 50000, note: 'CF261014 00700' }));
    assert.deepEqual(Buffer.from(qr.base64, 'base64'), expected, 'the QR encodes the order amount and code');
    assert.match(qr.url, /\/api\/zalo\/pay-qr\/[\w-]+\.[\w-]{22}\.png$/);
    assert.match(qr.caption, /50\.000đ/);
    const served = await fetch(base + new URL(qr.url).pathname);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), expected);
    assert.equal(listPngs().length, 1, 'the same order overwrites its saved copy');
  });

  await t.test('the QR link stops working once the order is paid; a forged link is 404', async () => {
    const tokenPath = `/api/zalo/pay-qr/${billMedia.sign('payQr', 700)}.png`;
    assert.equal((await fetch(base + tokenPath)).status, 200);
    order.payment_status = 'paid';
    assert.equal((await fetch(base + tokenPath)).status, 404);
    order.payment_status = 'unpaid';
    assert.equal((await fetch(`${base}/api/zalo/receipt/${'a'.repeat(30)}.${'b'.repeat(22)}.png`)).status, 404);
  });

  await t.test('picture unavailable: the text bill is sent instead, then the payment info still follows', async () => {
    const spy = mock.method(billMedia, 'receipt', async () => null);
    order.status = 'draft';
    await say('2 cà phê sữa đá');
    const r = await say('ok');
    spy.mock.restore();
    assert.deepEqual(r.replies.map((x) => x.type), ['text', 'text', 'image']);
    assert.match(r.replies[0].text, /HÓA ĐƠN CF261014-00700/);
    assert.match(r.replies[0].text, /TỔNG CỘNG: 50\.000đ/);
    assert.match(r.replies[1].text, /THANH TOÁN ĐƠN/);
  });
});
