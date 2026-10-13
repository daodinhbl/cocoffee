/**
 * Zalo personal-account Bot Client webhook (ZALO_MODE=bot): auth, payload validation, idempotency, and the
 * reply contract. The conversation core is exercised for real (parser, draft, confirm) with the database
 * layer replaced by in-memory fakes.
 */
process.env.FNB_NO_LISTEN = '1';
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
process.env.ZALO_MODE = 'bot';
process.env.BOT_WEBHOOK_SECRET = 'test-bot-secret-0123456789';
process.env.DEMO_MODE = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mock } = require('node:test');

test('bot webhook', async (t) => {
  const db = require('../src/config/db');
  const productModel = require('../src/models/productModel');
  const orderModel = require('../src/models/orderModel');
  const orderService = require('../src/services/orderService');
  const { sessionModel, eventModel } = require('../src/models/zaloModel');

  // ---- fakes -----------------------------------------------------------------------------------------
  const events = new Set();
  mock.method(eventModel, 'insertIfNew', async ({ key }) => { if (events.has(key)) return false; events.add(key); return true; });
  mock.method(eventModel, 'mark', async () => {});
  mock.method(db, 'withTransaction', async (fn) => fn({}));
  mock.method(productModel, 'listForMatching', async () => [
    { id: 2, name: 'Cà phê sữa đá', price: 25000, category_name: 'Đồ uống', keywords: new Set(['ca phe sua da', 'cafe sua', 'cf sua']) },
    { id: 3, name: 'Bạc xỉu', price: 29000, category_name: 'Đồ uống', keywords: new Set(['bac xiu']) },
  ]);
  const sessions = new Map();
  const skey = ({ chatType, chatId, userId }) => `${chatType}:${chatId}:${userId}`;
  mock.method(sessionModel, 'lockOrCreate', async (_c, k) => { if (!sessions.has(skey(k))) sessions.set(skey(k), { id: sessions.size + 1, draft_order_id: null, is_expired: 0 }); return sessions.get(skey(k)); });
  mock.method(sessionModel, 'find', async (_c, k) => sessions.get(skey(k)) || null);
  mock.method(sessionModel, 'setDraft', async (_c, id, orderId) => { for (const s of sessions.values()) if (s.id === id) s.draft_order_id = orderId; });
  mock.method(sessionModel, 'clearDraft', async (_c, id) => { for (const s of sessions.values()) if (s.id === id) s.draft_order_id = null; });

  const orders = new Map();
  let confirmed = [];
  mock.method(orderService, 'upsertZaloDraft', async (_c, { items }) => {
    const id = 100 + orders.size;
    const lines = items.map((i) => ({ product_name: i.productId === 2 ? 'Cà phê sữa đá' : 'Bạc xỉu', quantity: i.quantity, line_total: (i.productId === 2 ? 25000 : 29000) * i.quantity, unit_price: i.productId === 2 ? 25000 : 29000 }));
    orders.set(id, { id, order_code: `CF261013-00${id}`, total: lines.reduce((s, l) => s + l.line_total, 0), subtotal: 0, discount: 0, items: lines, status: 'draft', payment_status: 'unpaid', created_at: new Date() });
    return id;
  });
  mock.method(orderService, 'getWithItems', async (id) => orders.get(id));
  mock.method(orderService, 'confirmDraft', async (_c, id) => { orders.get(id).status = 'completed'; orders.get(id).completed_at = new Date(); confirmed.push(id); return orders.get(id); });
  mock.method(orderService, 'cancelDraft', async (_c, id) => { orders.get(id).status = 'cancelled'; });
  mock.method(orderModel, 'getById', async (id) => orders.get(id));
  mock.method(orderModel, 'getItems', async (id) => orders.get(id).items);
  mock.method(orderModel, 'markReceipt', async () => {});

  const app = require('../app');
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/zalo/webhook`;
  const send = (body, auth = 'Bearer test-bot-secret-0123456789') => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body),
  });

  await t.test('rejects a missing or wrong secret, and incomplete payloads', async () => {
    assert.equal((await send({ senderId: 'u1', message: 'hi' }, null)).status, 401);
    assert.equal((await send({ senderId: 'u1', message: 'hi' }, 'Bearer nope')).status, 401);
    assert.equal((await send({ senderId: 'u1', message: 'hi' }, 'test-bot-secret-0123456789')).status, 401, 'Bearer scheme required');
    assert.equal((await send({ message: 'hi' })).status, 400);
    assert.equal((await send({ senderId: 'u1', message: '   ' })).status, 400);
  });

  await t.test('group: items -> draft summary; chatter -> silent; "ok" -> bill text in the replies', async () => {
    let r = await send({ groupId: 'g1', senderId: 'u1', senderName: 'Lan', message: '2 cà phê sữa đá, 1 bạc xỉu', messageId: 'm1' });
    let j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.action, 'draft');
    assert.equal(j.replies.length, 1);
    assert.match(j.replies[0].text, /ĐƠN TẠM/);
    assert.match(j.replies[0].text, /2 x Cà phê sữa đá/);
    assert.deepEqual(j.chat, { groupId: 'g1', senderId: 'u1' });

    j = await (await send({ groupId: 'g1', senderId: 'u2', message: 'hôm nay trời đẹp quá', messageId: 'm2' })).json();
    assert.deepEqual([j.action, j.replies.length], ['ignored', 0]);

    j = await (await send({ groupId: 'g1', senderId: 'u2', message: 'ok', messageId: 'm3' })).json();
    assert.deepEqual([j.action, j.replies.length], ['ignored', 0], "another member's ok does not confirm Lan's draft");
    assert.equal(confirmed.length, 0);

    j = await (await send({ groupId: 'g1', senderId: 'u1', message: 'oke', messageId: 'm4' })).json();
    assert.equal(j.action, 'confirmed');
    assert.equal(confirmed.length, 1);
    assert.match(j.replies[0].text, /HÓA ĐƠN CF261013-00100/);
    assert.match(j.replies[0].text, /TỔNG CỘNG: 79\.000đ/);
  });

  await t.test('a retried messageId is answered once only (no double order / double confirm)', async () => {
    const before = orders.size;
    const a = await (await send({ senderId: 'u9', message: '1 bạc xỉu', messageId: 'dup-1' })).json();
    const b = await (await send({ senderId: 'u9', message: '1 bạc xỉu', messageId: 'dup-1' })).json();
    assert.equal(a.action, 'draft');
    assert.deepEqual([b.duplicate, b.replies.length], [true, 0]);
    assert.equal(orders.size, before + 1);
  });

  await t.test('private chat (no groupId): unknown text gets a pointer to the menu', async () => {
    const j = await (await send({ senderId: 'u7', message: 'xin chào', messageId: 'p1' })).json();
    assert.equal(j.action, 'help');
    assert.match(j.replies[0].text, /menu/);
  });

  await t.test('GET ping reports bot mode', async () => {
    assert.deepEqual(await (await fetch(url)).json(), { ok: true, mode: 'bot' });
  });
});
