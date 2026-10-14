/**
 * Chatbot additions: drink options on order lines, "check nợ" with a VietQR code, FAQ answers from the shop's
 * settings, and pictures in replies. Pure parts are tested directly; the conversation runs for real through the
 * Bot Client webhook with the database layer replaced by in-memory fakes.
 */
process.env.FNB_NO_LISTEN = '1';
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
process.env.ZALO_MODE = 'bot';
process.env.ZALO_BOT_TOKEN = '';
process.env.BOT_WEBHOOK_SECRET = 'test-bot-secret-0123456789';
process.env.PUBLIC_BASE_URL = 'https://cafe.example.test';
process.env.DEMO_MODE = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mock } = require('node:test');

const vietQr = require('../src/services/vietQr');
const parser = require('../src/webhooks/zalo/zaloOrderParser');
const debtQr = require('../src/services/zalo/debtQr');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('VietQR payload', async (t) => {
  await t.test('matches a published static code byte for byte (Techcombank, CRC 34A0)', () => {
    assert.equal(vietQr.payload({ bin: '970407', account: '9602091996' }),
      '00020101021138540010A00000072701240006970407011096020919960208QRIBFTTA53037045802VN630434A0');
  });
  await t.test('with an amount: dynamic code, tag 54, ASCII transfer content, valid CRC', () => {
    const p = vietQr.payload({ bin: '970436', account: '0123456789', amount: 366000.4, note: 'Nợ KH5 — Cò!' });
    assert.match(p, /^000201010212/);
    assert.ok(p.includes('5406366000'));
    assert.ok(p.includes('62130809No KH5 Co'), 'tag 62 / 08 with the accent-free content');
    assert.equal(p.slice(-4), vietQr.crc16(p.slice(0, -4)));
  });
  await t.test('rejects a malformed bank or account', () => {
    assert.throws(() => vietQr.payload({ bin: '97043', account: '0123456789' }));
    assert.throws(() => vietQr.payload({ bin: '970436', account: '01-23' }));
  });
  await t.test('renders a PNG', async () => {
    const buf = await vietQr.png(vietQr.payload({ bin: '970436', account: '0123456789', amount: 1000 }));
    assert.deepEqual(buf.subarray(0, 4), PNG_MAGIC);
  });
});

test('parser: drink options, debt and FAQ questions', async (t) => {
  const catalog = [
    { id: 2, name: 'Cà Phê Sữa', price: 20000, keywords: new Set(['ca phe sua', 'cafe sua', 'cf sua', 'ca phe sua da', 'nau da']) },
    { id: 3, name: 'Bạc Xỉu', price: 22000, keywords: new Set(['bac xiu']) },
    { id: 4, name: 'Trà Đào', price: 25000, keywords: new Set(['tra dao']) },
  ];
  await t.test('options become the line note; same drink + same options merge, other options stay apart', () => {
    const r = parser.parseOrder('1 cafe sữa đá ít đường, 1 cf sữa không đá, 1 cà phê sữa ít đường, 2 bạc xỉu ít đá size L', catalog);
    assert.deepEqual(r.items.map((i) => [i.productId, i.quantity, i.note]), [[2, 2, 'ít đường'], [2, 1, 'không đá'], [3, 2, 'ít đá, size L']]);
    assert.deepEqual(parser.parseOrder('cho mình 3 ly trà đào nhiều đá nha', catalog).items.map((i) => [i.quantity, i.note]), [[3, 'nhiều đá']]);
    assert.deepEqual(parser.parseOrder('1 nâu đá đá riêng', catalog).items.map((i) => [i.productId, i.note]), [[2, 'đá riêng']]);
    assert.equal(parser.parseOrder('2 cà phê sữa đá k đường', catalog).items[0].note, 'không đường');
    assert.equal(parser.parseOrder('1 bạc xỉu', catalog).items[0].note, '');
  });
  await t.test('"check nợ" and friends, but not orders that mention debt', () => {
    for (const s of ['check nợ', 'Check nợ của mình', 'xem công nợ', 'công nợ', 'kiểm tra nợ nha', 'tra nợ', 'sổ nợ', 'mình còn nợ bao nhiêu vậy', 'em nợ shop bao nhiêu']) {
      assert.equal(parser.detectCommand(s), 'debt', s);
    }
    for (const s of ['nợ', 'ghi nợ giúp mình 1 bạc xỉu', 'nợ 2 ly nhé', 'nợ nần gì đâu', 'ok']) assert.notEqual(parser.detectCommand(s), 'debt', s);
  });
  await t.test('FAQ questions and mentions', () => {
    assert.equal(parser.detectFaq('quán ở đâu vậy'), 'address');
    assert.equal(parser.detectFaq('pass wifi là gì'), 'wifi');
    assert.equal(parser.detectFaq('cho xin stk'), 'bank');
    assert.equal(parser.detectFaq('mấy giờ mở cửa'), 'hours');
    assert.equal(parser.detectFaq('1 bạc xỉu'), null);
    assert.equal(parser.isMentioned('[@123] pass wifi?'), true);
    assert.equal(parser.isMentioned('@CoCoffee pass wifi?'), true);
    assert.equal(parser.isMentioned('pass wifi?'), false);
  });
});

