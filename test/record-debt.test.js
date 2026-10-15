/**
 * "Ghi công nợ" for a Zalo order (customerService.recordOrderDebt), its web dialog on the order page, the "Ghi nợ"
 * dialog on the customers list and POST /api/admin/orders/:id/record-debt for the Android app. Data layer faked.
 */
process.env.FNB_NO_LISTEN = '1';
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { start, PASSWORD } = require('./helpers/adminFixture');

test('recordOrderDebt service', async (t) => {
  const { pool } = require('../src/config/db');
  const orderModel = require('../src/models/orderModel');
  const customerModel = require('../src/models/customerModel');
  const customerService = require('../src/services/customerService');

  const ledger = [];
  const linked = [];
  const created = [];
  const updated = [];
  let order;
  let owners;       // zalo id -> customer already owning it
  let customers;    // id -> { id, name, zalo_user_id }
  let nextId = 50;

  const conn = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql, params) => {
      if (/FROM customers WHERE id = \? FOR UPDATE/.test(sql)) return [customers[params[0]] ? [{ ...customers[params[0]] }] : []];
      if (/SUM\(amount\)/.test(sql)) return [[{ balance: ledger.reduce((s, e) => s + e.amount, 0) + 100000 }]];   // 100.000 owed before
      return [[]];
    },
  };
  mock.method(pool, 'getConnection', async () => conn);
  mock.method(orderModel, 'getById', async () => order);
  mock.method(customerModel, 'findByZaloUser', async (z) => owners[z] || null);
  mock.method(customerModel, 'linkOrder', async (orderId, customerId) => { linked.push([orderId, customerId]); });
  mock.method(customerModel, 'addEntry', async (e) => { ledger.push(e); });
  mock.method(customerModel, 'create', async (c) => { const id = nextId++; created.push(c); customers[id] = { id, name: c.name, zalo_user_id: c.zalo_user_id }; return id; });
  mock.method(customerModel, 'update', async (id, f) => { updated.push([id, f]); });

  const reset = () => {
    ledger.length = 0; linked.length = 0; created.length = 0; updated.length = 0;
    order = { id: 7, order_code: 'CF261014-00007', source: 'zalo', status: 'completed', payment_status: 'unpaid', customer_id: null, total: 79000, zalo_user_id: 'z-new' };
    owners = {};
    customers = { 5: { id: 5, name: 'Chị Lan', zalo_user_id: null }, 6: { id: 6, name: 'Anh Nam', zalo_user_id: 'z-nam' } };
  };

  await t.test('existing customer: order linked, ONE debt row of the order total, Zalo id of the order linked to them', async () => {
    reset();
    const r = await customerService.recordOrderDebt(7, { customerId: 5, userId: 1 });
    assert.deepEqual(linked, [[7, 5]]);
    assert.deepEqual(ledger, [{ customerId: 5, orderId: 7, type: 'debt', amount: 79000, note: 'Nợ đơn CF261014-00007', userId: 1 }]);
    assert.deepEqual(updated, [[5, { zalo_user_id: 'z-new' }]]);
    assert.deepEqual([r.amount, r.balance, r.linkedZalo, r.createdCustomer], [79000, 179000, true, false]);
    assert.deepEqual(r.customer, { id: 5, name: 'Chị Lan', zalo_user_id: 'z-new' });
    assert.equal(r.note, 'Nợ đơn CF261014-00007');
  });

  await t.test('linkZalo=false, a customer who has a Zalo id already, or an id owned by someone else: no relinking', async () => {
    reset();
    await customerService.recordOrderDebt(7, { customerId: 5, linkZalo: false });
    assert.deepEqual(updated, []);
    reset();
    const r = await customerService.recordOrderDebt(7, { customerId: 6 });
    assert.deepEqual(updated, []);
    assert.equal(r.linkedZalo, false);
    reset();
    owners['z-new'] = { id: 6 };                       // the order's Zalo account belongs to Anh Nam
    const r2 = await customerService.recordOrderDebt(7, { customerId: 5 });
    assert.deepEqual(updated, [], 'never steals a Zalo id');
    assert.equal(r2.linkedZalo, false);
  });

  await t.test('new customer: created with the order\'s Zalo id, then the debt is written for them', async () => {
    reset();
    const r = await customerService.recordOrderDebt(7, { newCustomer: { name: '  Chị Mai ', phone: '0909111222' }, userId: 2 });
    assert.deepEqual(created, [{ name: 'Chị Mai', phone: '0909111222', zalo_user_id: 'z-new', note: 'Tạo khi ghi nợ đơn CF261014-00007' }]);
    assert.deepEqual(linked, [[7, 50]]);
    assert.equal(ledger[0].customerId, 50);
    assert.deepEqual([r.createdCustomer, r.linkedZalo], [true, true]);
    assert.equal(r.customer.name, 'Chị Mai');
  });

  await t.test('a "new" customer whose Zalo account already has a customer reuses that customer (no duplicate)', async () => {
    reset();
    owners['z-new'] = { id: 6 };
    const r = await customerService.recordOrderDebt(7, { newCustomer: { name: 'Ai đó' } });
    assert.deepEqual(created, []);
    assert.equal(r.customer.id, 6);
    assert.equal(r.createdCustomer, false);
  });

  await t.test('refused: not a completed Zalo order, already paid, already on a ledger, 0đ, nobody chosen, unknown order/customer', async () => {
    const refuse = async (mutate, opts, code) => {
      reset(); mutate(order);
      await assert.rejects(customerService.recordOrderDebt(7, opts), (e) => e.code === code, code);
      assert.deepEqual(ledger, [], `${code}: nothing written`);
    };
    await refuse((o) => { o.source = 'pos'; }, { customerId: 5 }, 'NOT_APPLICABLE');
    await refuse((o) => { o.status = 'open'; }, { customerId: 5 }, 'NOT_APPLICABLE');
    await refuse((o) => { o.payment_status = 'paid'; }, { customerId: 5 }, 'ORDER_NOT_PAYABLE');
    await refuse((o) => { o.customer_id = 6; }, { customerId: 5 }, 'ALREADY_ON_LEDGER');
    await refuse((o) => { o.total = 0; }, { customerId: 5 }, 'VALIDATION');
    await refuse(() => {}, {}, 'VALIDATION');
    await refuse(() => {}, { newCustomer: { name: '   ' } }, 'VALIDATION');
    await refuse(() => {}, { customerId: 999 }, 'NOT_FOUND');
    reset(); order = null;
    await assert.rejects(customerService.recordOrderDebt(7, { customerId: 5 }), (e) => e.code === 'NOT_FOUND');
  });
});

