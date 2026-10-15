/**
 * Zalo Bot Platform pushes started by the shop, not by a message: "Gửi lại bill" (PNG + bank account + QR), the
 * "đã nhận thanh toán" confirmation when the owner presses "Thu tiền" (order and debt), the webhook guard that
 * re-registers the webhook when its URL / secret changed, the menu aliases top-up and the picture/sticker hint.
 * Zalo API stubbed with axios, data layer faked. No MySQL.
 */
process.env.FNB_NO_LISTEN = '1';
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
process.env.ZALO_MODE = '';
process.env.ZALO_BOT_TOKEN = '123456:SECRET-TOKEN';
process.env.BOT_WEBHOOK_SECRET = 'platform-secret-123';
process.env.PUBLIC_BASE_URL = 'https://cafe.example.test';
process.env.RECEIPT_SAVE_DIR = require('node:path').join(require('node:os').tmpdir(), 'cc-notify-' + process.pid);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mock } = require('node:test');
const axios = require('axios');

const sent = [];
const stub = (answer) => mock.method(axios, 'post', async (url, body) => {
  const method = url.split('/').pop();
  sent.push({ method, body });
  return answer ? answer(method, body) : { status: 200, data: { ok: true, result: { message_id: 'm' } } };
});

test('shop-initiated Zalo messages', async (t) => {
  const orderModel = require('../src/models/orderModel');
  const customerModel = require('../src/models/customerModel');
  const settingsModel = require('../src/models/settingsModel');
  const receiptService = require('../src/services/receiptService');
  const notify = require('../src/services/zalo/paymentNotificationService');
  const guard = require('../src/services/zalo/webhookGuard');
  const zaloBot = require('../src/services/zalo/zaloBotPlatform');
  const zaloConfig = require('../src/services/zalo/zaloConfig');
  t.after(() => fs.rmSync(process.env.RECEIPT_SAVE_DIR, { recursive: true, force: true }));

  const SETTINGS = new Map();
  mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries([...SETTINGS].filter(([k]) => k.startsWith(p))));
  mock.method(settingsModel, 'setMany', async (values) => { for (const [k, v] of Object.entries(values)) SETTINGS.set(k, String(v)); });
  const order = {
    id: 800, order_code: 'CF261014-00800', source: 'zalo', status: 'completed', payment_status: 'unpaid', zalo_chat_id: 'u-lan', zalo_chat_type: 'user',
    subtotal: 50000, discount: 0, total: 50000, created_at: new Date(), completed_at: new Date(),
    items: [{ product_name: 'Cà phê sữa đá', quantity: 2, unit_price: 25000, line_total: 50000, note: null }],
  };
  mock.method(orderModel, 'getById', async () => order);
  mock.method(orderModel, 'getItems', async () => order.items);
  const receipts = [];
  mock.method(orderModel, 'markReceipt', async (id, err) => { receipts.push([id, err]); });
  mock.method(orderModel, 'getPayments', async () => [{ id: 1, method: 'transfer', amount: 50000, reference: null, paid_at: new Date('2026-10-14T16:20:00Z'), received_by_name: 'Chủ Quán' }]);
  mock.method(customerModel, 'getById', async () => null);
  const bank = () => SETTINGS.set('chatbot.bankBin', '970436').set('chatbot.bankAccount', '0123456789').set('chatbot.bankAccountName', 'NGUYEN VAN A');

  await t.test('"Gửi lại bill" sends the PNG, then account + amount, then the VietQR (and says so)', async () => {
    sent.length = 0;
    const post = stub();
    bank();
    const r = await receiptService.sendReceipt(800);
    assert.equal(r.sent, true);
    assert.equal(r.bill, 'picture');
    assert.deepEqual([r.paymentInfo, r.qr], [true, true]);
    assert.deepEqual(sent.map((s) => s.method), ['sendPhoto', 'sendMessage', 'sendPhoto']);
    assert.equal(sent[0].body.chat_id, 'u-lan');
    assert.match(sent[0].body.photo, /^https:\/\/cafe\.example\.test\/api\/zalo\/receipt\/[\w-]+\.[\w-]{22}\.png$/);
    assert.match(sent[1].body.text, /THANH TOÁN ĐƠN CF261014-00800[\s\S]*Số tiền: 50\.000đ[\s\S]*Vietcombank · 0123456789/);
    assert.match(sent[2].body.photo, /\/api\/zalo\/pay-qr\//);
    assert.deepEqual(receipts.at(-1), [800, null]);
    post.mock.restore();
  });

  await t.test('Zalo refuses the picture: the text bill goes out, the owner is told why, the order records it', async () => {
    sent.length = 0;
    const post = stub((method) => (method === 'sendPhoto' ? { status: 400, data: { ok: false, description: 'photo url unreachable', error_code: 400 } } : { status: 200, data: { ok: true, result: {} } }));
    const r = await receiptService.sendReceipt(800);
    assert.equal(r.sent, true);
    assert.equal(r.bill, 'text');
    assert.match(r.pictureError, /photo url unreachable/);
    assert.match(sent.find((s) => s.method === 'sendMessage').body.text, /HÓA ĐƠN CF261014-00800/);
    assert.match(receipts.at(-1)[1], /Đã gửi bill chữ: .*photo url unreachable/);
    post.mock.restore();

    const { sendReceipt } = receiptService;
    const adminOrders = require('../src/controllers/admin/orders');
    assert.equal(typeof adminOrders.resendReceipt, 'function');
    assert.equal(typeof sendReceipt, 'function');
  });

  await t.test('"Thu tiền" on a Zalo order: confirmation text, then the receipt picture marked paid', async () => {
    sent.length = 0;
    const post = stub();
    order.payment_status = 'paid';
    const status = await notify.notifyOrderPaid(800);
    assert.equal(status, 'sent');
    assert.deepEqual(sent.map((s) => s.method), ['sendMessage', 'sendPhoto']);
    assert.equal(sent[0].body.chat_id, 'u-lan');
    assert.match(sent[0].body.text, /ĐÃ NHẬN THANH TOÁN[\s\S]*Đơn: CF261014-00800[\s\S]*Số tiền: 50\.000đ[\s\S]*Hình thức: Chuyển khoản/);
    assert.match(sent[1].body.caption, /đã thanh toán/);
    order.payment_status = 'unpaid';
    post.mock.restore();
  });

  await t.test('nothing is sent for POS orders, unpaid orders, or when Zalo is not the channel', async () => {
    sent.length = 0;
    const post = stub();
    assert.equal(await notify.notifyOrderPaid(800), 'not_paid');
    order.source = 'pos';
    order.payment_status = 'paid';
    assert.equal(await notify.notifyOrderPaid(800), 'not_zalo');
    order.source = 'zalo';
    assert.deepEqual(sent, []);
    order.payment_status = 'unpaid';
    post.mock.restore();
  });

  await t.test('a Zalo outage never breaks "Thu tiền": failed, and the 4 s cap answers "pending"', async () => {
    sent.length = 0;
    order.payment_status = 'paid';
    let post = stub(() => ({ status: 500, data: { ok: false, description: 'down', error_code: 500 } }));
    assert.equal(await notify.notifyOrderPaid(800), 'failed');
    post.mock.restore();
    post = stub(() => new Promise((r) => setTimeout(() => r({ status: 200, data: { ok: true, result: {} } }), 150)));
    assert.equal(await notify.notifyOrderPaidSoon(800, 20), 'pending', 'the caller is not held up by a slow Zalo');
    await new Promise((r) => setTimeout(r, 400));   // the message still goes out in the background
    assert.ok(sent.some((s) => s.method === 'sendMessage'));
    post.mock.restore();
    order.payment_status = 'unpaid';
    assert.match(notify.describe('sent'), /Đã gửi xác nhận/);
    assert.match(notify.describe('failed'), /không thành công/);
    assert.equal(notify.describe('not_zalo'), '');
  });

  await t.test('debt collected: the linked customer is told the amount, the orders settled and what is still owed', async () => {
    sent.length = 0;
    const post = stub();
    const customer = { id: 5, name: 'Chị Lan', zalo_user_id: 'z-lan' };
    assert.equal(await notify.notifyDebtCollected({ customer, amount: 100000, balance: 266000, settled: ['CF-1'], method: 'cash' }), 'sent');
    assert.equal(sent[0].body.chat_id, 'z-lan');
    assert.match(sent[0].body.text, /ĐÃ NHẬN THANH TOÁN CÔNG NỢ[\s\S]*Chị Lan[\s\S]*100\.000đ \(Tiền mặt\)[\s\S]*Đơn đã tất toán: CF-1[\s\S]*Công nợ còn lại: 266\.000đ/);
    await notify.notifyDebtCollected({ customer, amount: 266000, balance: 0 });
    assert.match(sent[1].body.text, /hết công nợ/);
    assert.equal(await notify.notifyDebtCollected({ customer: { id: 6, name: 'Anh Nam' }, amount: 1, balance: 0 }), 'not_linked');
    assert.equal(sent.length, 2);
    post.mock.restore();
  });

  await t.test('webhook guard: registers when Zalo has no webhook / another URL / the secret changed, otherwise leaves it', async () => {
    const url = 'https://cafe.example.test/api/zalo/webhook';
    const calls = [];
    const info = mock.method(zaloBot, 'getWebhookInfo', async () => ({ url: '' }));
    const set = mock.method(zaloBot, 'setWebhook', async (u, s) => { calls.push([u, s]); return { url: u, verification: { ok: true } }; });
    SETTINGS.delete(guard.SETTING_KEY);

    assert.equal(await guard.ensure(), 'registered', 'no webhook on Zalo yet');
    assert.deepEqual(calls.at(-1), [url, 'platform-secret-123']);
    assert.equal(SETTINGS.get(guard.SETTING_KEY), guard.fingerprint(url, 'platform-secret-123'));

    info.mock.mockImplementation(async () => ({ url, secret_token: 'must-not-be-logged' }));
    assert.equal(await guard.ensure(), 'ok', 'same URL, same secret: nothing to do');
    assert.equal(calls.length, 1);

    SETTINGS.set(guard.SETTING_KEY, guard.fingerprint(url, 'the-old-secret'));
    assert.equal(await guard.ensure(), 'registered', 'the secret was changed in hPanel after the last registration');
    assert.equal(calls.length, 2);

    info.mock.mockImplementation(async () => ({ url: 'https://old.example.test/api/zalo/webhook' }));
    assert.equal(await guard.ensure(), 'registered', 'Zalo points at another address');
    info.mock.mockImplementation(async () => { throw new Error('Zalo Bot getWebhookInfo failed: boom'); });
    assert.equal(await guard.ensure({ force: true }), 'registered', 'an unreadable status does not stop the registration');
    set.mock.mockImplementation(async () => { throw new Error('Zalo Bot setWebhook failed: refused'); });
    assert.equal(await guard.ensure({ force: true }), 'failed');
    assert.deepEqual(guard.summarize({ url: 'u', secret_token: 's', x_token: 't', pending: 2 }), { url: 'u', pending: 2 }, 'no secret in the logs');
    info.mock.restore();
    set.mock.restore();
  });

  await t.test('webhook guard: a registration Zalo could not verify is NOT remembered, so the next boot tries again', async () => {
    const url = 'https://cafe.example.test/api/zalo/webhook';
    SETTINGS.delete(guard.SETTING_KEY);
    const info = mock.method(zaloBot, 'getWebhookInfo', async () => ({ url: '' }));
    let ok = false;
    const set = mock.method(zaloBot, 'setWebhook', async (u) => ({ url: u, verification: { ok, outcome: 'timeout', hint: 'unreachable' } }));
    assert.equal(await guard.ensure(), 'registered_unverified');
    assert.equal(SETTINGS.get(guard.SETTING_KEY), undefined, 'nothing remembered');
    ok = true;
    assert.equal(await guard.ensure(), 'registered', 'the next boot registers again');
    assert.equal(SETTINGS.get(guard.SETTING_KEY), guard.fingerprint(url, 'platform-secret-123'));
    info.mock.restore();
    set.mock.restore();
  });

  await t.test('"Gửi lại bill" twice at once: the second is refused, the customer gets ONE set; payment-info trouble is recorded on the order', async () => {
    sent.length = 0;
    bank();
    const post = stub(() => new Promise((r) => setTimeout(() => r({ status: 200, data: { ok: true, result: {} } }), 60)));
    const [a, b] = await Promise.all([receiptService.sendReceipt(800), receiptService.sendReceipt(800)]);
    assert.deepEqual([a.sent, b.sent], [true, false]);
    assert.match(b.error, /Đang gửi bill/);
    assert.equal(sent.filter((x) => x.method === 'sendPhoto').length, 2, 'one receipt picture + one QR, not two sets');
    post.mock.restore();

    receipts.length = 0;
    const failing = stub((method, body) => ((method === 'sendMessage' && /THANH TOÁN ĐƠN/.test(body.text)) ? { status: 500, data: { ok: false, description: 'down', error_code: 500 } } : { status: 200, data: { ok: true, result: {} } }));
    const r = await receiptService.sendReceipt(800);
    assert.equal(r.bill, 'picture');
    assert.match(receipts.at(-1)[1], /Đã gửi bill, chưa gửi được thông tin thanh toán/);
    failing.mock.restore();
    SETTINGS.delete('chatbot.bankBin');
    SETTINGS.delete('chatbot.bankAccount');
  });

  await t.test('sendTextBill: the plain text bill only (the OA fallback), recorded as delivered', async () => {
    sent.length = 0;
    receipts.length = 0;
    const post = stub();
    await receiptService.sendTextBill(800);
    assert.deepEqual(sent.map((x) => x.method), ['sendMessage']);
    assert.match(sent[0].body.text, /HÓA ĐƠN CF261014-00800/);
    assert.deepEqual(receipts.at(-1), [800, null]);
    post.mock.restore();
  });

  await t.test('webhook guard stays out of the way: other modes and non-https addresses', async () => {
    const real = zaloConfig.get;
    const cfg = mock.method(zaloConfig, 'get', async () => ({ mode: 'bot', botToken: '', botWebhookSecret: 's' }));
    assert.equal(await guard.ensure(), 'not_platform');
    cfg.mock.mockImplementation(async () => ({ mode: 'platform', botToken: 't', botWebhookSecret: 'short' }));
    assert.equal(await guard.ensure(), 'no_secret');
    cfg.mock.restore();
    assert.equal(typeof real, 'function');
  });
});

