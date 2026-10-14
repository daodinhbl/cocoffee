/**
 * Official Zalo Bot Platform mode: secret header, update parsing (PRIVATE / GROUP, @mention), ACK-then-process,
 * replies through sendMessage, bill after confirmation, idempotency, and the token never leaking into errors.
 */
process.env.FNB_NO_LISTEN = '1';
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
process.env.ZALO_MODE = '';
process.env.ZALO_BOT_TOKEN = '123456:SECRET-TOKEN';
process.env.BOT_WEBHOOK_SECRET = 'platform-secret-123';
process.env.PUBLIC_BASE_URL = 'https://cafe.example.test';   // sendPhoto needs a public picture URL
process.env.DEMO_MODE = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mock } = require('node:test');
const axios = require('axios');

test('zalo bot platform', async (t) => {
  const env = require('../src/config/env');
  assert.equal(env.zalo.mode, 'platform', 'a bot token selects platform mode');

  const db = require('../src/config/db');
  const productModel = require('../src/models/productModel');
  const orderModel = require('../src/models/orderModel');
  const orderService = require('../src/services/orderService');
  const { sessionModel, eventModel } = require('../src/models/zaloModel');
  const zaloBot = require('../src/services/zalo/zaloBotPlatform');

  const sent = [];
  mock.method(axios, 'post', async (url, body) => {
    const method = url.split('/').pop();
    sent.push({ url, method, body });
    if (body && body.chat_id === 'boom') return { status: 400, data: { ok: false, description: 'chat not found', error_code: 400 } };
    return { status: 200, data: { ok: true, result: { message_id: 'x' } } };
  });

  const events = new Set();
  mock.method(eventModel, 'insertIfNew', async ({ key }) => { if (events.has(key)) return false; events.add(key); return true; });
  const marks = [];
  mock.method(eventModel, 'mark', async (key, status) => { marks.push([key, status]); });
  mock.method(db, 'withTransaction', async (fn) => fn({}));
  mock.method(productModel, 'listForMatching', async () => [
    { id: 2, name: 'Cà phê sữa đá', price: 25000, category_name: 'Đồ uống', keywords: new Set(['ca phe sua da', 'cafe sua']) },
  ]);
  const sessions = new Map();
  const k = ({ chatType, chatId, userId }) => `${chatType}:${chatId}:${userId}`;
  mock.method(sessionModel, 'lockOrCreate', async (_c, x) => { if (!sessions.has(k(x))) sessions.set(k(x), { id: sessions.size + 1, draft_order_id: null, is_expired: 0 }); return sessions.get(k(x)); });
  mock.method(sessionModel, 'find', async (_c, x) => sessions.get(k(x)) || null);
  mock.method(sessionModel, 'setDraft', async (_c, id, orderId) => { for (const s of sessions.values()) if (s.id === id) s.draft_order_id = orderId; });
  mock.method(sessionModel, 'clearDraft', async (_c, id) => { for (const s of sessions.values()) if (s.id === id) s.draft_order_id = null; });
  const orders = new Map();
  mock.method(orderService, 'upsertZaloDraft', async (_c, { items }) => {
    const id = 500 + orders.size;
    const lines = items.map((i) => ({ product_name: 'Cà phê sữa đá', quantity: i.quantity, unit_price: 25000, line_total: 25000 * i.quantity }));
    orders.set(id, { id, order_code: `CF261013-00${id}`, total: lines.reduce((s, l) => s + l.line_total, 0), subtotal: 0, discount: 0, items: lines, status: 'draft', payment_status: 'unpaid', created_at: new Date() });
    return id;
  });
  mock.method(orderService, 'getWithItems', async (id) => orders.get(id));
  mock.method(orderService, 'confirmDraft', async (_c, id) => { orders.get(id).status = 'completed'; orders.get(id).completed_at = new Date(); });
  mock.method(orderModel, 'getById', async (id) => orders.get(id));
  mock.method(orderModel, 'getItems', async (id) => orders.get(id).items);
  mock.method(orderModel, 'markReceipt', async () => {});

  const app = require('../app');
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/zalo/webhook`;
  const update = (text, { chatType = 'PRIVATE', chatId = 'u1', from = 'u1', id, isBot = false } = {}) => ({
    ok: true,
    result: { event_name: 'message.text.received', message: { message_id: id, date: Date.now(), text, from: { id: from, display_name: 'Lan', is_bot: isBot }, chat: { id: chatId, chat_type: chatType } } },
  });
  const post = (body, secret = 'platform-secret-123') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-bot-api-secret-token': secret } : {}) }, body: JSON.stringify(body) });
  const settle = async (n) => { for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10)); };

  await t.test('secret header is required', async () => {
    assert.equal((await post(update('hi', { id: 'a0' }), null)).status, 401);
    assert.equal((await post(update('hi', { id: 'a0' }), 'wrong-secret')).status, 401);
  });

  await t.test('private: draft then "ok" -> two sendMessage calls (summary, bill) to chat.id', async () => {
    sent.length = 0;
    assert.equal((await post(update('2 cà phê sữa đá', { id: 'p1' }))).status, 200);
    await settle(1);
    assert.equal(sent[0].method, 'sendMessage');
    assert.equal(sent[0].body.chat_id, 'u1');
    assert.match(sent[0].body.text, /ĐƠN TẠM/);
    assert.match(sent[0].url, /bot123456:SECRET-TOKEN\/sendMessage$/);

    await post(update('ok', { id: 'p2' }));
    await settle(2);
    assert.match(sent[1].body.text, /HÓA ĐƠN CF261013-00500/);
  });

  await t.test('group: "@Bot 1 cafe sua" is understood; chatter and bot messages are ignored', async () => {
    sent.length = 0;
    await post(update('@CoCoffee 1 cafe sua', { chatType: 'GROUP', chatId: 'g9', from: 'u2', id: 'g1' }));
    await settle(1);
    assert.equal(sent[0].body.chat_id, 'g9');
    assert.match(sent[0].body.text, /1 x Cà phê sữa đá/);
    await post(update('chào cả nhà', { chatType: 'GROUP', chatId: 'g9', from: 'u3', id: 'g2' }));
    await post(update('2 cafe sua', { chatType: 'GROUP', chatId: 'g9', from: 'bot', id: 'g3', isBot: true }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sent.length, 1);
  });

  await t.test('a repeated message_id is processed once', async () => {
    sent.length = 0;
    await post(update('1 cafe sua', { chatId: 'u5', from: 'u5', id: 'd1' }));
    await post(update('1 cafe sua', { chatId: 'u5', from: 'u5', id: 'd1' }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sent.length, 1);
  });

  await t.test('"check nợ": balance with sendMessage, then the VietQR picture with sendPhoto (signed public URL)', async () => {
    const customerModel = require('../src/models/customerModel');
    const settingsModel = require('../src/models/settingsModel');
    mock.method(customerModel, 'findByZaloUser', async (z) => (z === 'z-lan' ? { id: 5 } : null));
    mock.method(customerModel, 'getById', async () => ({ id: 5, name: 'Chị Lan', balance: 366000 }));
    const SETTINGS = { 'chatbot.bankBin': '970436', 'chatbot.bankAccount': '0123456789', 'chatbot.wifi': 'CoCoffee / 12345678' };
    mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries(Object.entries(SETTINGS).filter(([k]) => k.startsWith(p))));

    sent.length = 0;
    await post(update('check nợ', { chatId: 'z-lan', from: 'z-lan', id: 'debt1' }));
    await settle(2);
    assert.deepEqual(sent.map((s) => s.method), ['sendMessage', 'sendPhoto']);
    assert.match(sent[0].body.text, /366\.000đ[\s\S]*Vietcombank · 0123456789[\s\S]*NO KH5/);
    assert.equal(sent[1].body.chat_id, 'z-lan');
    assert.match(sent[1].body.photo, /^https:\/\/cafe\.example\.test\/api\/zalo\/qr\/[\w-]+\.[\w-]{22}\.png$/);
    assert.match(sent[1].body.caption, /NO KH5/);

    sent.length = 0;                                                  // the "@Bot" prefix is stripped, but still counts
    await post(update('@CoCoffee pass wifi?', { chatType: 'GROUP', chatId: 'g9', from: 'u2', id: 'faq1' }));
    await post(update('pass wifi?', { chatType: 'GROUP', chatId: 'g9', from: 'u3', id: 'faq2' }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.text, /CoCoffee \/ 12345678/);
  });

  await t.test('API errors never contain the bot token', async () => {
    await assert.rejects(zaloBot.sendText('boom', 'x'), (err) => !String(err.message).includes('SECRET-TOKEN') && /chat not found/.test(err.message));
    assert.equal(zaloBot.chunks('a'.repeat(4500)).every((c) => c.length <= 2000), true);
  });
});