test('"Ghi công nợ" and "Ghi nợ" on the web and in the app API', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const customerService = require('../src/services/customerService');
  const orderService = require('../src/services/orderService');
  const debtNotifications = require('../src/services/zalo/debtNotificationService');
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin, '/admin/orders/42');
  const lastFlash = async (path = '/admin/orders/42') => (await (await admin.get(path)).text());

  const record = mock.method(customerService, 'recordOrderDebt', async (id, opts) => ({
    order: { id, order_code: 'CF261013-00042' }, customer: { id: opts.customerId || 51, name: opts.customerId ? 'Chị Lan' : opts.newCustomer.name, zalo_user_id: 'z1' },
    amount: 79000, balance: 199000, note: 'Nợ đơn CF261013-00042', linkedZalo: true, createdCustomer: !opts.customerId,
  }));
  const notice = mock.method(debtNotifications, 'notifyIncrease', async () => ({ customer: 'sent', owner: 'not_configured' }));

  await t.test('order page (admin, Zalo, completed, unpaid, no customer): button + dialog listing customers', async () => {
    const getWithItems = orderService.getWithItems;
    const html = await lastFlash();
    assert.match(html, /data-modal-open="#debt-dialog"/);
    assert.match(html, /<dialog id="debt-dialog"[\s\S]*action="\/admin\/orders\/42\/record-debt"/);
    assert.match(html, /<option value="5">Chị Lan · 0909000111 · nợ 120\.000đ · đã có Zalo<\/option>/);
    assert.match(html, /name="new_name"/);
    assert.match(html, /name="link_zalo" value="1" checked/);
    assert.equal(typeof getWithItems, 'function');
  });

  await t.test('POST record-debt with an existing customer: service called, flash says what happened, Zalo notice sent', async () => {
    fx.calls.length = 0; record.mock.resetCalls(); notice.mock.resetCalls();
    const r = await admin.post('/admin/orders/42/record-debt', { _csrf: token, _back: '/admin/orders/42', customer_id: '5', new_name: '', link_zalo: ['0', '1'] });
    assert.equal(r.headers.get('location'), '/admin/orders/42');
    assert.deepEqual(record.mock.calls[0].arguments, [42, { customerId: 5, newCustomer: undefined, linkZalo: true, userId: 1 }]);
    assert.deepEqual(notice.mock.calls[0].arguments[0], { customer: { id: 5, name: 'Chị Lan', zalo_user_id: 'z1' }, amount: 79000, balance: 199000, note: 'Nợ đơn CF261013-00042' });
    const html = await lastFlash();
    assert.match(html, /Đã ghi công nợ 79\.000đ \(đơn CF261013-00042\) cho Chị Lan\. Số dư nợ 199\.000đ\./);
    assert.match(html, /Đã liên kết Zalo của đơn với khách\./);
    assert.match(html, /Đã gửi Zalo cho khách\./);
  });

  await t.test('POST with a new customer name (and "do not link"): new customer passed on', async () => {
    record.mock.resetCalls();
    await admin.post('/admin/orders/42/record-debt', { _csrf: token, _back: '/admin/orders/42', customer_id: '', new_name: 'Chị Mai', new_phone: '0909111222', link_zalo: '0' });
    assert.deepEqual(record.mock.calls[0].arguments[1], { customerId: null, newCustomer: { name: 'Chị Mai', phone: '0909111222' }, linkZalo: false, userId: 1 });
    assert.match(await lastFlash(), /cho Chị Mai \(khách mới\)/);
  });

  await t.test('customers list: "Ghi nợ" button per row, dialog posts an increase and stays on the list', async () => {
    const html = await (await admin.get('/admin/customers')).text();
    assert.match(html, /data-modal-open="#debt-add-dialog" data-action="\/admin\/customers\/5\/adjust" data-title="Ghi nợ · Chị Lan"/);
    assert.match(html, /<dialog id="debt-add-dialog"[\s\S]*name="direction" value="increase"[\s\S]*name="stay" value="1"[\s\S]*name="amount"[\s\S]*name="note"/);
    const customerService2 = require('../src/services/customerService');
    const adjust = mock.method(customerService2, 'adjust', async (id, o) => ({ balance: 170000, amount: o.amount, note: o.note, customer: { id, name: 'Chị Lan', zalo_user_id: 'z-1234' } }));
    const r = await admin.post('/admin/customers/5/adjust', { _csrf: token, _back: '/admin/customers', direction: 'increase', amount: '50000', note: 'lấy hàng chưa trả', stay: '1' });
    assert.equal(r.headers.get('location'), '/admin/customers', 'stays on the list');
    assert.deepEqual(adjust.mock.calls[0].arguments, [5, { amount: 50000, note: 'lấy hàng chưa trả', userId: 1 }]);
    const detail = await admin.post('/admin/customers/5/adjust', { _csrf: token, _back: '/admin/customers/5', direction: 'increase', amount: '1000', note: 'x' });
    assert.equal(detail.headers.get('location'), '/admin/customers/5', 'the detail page form still goes to the detail page');
    adjust.mock.restore();
  });

  await t.test('app API: POST /api/admin/orders/:id/record-debt (admin only)', async () => {
    const api = async (path, token, json) => {
      const res = await fetch(fx.base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(json) });
      return { status: res.status, body: await res.json() };
    };
    const login = async (u) => (await (await fetch(fx.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PASSWORD }) })).json()).token;
    const boss = await login('boss');
    const cashier = await login('thungan');
    record.mock.resetCalls();

    let r = await api('/api/admin/orders/42/record-debt', boss, { customer_id: 5 });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, {
      order_id: 42, customer: { id: 5, name: 'Chị Lan', zalo_user_id: 'z1' }, amount: 79000, balance: 199000, note: 'Nợ đơn CF261013-00042',
      linked_zalo: true, created_customer: false, notify: { customer: 'sent', owner: 'not_configured' },
    });
    assert.deepEqual(record.mock.calls[0].arguments, [42, { customerId: 5, newCustomer: undefined, linkZalo: true, userId: 1 }]);

    r = await api('/api/admin/orders/42/record-debt', boss, { new_customer: { name: 'Chị Mai', phone: '0909' }, link_zalo: false });
    assert.equal(r.status, 201);
    assert.equal(r.body.created_customer, true);
    assert.deepEqual(record.mock.calls[1].arguments[1], { customerId: null, newCustomer: { name: 'Chị Mai', phone: '0909' }, linkZalo: false, userId: 1 });

    assert.equal((await api('/api/admin/orders/42/record-debt', cashier, { customer_id: 5 })).status, 403, 'a cashier cannot put a debt on a customer');
    assert.equal((await api('/api/admin/orders/abc/record-debt', boss, { customer_id: 5 })).status, 400);
  });

  record.mock.restore();
  notice.mock.restore();
});