test('signed QR links', () => {
  const now = Date.now();
  const token = debtQr.sign({ customerId: 5, amount: 366000 }, now);
  assert.deepEqual(debtQr.verify(token, now + 1000), { customerId: 5, amount: 366000 });
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ c: 5, a: 1000, e: now + 1e9 })).toString('base64url');
  assert.equal(debtQr.verify(`${forged}.${sig}`, now), null, 'edited amount');
  assert.equal(debtQr.verify(`${body}.${'A'.repeat(22)}`, now), null, 'wrong signature');
  assert.equal(debtQr.verify(token, now + debtQr.TTL_MS + 1), null, 'expired');
  assert.equal(debtQr.verify('../../etc/passwd', now), null);
});

test('chatbot through the Bot Client webhook', async (t) => {
  const db = require('../src/config/db');
  const productModel = require('../src/models/productModel');
  const orderService = require('../src/services/orderService');
  const customerModel = require('../src/models/customerModel');
  const settingsModel = require('../src/models/settingsModel');
  const { sessionModel, eventModel } = require('../src/models/zaloModel');

  const events = new Set();
  mock.method(eventModel, 'insertIfNew', async ({ key }) => { if (events.has(key)) return false; events.add(key); return true; });
  mock.method(eventModel, 'mark', async () => {});
  mock.method(db, 'withTransaction', async (fn) => fn({}));
  mock.method(productModel, 'listForMatching', async () => [
    { id: 2, name: 'Cà Phê Sữa', price: 20000, category_name: 'Coffee', keywords: new Set(['ca phe sua', 'cafe sua', 'ca phe sua da']) },
  ]);
  const sessions = new Map();
  const skey = ({ chatType, chatId, userId }) => `${chatType}:${chatId}:${userId}`;
  mock.method(sessionModel, 'lockOrCreate', async (_c, x) => { if (!sessions.has(skey(x))) sessions.set(skey(x), { id: sessions.size + 1, draft_order_id: null, is_expired: 0 }); return sessions.get(skey(x)); });
  mock.method(sessionModel, 'setDraft', async () => {});
  const drafts = [];
  mock.method(orderService, 'upsertZaloDraft', async (_c, { items }) => { drafts.push(items); return 900; });
  mock.method(orderService, 'getWithItems', async () => ({
    id: 900, order_code: 'CF261014-00900', total: 40000,
    items: drafts.at(-1).map((i) => ({ product_name: 'Cà Phê Sữa', quantity: i.quantity, line_total: 20000 * i.quantity, note: i.note || null })),
  }));
  const CUSTOMERS = {
    'z-lan': { id: 5, name: 'Chị Lan', balance: 366000 },
    'z-paid': { id: 6, name: 'Anh Nam', balance: 0 },
  };
  mock.method(customerModel, 'findByZaloUser', async (z) => (CUSTOMERS[z] ? { id: CUSTOMERS[z].id } : null));
  mock.method(customerModel, 'getById', async (id) => Object.values(CUSTOMERS).find((c) => c.id === id) || null);
  const SETTINGS = new Map([['printer.shopAddress', '12 Lê Lợi, Q.1'], ['printer.shopPhone', '0909000111'], ['chatbot.wifi', 'CoCoffee / 12345678']]);
  mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries([...SETTINGS].filter(([k]) => k.startsWith(p))));

  const app = require('../app');
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  const say = async (message, { senderId = 'z-lan', groupId = null } = {}) => {
    const res = await fetch(`${base}/api/zalo/webhook`, {
      method: 'POST', headers: { Authorization: 'Bearer test-bot-secret-0123456789', 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderId, groupId, message, messageId: `m-${++n}` }),
    });
    assert.equal(res.status, 200);
    return res.json();
  };

  await t.test('without a bank account: balance only, no picture', async () => {
    const r = await say('check nợ');
    assert.equal(r.action, 'debt');
    assert.equal(r.replies.length, 1);
    assert.match(r.replies[0].text, /Chị Lan/);
    assert.match(r.replies[0].text, /366\.000đ/);
    assert.match(r.replies[0].text, /thanh toán tại quầy/);
  });

  await t.test('with a bank account: account line, transfer content and the VietQR picture (inline + signed URL)', async () => {
    SETTINGS.set('chatbot.bankBin', '970436').set('chatbot.bankAccount', '0123456789').set('chatbot.bankAccountName', 'NGUYEN VAN A');
    const r = await say('Mình còn nợ bao nhiêu vậy');
    assert.deepEqual(r.replies.map((x) => x.type), ['text', 'image']);
    assert.match(r.replies[0].text, /Vietcombank · 0123456789 · NGUYEN VAN A/);
    assert.match(r.replies[0].text, /Nội dung: NO KH5/);
    const img = r.replies[1];
    assert.equal(img.mime, 'image/png');
    assert.deepEqual(Buffer.from(img.base64, 'base64').subarray(0, 4), PNG_MAGIC);
    assert.match(img.caption, /366\.000đ/);
    assert.match(img.url, /^https:\/\/cafe\.example\.test\/api\/zalo\/qr\/[\w-]+\.[\w-]{22}\.png$/);

    const served = await fetch(base + new URL(img.url).pathname);    // what Zalo fetches for sendPhoto
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('cross-origin-resource-policy'), 'cross-origin', 'Zalo Web may show it straight from our URL');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.from(img.base64, 'base64'));
    assert.equal((await fetch(`${base}/api/zalo/qr/${'x'.repeat(30)}.${'y'.repeat(22)}.png`)).status, 404);
  });

  await t.test('never in a group, never for an unknown or settled customer', async () => {
    assert.match((await say('check nợ', { groupId: 'g1' })).replies[0].text, /nhắn riêng/);
    assert.match((await say('check nợ', { senderId: 'z-stranger' })).replies[0].text, /chưa được liên kết/);
    const paid = await say('check nợ', { senderId: 'z-paid' });
    assert.match(paid.replies[0].text, /không còn nợ/);
    assert.equal(paid.replies.length, 1);
  });

  await t.test('FAQ: private chat always, group only when the bot is mentioned, nothing when not filled in', async () => {
    assert.match((await say('quán ở đâu vậy')).replies[0].text, /12 Lê Lợi, Q\.1[\s\S]*0909000111/);
    assert.match((await say('pass wifi là gì')).replies[0].text, /CoCoffee \/ 12345678/);
    assert.match((await say('cho xin stk')).replies[0].text, /Vietcombank · 0123456789/);
    assert.equal((await say('pass wifi là gì', { groupId: 'g1' })).replies.length, 0, 'group chatter');
    assert.match((await say('[@bot] pass wifi là gì', { groupId: 'g1' })).replies[0].text, /12345678/);
    const hours = await say('mấy giờ mở cửa');
    assert.equal(hours.action, 'help', 'hours not filled in: falls back to the normal help');
  });

  await t.test('drink options reach the draft and its summary', async () => {
    const r = await say('2 cà phê sữa đá ít đường');
    assert.equal(r.action, 'draft');
    assert.deepEqual(drafts.at(-1).map((i) => [i.productId, i.quantity, i.note]), [[2, 2, 'ít đường']]);
    assert.match(r.replies[0].text, /2 x Cà Phê Sữa \(ít đường\)/);
  });
});