test('menu aliases top-up', async (t) => {
  const { applyExtraAliases, ensureMenuAliases, EXTRA_ALIASES } = require('../src/config/menuSeed');
  const { normalize } = require('../src/utils/text');
  const { pool } = require('../src/config/db');

  const makeConn = ({ settings = [{ setting_key: 'seed.menu_v1', setting_value: '{"created":56}' }], aliases = ['ca phe den'] } = {}) => {
    const inserted = [];
    const log = [];
    return {
      inserted, log,
      query: async (sql, params) => {
        log.push(sql.split(/\s+/).slice(0, 3).join(' '));
        if (/FROM products/.test(sql)) return [[{ id: 1, name: 'Cà Phê Đen Pha Máy' }, { id: 2, name: 'Cà Phê Sữa Pha Máy' }, { id: 3, name: 'Nước Ép Cam' }, { id: 4, name: 'Bò Cụng (RedBull)' }]];
        if (/SELECT alias_norm FROM product_aliases/.test(sql)) return [aliases.map((alias_norm) => ({ alias_norm }))];
        if (/INSERT INTO product_aliases/.test(sql)) { inserted.push([params[0], params[1]]); return [{}]; }
        if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]];
        if (/FROM app_settings/.test(sql)) return [settings];
        return [{}];
      },
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    };
  };

  await t.test('adds only aliases that are free, to products that exist', async () => {
    const conn = makeConn({ aliases: ['ca phe den', 'den da'] });   // "đen đá" is already taken by someone
    const added = await applyExtraAliases(conn);
    const names = conn.inserted.map(([id, alias]) => `${id}:${normalize(alias)}`);
    assert.ok(names.includes('1:den nong'));
    assert.ok(!names.includes('1:den da'), 'an existing alias is never moved');
    assert.ok(names.includes('2:cf nau') && names.includes('3:ep cam') && names.includes('4:bo cung') && names.includes('4:redbull'));
    for (const bare of ['1:den', '2:nau', '2:sua', '2:sua da', '4:nuoc ngot']) assert.ok(!names.includes(bare), `${bare}: a bare common word is never an alias`);
    assert.equal(added, conn.inserted.length);
    assert.ok(conn.inserted.every(([id]) => [1, 2, 3, 4].includes(id)), 'products missing from the database are skipped');
    assert.ok(Object.keys(EXTRA_ALIASES).length > 10);
  });

  await t.test('once per database; never on a database that started empty; never throws', async () => {
    const run = async (opts) => {
      const conn = makeConn(opts);
      const m = mock.method(pool, 'getConnection', async () => conn);
      try { return { state: await ensureMenuAliases(), conn }; } finally { m.mock.restore(); }
    };
    const first = await run();
    assert.equal(first.state, 'applied');
    assert.ok(first.conn.inserted.length > 0);
    assert.equal((await run({ settings: [{ setting_key: 'seed.menu_v1', setting_value: '{}' }, { setting_key: 'seed.aliases_v3', setting_value: '{"added":42}' }] })).state, 'done-before');
    assert.equal((await run({ settings: [{ setting_key: 'seed.menu_v1', setting_value: '"skipped-empty"' }] })).state, 'no-printed-menu');
    assert.equal((await run({ settings: [] })).state, 'no-printed-menu');
    const m = mock.method(pool, 'getConnection', async () => { throw new Error('db down'); });
    assert.equal(await ensureMenuAliases(), 'failed');
    m.mock.restore();
  });
});

test('a keyword held by another product is explained, and nothing is deleted first', async () => {
  const productModel = require('../src/models/productModel');
  const queries = [];
  const conn = {
    query: async (sql, params) => {
      queries.push(sql.replace(/\s+/g, ' ').slice(0, 40));
      if (/FROM product_aliases a JOIN products p/.test(sql)) return [[{ alias: 'pepsi', name: 'Nước Ngọt Các Loại' }]];
      return [{}];
    },
  };
  await assert.rejects(productModel.setAliases(9, 'Pepsi Lon', ['pepsi'], conn), (e) => e.status === 409 && /"pepsi" đang thuộc món "Nước Ngọt Các Loại"/.test(e.message));
  assert.ok(!queries.some((q) => /^DELETE/.test(q)), 'the old keywords stay when the new ones are refused');
});
