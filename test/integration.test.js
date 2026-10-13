/**
 * End-to-end test against a REAL MySQL (schema.sql + seed.sql are re-applied), Zalo HTTP stubbed.
 * Opt-in because it DROPS all tables:
 *   RUN_INTEGRATION=1 DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=cocoffee_fnb_test DB_USER=.. DB_PASSWORD=.. \
 *   JWT_SECRET=.. ZALO_APP_ID=1111111111 ZALO_OA_SECRET_KEY=s ZALO_APP_SECRET_KEY=a \
 *   ZALO_BOOTSTRAP_REFRESH_TOKEN=boot npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const axios = require('axios');
const mysql = require('mysql2/promise');

const enabled = process.env.RUN_INTEGRATION === '1' && /_test$/.test(process.env.DB_NAME || '');
const suite = enabled ? test : test.skip;

suite('integration', async (t) => {
  const { computeMac } = require('../src/services/zalo/zaloSignature');
  const { pool } = require('../src/config/db');
  const app = require('../app');

  // ---- Zalo stub: records every outbound call ------------------------------------------------
  const zaloCalls = [];
  let refreshCount = 0;
  let failNextSendWithInvalidToken = false;
  axios.post = async (url, body, opts = {}) => {
    zaloCalls.push({ url, body, headers: opts.headers });
    if (url.includes('oauth.zaloapp.com')) {
      refreshCount += 1;
      return { data: { access_token: `access-${refreshCount}`, refresh_token: `refresh-${refreshCount}`, expires_in: '90000' } };
    }
    if (failNextSendWithInvalidToken) { failNextSendWithInvalidToken = false; return { data: { error: -216, message: 'invalid token' } }; }
    return { data: { error: 0, message: 'Success', data: { message_id: 'm1' } } };
  };
  const sends = () => zaloCalls.filter((c) => c.url.includes('openapi.zalo.me'));
  const lastText = () => sends().at(-1)?.body.message.text;

  // ---- fresh schema + seed -------------------------------------------------------------------
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, multipleStatements: true, charset: 'utf8mb4',
  });
  for (const f of ['schema.sql', 'seed.sql']) await admin.query(fs.readFileSync(path.join(__dirname, '..', 'database', f), 'utf8'));
  await admin.end();

  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });

  const appId = process.env.ZALO_APP_ID;
  const secret = process.env.ZALO_OA_SECRET_KEY;
  let seq = 0;
  const textEvent = (text, { user = 'U1', group = null } = {}) => ({
    app_id: appId, event_name: group ? 'user_send_group_text' : 'user_send_text',
    sender: { id: user }, recipient: { id: group || 'OA1' }, user_id_by_app: 'x',
    message: { text, msg_id: `msg-${++seq}` }, timestamp: String(Date.now()),
  });
  // `raw` is what goes on the wire; `signed` is what the signature covers (differs only to simulate tampering)
  const post = (event, { sign = true, raw = JSON.stringify(event), signed = raw } = {}) => fetch(`${base}/api/zalo/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sign ? { 'X-ZEvent-Signature': computeMac({ appId, rawBody: signed, timestamp: event.timestamp, oaSecretKey: secret }) } : {}) },
    body: raw,
  });
  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('waitFor timeout'); await settle(50); }
  };
  const one = async (sql, p = []) => (await pool.query(sql, p))[0][0];
  const stock = async (sku) => (await one('SELECT quantity_on_hand q FROM inventory_items WHERE sku = ?', [sku])).q;

  const api = async (method, url, body, token) => {
    const res = await fetch(`${base}/api${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  let token;
  await t.test('health + auth required (unknown /api routes do not leak without a token)', async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await api('GET', '/tables')).status, 401);
    assert.equal((await api('GET', '/nope')).status, 401);
    assert.equal((await fetch(`${base}/not-an-api-route`)).status, 404);
  });

  await t.test('login with the seeded admin/admin account', async () => {
    assert.equal((await api('POST', '/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
    const ok = await api('POST', '/auth/login', { username: 'admin', password: 'admin' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.role, 'admin');
    token = ok.body.token;
    assert.equal((await api('GET', '/tables', null, token)).body.tables.length, 10);
  });

  await t.test('webhook rejects bad / missing signature and wrong app', async () => {
    assert.equal((await post(textEvent('2 cf sua'), { sign: false })).status, 401);
    const ev = textEvent('2 cf sua');
    const raw = JSON.stringify(ev);
    assert.equal((await post(ev, { raw: raw.replace('cf sua', 'cf den'), signed: raw })).status, 401, 'tampered body');
    assert.equal((await post({ ...textEvent('x'), app_id: '999' })).status, 401);
    assert.equal(sends().length, 0);
  });

  await t.test('chat order -> DRAFT order + summary reply (first send triggers token bootstrap)', async () => {
    const res = await post(textEvent('2 cà phê sữa, 1 bạc xỉu, 1 pizza'));
    assert.equal(res.status, 200);
    await waitFor(() => sends().length === 1);
    const order = await one("SELECT * FROM orders WHERE status = 'draft'");
    assert.equal(order.source, 'zalo');
    assert.equal(order.zalo_user_id, 'U1');
    assert.equal(order.total, 79000);
    assert.equal(order.cogs_total, 0, 'COGS is only fixed at completion');
    assert.equal((await pool.query('SELECT COUNT(*) c FROM order_items WHERE order_id = ?', [order.id]))[0][0].c, 2);
    assert.match(lastText(), /ĐƠN TẠM/);
    assert.match(lastText(), /2 x Cà phê sữa đá/);
    assert.match(lastText(), /79\.000đ/);
    assert.match(lastText(), /"1 pizza"/, 'unmatched item is reported');
    assert.equal(sends()[0].url, 'https://openapi.zalo.me/v3.0/oa/message/cs');
    assert.deepEqual(sends()[0].body.recipient, { user_id: 'U1' });
    assert.equal(sends()[0].headers.access_token, 'access-1');
    assert.equal(refreshCount, 1);
    assert.equal(zaloCalls[0].body.includes('refresh_token=boot'), true, 'bootstrap refresh token used once');
    assert.equal(await stock('RM-ICE'), 40000, 'draft must not touch stock');
  });

  await t.test('Zalo retry of the same event is ignored (idempotent)', async () => {
    const ev = textEvent('1 trà đào');
    await post(ev); await waitFor(() => sends().length === 2);
    await post(ev); await post(ev); await settle();
    assert.equal(sends().length, 2, 'duplicates do not trigger more replies');
    assert.equal((await one('SELECT COUNT(*) c FROM zalo_events WHERE event_key = ?', [`user_send_text:${ev.message.msg_id}`])).c, 1);
    // that message REPLACED the draft: only 1 tra dao now
    const draft = await one("SELECT id, total FROM orders WHERE status = 'draft'");
    assert.equal(draft.total, 35000);
    // "them" appends
    await post(textEvent('thêm 2 bạc xỉu')); await waitFor(() => sends().length === 3);
    assert.equal((await one("SELECT total FROM orders WHERE status = 'draft'")).total, 35000 + 58000);
    // re-order the original basket for the next steps
    await post(textEvent('2 cf sua, 1 bac xiu')); await waitFor(() => sends().length === 4);
    assert.equal((await one("SELECT total FROM orders WHERE status = 'draft'")).total, 79000);
    assert.equal((await pool.query("SELECT COUNT(*) c FROM orders WHERE status = 'draft'"))[0][0].c, 1, 'one draft per session');
  });

  await t.test('"ok" -> COMPLETED + stock deducted (BOM) + COGS + receipt sent', async () => {
    await post(textEvent('Oke'));
    await waitFor(() => sends().length === 5);
    const order = await one("SELECT * FROM orders WHERE source = 'zalo' AND status = 'completed'");
    assert.ok(order, 'order completed');
    assert.equal(order.payment_status, 'unpaid');
    assert.equal(order.total, 79000);
    // 2 x cf sua (18g coffee, 30g condensed, 150g ice, 1 cup) + 1 x bac xiu (10g, 25g cond, 60ml fresh, 150g ice, 1 cup)
    assert.equal(await stock('RM-COFFEE'), 5000 - 46);
    assert.equal(await stock('RM-MILK-CON'), 4000 - 85);
    assert.equal(await stock('RM-MILK-FRS'), 6000 - 60);
    assert.equal(await stock('RM-ICE'), 40000 - 450);
    assert.equal(await stock('RM-CUP'), 500 - 3);
    // COGS = 2*(18*280+30*70+150*2+900) + (10*280+25*70+60*30+150*2+900) = 2*8340 + 7550
    assert.ok(Math.abs(order.cogs_total - 24230) < 0.01, `cogs ${order.cogs_total}`);
    const items = (await pool.query('SELECT unit_cogs, line_cogs FROM order_items WHERE order_id = ? ORDER BY id', [order.id]))[0];
    assert.ok(items.every((i) => i.unit_cogs > 0 && i.line_cogs > 0));
    assert.equal((await pool.query("SELECT COUNT(*) c FROM inventory_movements WHERE order_id = ? AND movement_type = 'sale'", [order.id]))[0][0].c, 5, 'one ledger row per distinct ingredient');
    assert.equal((await one('SELECT draft_order_id d, state FROM zalo_sessions WHERE zalo_user_id = ?', ['U1'])).d, null);

    const bill = lastText();
    assert.match(bill, /HÓA ĐƠN CF\d{6}-\d{5}/);
    assert.match(bill, /TỔNG CỘNG: 79\.000đ/);
    assert.match(bill, /Chưa thanh toán/);
    assert.ok((await one('SELECT receipt_sent_at r FROM orders WHERE id = ?', [order.id])).r, 'receipt_sent_at recorded');

    // a second "ok" has nothing to confirm and must not double-deduct
    await post(textEvent('ok')); await waitFor(() => sends().length === 6);
    assert.match(lastText(), /chưa có đơn nào/);
    assert.equal(await stock('RM-COFFEE'), 5000 - 46);
  });

  await t.test('insufficient stock => ROLLBACK: draft survives, stock + ledger untouched, customer told', async () => {
    await pool.query("UPDATE inventory_items SET quantity_on_hand = 1 WHERE sku = 'RM-CUP'");
    const ledgerBefore = (await one('SELECT COUNT(*) c FROM inventory_movements')).c;
    const coffeeBefore = await stock('RM-COFFEE');
    await post(textEvent('2 cf den', { user: 'U2' })); await waitFor(() => sends().length === 7);
    await post(textEvent('ok', { user: 'U2' })); await waitFor(() => sends().length === 8);
    assert.match(lastText(), /hết hàng|hết nguyên liệu/);
    assert.match(lastText(), /Cà phê đen đá/);
    const draft = await one("SELECT status FROM orders WHERE zalo_user_id = 'U2'");
    assert.equal(draft.status, 'draft', 'order stays a draft');
    assert.equal(await stock('RM-COFFEE'), coffeeBefore, 'nothing deducted');
    assert.equal(await stock('RM-CUP'), 1);
    assert.equal((await one('SELECT COUNT(*) c FROM inventory_movements')).c, ledgerBefore);
    // customer cancels the stuck draft
    await post(textEvent('huy', { user: 'U2' })); await waitFor(() => sends().length === 9);
    assert.equal((await one("SELECT status FROM orders WHERE zalo_user_id = 'U2'")).status, 'cancelled');
    await pool.query("UPDATE inventory_items SET quantity_on_hand = 497 WHERE sku = 'RM-CUP'");
  });

  await t.test('direct (1:1) products: cigarettes deduct one pack per unit', async () => {
    await post(textEvent('2 bao 555 va 1 lavie', { user: 'U3' })); await waitFor(() => sends().length === 10);
    await post(textEvent('ok', { user: 'U3' })); await waitFor(() => sends().length === 11);
    assert.equal(await stock('GD-555'), 58);
    assert.equal(await stock('GD-LAVIE'), 99);
    const o = await one("SELECT cogs_total, total FROM orders WHERE zalo_user_id = 'U3'");
    assert.equal(o.total, 2 * 45000 + 10000);
    assert.equal(o.cogs_total, 2 * 38000 + 4000);
  });

  await t.test('group chat: silent on chatter / stray "ok"; replies to the GROUP endpoint for orders', async () => {
    const n = sends().length;
    await post(textEvent('ok', { user: 'U9', group: 'G1' }));
    await post(textEvent('mọi người ăn gì chưa', { user: 'U9', group: 'G1' }));
    await settle(400);
    assert.equal(sends().length, n, 'no reply to group chatter');

    await post(textEvent('3 cf sua', { user: 'U9', group: 'G1' })); await waitFor(() => sends().length === n + 1);
    assert.equal(sends().at(-1).url, 'https://openapi.zalo.me/v3.0/oa/group/message');
    assert.deepEqual(sends().at(-1).body.recipient, { group_id: 'G1' });
    // another member saying "ok" does NOT confirm someone else's draft
    await post(textEvent('ok', { user: 'U8', group: 'G1' })); await settle(400);
    assert.equal(sends().length, n + 1);
    await post(textEvent('ok', { user: 'U9', group: 'G1' })); await waitFor(() => sends().length === n + 2);
    assert.match(lastText(), /HÓA ĐƠN/);
    assert.deepEqual(sends().at(-1).body.recipient, { group_id: 'G1' });
  });

  await t.test('own OA messages and unsupported events are logged as ignored, never answered', async () => {
    const n = sends().length;
    await post({ ...textEvent('2 cf sua', { group: 'G1' }), event_name: 'oa_send_group_text' });
    await post({ ...textEvent('x'), event_name: 'user_send_image' });
    await settle(400);
    assert.equal(sends().length, n);
    assert.ok((await one("SELECT COUNT(*) c FROM zalo_events WHERE status = 'ignored'")).c >= 2);
  });

  await t.test('expired draft is refused and cancelled', async () => {
    await post(textEvent('1 bac xiu', { user: 'U4' })); await waitFor(() => sends().length >= 1 && one("SELECT 1 x FROM orders WHERE zalo_user_id = 'U4' AND status = 'draft'"));
    await pool.query("UPDATE zalo_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE zalo_user_id = 'U4'");
    const n = sends().length;
    await post(textEvent('ok', { user: 'U4' })); await waitFor(() => sends().length === n + 1);
    assert.match(lastText(), /hết hạn/);
    assert.equal((await one("SELECT status FROM orders WHERE zalo_user_id = 'U4'")).status, 'cancelled');
  });

  await t.test('Zalo token expiry (-216) triggers exactly one refresh + retry; token persisted', async () => {
    const before = refreshCount;
    failNextSendWithInvalidToken = true;
    const n = sends().length;
    await post(textEvent('menu', { user: 'U5' })); await waitFor(() => sends().length === n + 2);
    assert.equal(refreshCount, before + 1);
    assert.equal(sends().at(-1).headers.access_token, `access-${refreshCount}`);
    assert.equal((await one('SELECT refresh_token r FROM zalo_tokens WHERE id = 1')).r, `refresh-${refreshCount}`, 'rotated refresh token stored');
    assert.match(lastText(), /THỰC ĐƠN/);
  });

  await t.test('REST: POS order on a table -> serving -> pay -> completed, stock deducted, table freed', async () => {
    const tables = (await api('GET', '/tables', null, token)).body.tables;
    const t1 = tables.find((x) => x.code === 'T01');
    const created = await api('POST', '/orders', { table_id: t1.id, items: [{ product_id: 6, quantity: 1 }, { product_id: 1, quantity: 2 }] }, token);
    assert.equal(created.status, 201);
    const order = created.body.order;
    assert.equal(order.total, 45000 + 40000);
    assert.equal((await one('SELECT status, current_order_id c FROM dining_tables WHERE id = ?', [t1.id])).c, order.id);

    const dup = await api('POST', '/orders', { table_id: t1.id, items: [] }, token);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'TABLE_OCCUPIED');

    assert.equal((await api('PUT', `/orders/${order.id}/items`, { items: [{ product_id: 6, quantity: 1 }] }, token)).body.order.total, 45000);
    const cigBefore = await stock('GD-555');
    const lowCash = await api('POST', `/orders/${order.id}/pay`, { method: 'cash', tendered: 1000 }, token);
    assert.equal(lowCash.status, 422);
    assert.equal(await stock('GD-555'), cigBefore, 'failed payment rolls back stock deduction');
    assert.equal((await one('SELECT status FROM orders WHERE id = ?', [order.id])).status, 'open');

    const paid = await api('POST', `/orders/${order.id}/pay`, { method: 'cash', tendered: 50000, discount: 5000 }, token);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.order.status, 'completed');
    assert.equal(paid.body.order.payment_status, 'paid');
    assert.equal(paid.body.order.total, 40000);
    assert.equal(paid.body.change, 10000);
    assert.equal(await stock('GD-555'), cigBefore - 1);
    assert.equal(paid.body.order.cogs_total, 38000);
    const table = await one('SELECT status, current_order_id c FROM dining_tables WHERE id = ?', [t1.id]);
    assert.deepEqual([table.status, table.c], ['available', null]);
    assert.equal((await api('POST', `/orders/${order.id}/pay`, { method: 'cash' }, token)).status, 409, 'cannot pay twice');
  });

  await t.test('REST: Zalo inbox polling query (drafts + completed-unpaid) exposes what the POS toast needs', async () => {
    await post(textEvent('1 trà đào', { user: 'U7' }));
    const drafts = await waitFor(async () => {
      const list = (await api('GET', '/orders?source=zalo&status=draft&limit=20', null, token)).body.orders;
      return list.length ? list : null;
    });
    assert.ok(drafts.every((o) => o.source === 'zalo' && o.status === 'draft' && o.zalo_user_id === 'U7'));
    const done = (await api('GET', '/orders?source=zalo&status=completed&limit=20', null, token)).body.orders;
    const u3 = done.find((o) => o.zalo_user_id === 'U3');
    assert.equal(u3.payment_status, 'unpaid');
    assert.ok('receipt_sent_at' in u3 && 'receipt_error' in u3 && u3.zalo_chat_type === 'user');
    assert.equal((await api('GET', '/orders?limit=2&offset=1', null, token)).body.orders.length, 2, 'LIMIT/OFFSET bind correctly');
    assert.equal((await api('GET', '/orders?status=bogus', null, token)).status, 400);
  });

  await t.test('REST: paying a completed-unpaid Zalo order records payment WITHOUT re-deducting stock', async () => {
    const zaloOrder = await one("SELECT id FROM orders WHERE zalo_user_id = 'U3'");
    const before = await stock('GD-555');
    const res = await api('POST', `/orders/${zaloOrder.id}/pay`, { method: 'transfer', reference: 'FT123' }, token);
    assert.equal(res.status, 200);
    assert.equal(res.body.order.payment_status, 'paid');
    assert.equal(await stock('GD-555'), before);
  });

  await t.test('REST: cancel open order frees the table; completed cannot be cancelled', async () => {
    const t2 = (await api('GET', '/tables', null, token)).body.tables.find((x) => x.code === 'T02');
    const o = (await api('POST', '/orders', { table_id: t2.id, items: [{ product_id: 2, quantity: 1 }] }, token)).body.order;
    assert.equal((await api('POST', `/orders/${o.id}/cancel`, null, token)).status, 200);
    assert.equal((await one('SELECT status FROM dining_tables WHERE id = ?', [t2.id])).status, 'available');
    const done = await one("SELECT id FROM orders WHERE status = 'completed' LIMIT 1");
    assert.equal((await api('POST', `/orders/${done.id}/cancel`, null, token)).status, 409);
  });

  await t.test('REST: inventory receive recalculates weighted-average cost; summary reports profit', async () => {
    const item = (await api('GET', '/inventory', null, token)).body.items.find((i) => i.sku === 'GD-555');
    const r = await api('POST', `/inventory/${item.id}/receive`, { quantity: 40, unit_cost: 40000 }, token);
    assert.equal(r.status, 200);
    const q = item.quantity_on_hand;
    assert.ok(Math.abs(r.body.avg_cost - (q * 38000 + 40 * 40000) / (q + 40)) < 0.01);
    assert.equal(r.body.quantity_on_hand, q + 40);
    const sum = await api('GET', '/orders/summary?from=2000-01-01&to=2100-01-01', null, token);
    assert.equal(sum.status, 200);
    assert.ok(sum.body.orders >= 4 && sum.body.revenue > 0 && sum.body.gross_profit === sum.body.revenue - sum.body.cogs);
    assert.equal((await api('GET', '/inventory?low=1', null, token)).status, 200);
  });

  await t.test('REST: product CRUD with recipe + chatbot aliases; cashier cannot write', async () => {
    const created = await api('POST', '/products', {
      category_id: 1, sku: 'MATCHA', name: 'Matcha đá xay', price: 45000, stock_mode: 'bom',
      recipe: [{ inventory_item_id: 3, quantity: 150 }, { inventory_item_id: 8, quantity: 1 }], aliases: ['matcha', 'ma cha'],
    }, token);
    assert.equal(created.status, 201);
    assert.equal(created.body.product.recipe.length, 2);
    assert.equal((await api('POST', '/products', { category_id: 1, sku: 'BAD', name: 'Bad', price: 1, stock_mode: 'bom' }, token)).status, 400, 'bom needs a recipe');
    assert.equal((await api('POST', '/products', { category_id: 2, sku: 'BAD2', name: 'Bad2', price: 1, stock_mode: 'direct' }, token)).status, 400, 'direct needs an inventory item');
    // new product is immediately orderable via chat (catalog cache invalidated)
    await post(textEvent('1 matcha', { user: 'U6' })); await waitFor(() => /Matcha đá xay/.test(lastText() || ''));

    await pool.query("INSERT INTO users (username, password_hash, full_name, role) SELECT 'cashier1', password_hash, 'C', 'cashier' FROM users WHERE username = 'admin'");
    const cashier = (await api('POST', '/auth/login', { username: 'cashier1', password: 'admin' })).body.token;
    assert.equal((await api('POST', '/products', { category_id: 1 }, cashier)).status, 403);
    assert.equal((await api('GET', '/products', null, cashier)).status, 200);
  });

  await t.test('REST: change-password replaces admin/admin', async () => {
    assert.equal((await api('POST', '/auth/change-password', { current_password: 'admin', new_password: 'short' }, token)).status, 400);
    assert.equal((await api('POST', '/auth/change-password', { current_password: 'nope', new_password: 'a-long-new-password' }, token)).status, 401);
    assert.equal((await api('POST', '/auth/change-password', { current_password: 'admin', new_password: 'a-long-new-password' }, token)).status, 200);
    assert.equal((await api('POST', '/auth/login', { username: 'admin', password: 'admin' })).status, 401);
    assert.equal((await api('POST', '/auth/login', { username: 'admin', password: 'a-long-new-password' })).status, 200);
  });

  await t.test('resend-receipt works for completed Zalo orders only', async () => {
    const zo = await one("SELECT id FROM orders WHERE zalo_user_id = 'U1' AND status = 'completed'");
    const n = sends().length;
    const r = await api('POST', `/orders/${zo.id}/resend-receipt`, null, (await api('POST', '/auth/login', { username: 'admin', password: 'a-long-new-password' })).body.token);
    assert.deepEqual(r.body, { sent: true });
    assert.equal(sends().length, n + 1);
  });
});
