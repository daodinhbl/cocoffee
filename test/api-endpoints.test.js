/**
 * JSON API endpoints added for the Android app (api.json "gaps"): paths, query parameters and snake_case response keys,
 * against the real Express app with the data layer faked (helpers/adminFixture.js). No MySQL.
 */
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const { start, PASSWORD } = require('./helpers/adminFixture');

test('API endpoints for the app', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  // guard: nothing in this file may reach a real database (a developer .env can point at one)
  const { pool } = require('../src/config/db');
  const realDb = mock.method(pool, 'query', async () => { throw new Error('test reached the real database'); });
  t.after(() => assert.equal(realDb.mock.callCount(), 0, 'no query reached the real pool'));

  const orderModel = require('../src/models/orderModel');
  const orderService = require('../src/services/orderService');
  const inventoryModel = require('../src/models/inventoryModel');
  const customerModel = require('../src/models/customerModel');
  const customerService = require('../src/services/customerService');
  const called = (name) => fx.calls.filter((c) => c.name === name);
  const reset = () => { fx.calls.length = 0; };
  const lastArgs = (fn) => fn.mock.calls.at(-1).arguments;

  async function api(method, path, { token, json } = {}) {
    const res = await fetch(fx.base + path, {
      method,
      headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }
  const login = async (username) => (await api('POST', '/api/auth/login', { json: { username, password: PASSWORD } })).body.token;
  const admin = await login('boss');
  const cashier = await login('thungan');
  const get = (path, token = admin) => api('GET', path, { token });

  await t.test('GET /api/zalo/status and /api/zalo/drafts (any staff)', async () => {
    const s = await get('/api/zalo/status', cashier);
    assert.equal(s.status, 200);
    assert.ok(['ok', 'warn', 'off', 'unknown'].includes(s.body.state));
    assert.equal(typeof s.body.label, 'string');
    assert.deepEqual((await get('/api/admin/zalo/status')).body, s.body);
    const d = await get('/api/zalo/drafts?limit=5', cashier);
    assert.equal(d.status, 200);
    assert.deepEqual(Object.keys(d.body.drafts[0]).sort(), ['chat_type', 'expires_at', 'id', 'last_activity_at', 'order_code', 'order_id', 'total']);
    assert.equal(d.body.drafts[0].order_code, 'CF-D');
    const adminModel = require('../src/models/adminModel');
    assert.equal(lastArgs(adminModel.zaloPendingDrafts)[0], 5);
  });

  await t.test('GET /api/sync/snapshot: POS data for staff, + inventory and customers for admins', async () => {
    const c = await get('/api/sync/snapshot', cashier);
    assert.equal(c.status, 200);
    assert.deepEqual(Object.keys(c.body).sort(), ['categories', 'drafts', 'generated_at', 'inventory', 'orders', 'printer', 'products', 'role', 'tables']);
    assert.equal(c.body.role, 'cashier');
    assert.equal(c.body.orders[0].items.length, 2, 'orders carry their lines');
    assert.ok(Array.isArray(c.body.orders[0].payments));
    assert.equal(c.body.customers, undefined, 'a cashier gets no customer list');
    assert.equal(c.body.inventory.stock_value, undefined);

    const a = await get('/api/sync/snapshot', admin);
    assert.equal(a.status, 200);
    assert.equal(a.body.role, 'admin');
    assert.equal(a.body.customers[0].name, 'Chị Lan');
    assert.equal(a.body.customer_stats.total_debt, 120000);
    assert.equal(a.body.ledgers[a.body.customers[0].id].length, 2, 'debt history of the customers');
    assert.equal(c.body.ledgers, undefined);
    assert.ok(a.body.inventory.items.length > 0);
    assert.equal(typeof a.body.inventory.stock_value, 'number');
    assert.equal((await api('GET', '/api/sync/snapshot')).status, 401);
  });

  await t.test('GET /api/pos/bootstrap (cashier)', async () => {
    const r = await get('/api/pos/bootstrap', cashier);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['categories', 'drafts', 'printer', 'products', 'tables', 'zalo']);
    assert.deepEqual(r.body.categories[0], { id: 1, code: 'mixed_drink', name: 'Đồ uống' });
    assert.deepEqual(Object.keys(r.body.products[0]).sort(), ['category_id', 'id', 'image_url', 'name', 'price']);
    assert.deepEqual(r.body.tables[0], { id: 1, code: 'B01', name: 'Bàn 1', status: 'serving', current_order_id: 42, current_order_total: null });
    assert.deepEqual(r.body.printer, { autoPrint: true, vatRate: 8, paperMm: 80 });
    assert.equal(r.body.drafts[0].order_code, 'CF-D');
    assert.ok(r.body.zalo.state);
  });

  await t.test('POST /api/pos/checkout and /api/pos/hold (cashier)', async () => {
    reset();
    const items = [{ product_id: 1, quantity: 2, note: 'ít đá' }];
    let r = await api('POST', '/api/pos/checkout', { token: cashier, json: { table_id: 2, items, method: 'cash', discount: 5000, tendered: 100000 } });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['change', 'order']);
    assert.equal(r.body.order.order_code, fx.ORDER.order_code);
    assert.deepEqual(called('order.createPos')[0].args[0].items, items, 'item notes reach the order');
    assert.deepEqual(called('order.pay')[0].args, [77, { method: 'cash', tendered: 100000, discount: 5000, userId: 2, isAdmin: false }]);

    reset();
    r = await api('POST', '/api/pos/checkout', { token: cashier, json: { items, method: 'other' } });
    assert.equal(r.status, 400, "no 'other' at the counter");
    r = await api('POST', '/api/pos/checkout', { token: cashier, json: { items: [{ product_id: 1, quantity: 1, note: 'x'.repeat(256) }], method: 'cash' } });
    assert.equal(r.status, 400, 'item note longer than 255');
    assert.equal(called('order.createPos').length, 0);

    const { AppError } = require('../src/utils/httpError');
    orderService.payOrder.mock.mockImplementationOnce(async () => { throw new AppError(422, 'INSUFFICIENT_PAYMENT', 'Tendered amount is less than total (79000)'); });
    reset();
    r = await api('POST', '/api/pos/checkout', { token: cashier, json: { items, method: 'cash', tendered: 1 } });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'INSUFFICIENT_PAYMENT');
    assert.equal(called('order.cancel')[0].args[0], 77, 'the order created for this checkout is cancelled');

    reset();
    r = await api('POST', '/api/pos/hold', { token: cashier, json: { items } });
    assert.equal(r.status, 400, 'hold needs a table');
    r = await api('POST', '/api/pos/hold', { token: cashier, json: { table_id: 2, items } });
    assert.equal(r.status, 200);
    assert.ok(r.body.order);
    assert.equal(called('order.pay').length, 0, 'hold never takes payment');

    const p = await get('/api/settings/printer', cashier);
    assert.equal(p.body.printer.paperMm, 80);
  });

  await t.test('GET /api/admin/notifications', async () => {
    const r = await get('/api/admin/notifications');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.counts, { drafts: 2, open_orders: 1, unpaid: 3 });
    assert.deepEqual(r.body.low_stock, [{ id: 2, name: 'Sữa tươi', unit: 'ml', quantity_on_hand: 420, min_stock: 500 }]);
    assert.deepEqual(Object.keys(r.body.receipt_errors[0]).sort(), ['completed_at', 'id', 'order_code', 'receipt_error']);
  });

  await t.test('GET /api/admin/dashboard', async () => {
    const r = await get('/api/admin/dashboard');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['best_sellers', 'counts', 'day', 'debtors', 'hourly', 'low_stock', 'low_stock_count', 'margin', 'overstock', 'recent_orders', 'today', 'yesterday']);
    assert.match(r.body.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(r.body.today, { orders: 3, revenue: 400000, cogs: 120000, gross_profit: 280000, unpaid: 79000 });
    assert.equal(r.body.margin, 70);
    assert.equal(r.body.hourly.length, 17);
    assert.deepEqual(r.body.hourly[3], { hour: 9, revenue: 300000, orders: 2 });
    assert.deepEqual(r.body.low_stock, [{ id: 2, name: 'Sữa tươi', unit: 'ml', quantity_on_hand: 420, min_stock: 500, ratio: 0.84 }]);
    assert.equal(r.body.low_stock_count, 1, 'every low item is counted, not only the 8 listed');
    assert.deepEqual(r.body.best_sellers, [{ product_id: 1, product_name: 'Cà phê sữa đá', qty: 12, revenue: 300000 }]);
    assert.deepEqual(r.body.overstock.map((o) => o.id), [1, 3, 2], 'biggest stock value first');
    assert.deepEqual(Object.keys(r.body.debtors[0]).sort(), ['amount', 'customer_id', 'customer_name', 'customer_phone', 'oldest', 'orders', 'zalo_user_id']);
    assert.equal(r.body.recent_orders[0].order_code, fx.ORDER.order_code);
  });

  await t.test('GET /api/admin/reports', async () => {
    const r = await get('/api/admin/reports?from=2026-10-01&to=2026-10-13');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.range, { from: '2026-10-01', to: '2026-10-13', clamped: false });
    assert.equal(r.body.days.length, 13);
    assert.deepEqual(r.body.days[12], { day: '2026-10-13', orders: 3, revenue: 400000, cogs: 120000 });
    assert.equal(r.body.hours.length, 24);
    assert.equal(r.body.avg_ticket, 400000 / 3);
    assert.deepEqual(r.body.by_payment[1], { method: 'unpaid', orders: 1, revenue: 100000 });
    assert.deepEqual(r.body.by_source[0], { source: 'pos', orders: 2, revenue: 300000, cogs: 90000 });
    assert.deepEqual(r.body.top_products[0], { product_id: 1, product_name: 'Cà phê sữa đá', qty: 12, revenue: 300000, cogs: 71280 });
    assert.deepEqual(r.body.presets.map((p) => p.key), ['today', 'yesterday', '7d', 'month', 'last_month']);
    assert.equal((await get('/api/admin/reports?from=2020-01-01&to=2026-10-13')).body.range.clamped, true);
  });

  await t.test('GET /api/orders: new filters, page, totals and per-status counts (old keys kept)', async () => {
    let r = await get('/api/orders?payment=unpaid&page=2', cashier);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['counts', 'orders', 'page', 'page_size', 'pages', 'total']);
    assert.equal(r.body.total, 60);
    assert.equal(r.body.page, 2);
    assert.equal(r.body.pages, 3);
    assert.equal(r.body.page_size, 25);
    assert.deepEqual(r.body.counts, { all: 60, draft: 2, open: 1, completed: 50, cancelled: 7, unpaid: 3, revenue: 4000000, unpaidAmount: 237000, openAmount: 79000 });
    let where = lastArgs(orderModel.list)[0];
    assert.equal(where.paymentStatus, 'unpaid');
    assert.deepEqual(where.excludeStatuses, ['cancelled', 'draft'], 'unpaid without a status = money still to collect');
    assert.equal(where.limit, 25);
    assert.equal(where.offset, 25);

    r = await get('/api/orders?status=completed&source=zalo&q=%20CF26%20&date_from=2026-10-01&date_to=2026-10-13&updated_after=2026-10-14T01:00:00Z');
    where = lastArgs(orderModel.list)[0];
    assert.equal(where.status, 'completed');
    assert.equal(where.excludeStatuses, undefined);
    assert.equal(where.q, 'CF26');
    assert.equal(where.from, '2026-10-01 00:00:00');
    assert.equal(where.to, '2026-10-14 00:00:00', 'date_to is inclusive');
    assert.equal(new Date(where.updatedAfter).toISOString(), '2026-10-14T01:00:00.000Z');
    assert.equal(lastArgs(orderModel.count)[0].from, '2026-10-01 00:00:00');

    r = await get('/api/orders?limit=2&offset=4', cashier);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.orders));
    assert.equal(r.body.page_size, 2);
    assert.equal(r.body.page, 3);
    where = lastArgs(orderModel.list)[0];
    assert.deepEqual([where.limit, where.offset], [2, 4]);

    for (const bad of ['date_from=2026-02-31', 'payment=maybe', 'status=bogus', 'page=0', 'updated_after=yesterday', 'from=a&from=b']) {
      assert.equal((await get(`/api/orders?${bad}`)).status, 400, bad);
    }
  });

  await t.test('GET /api/orders/:id?include=payments and /api/orders/:id/receipt', async () => {
    let r = await get('/api/orders/42', cashier);
    assert.deepEqual(Object.keys(r.body), ['order']);
    r = await get('/api/orders/42?include=payments');
    assert.deepEqual(Object.keys(r.body).sort(), ['order', 'payments']);
    assert.deepEqual(Object.keys(r.body.payments[0]).sort(), ['amount', 'id', 'method', 'paid_at', 'received_by_name', 'reference']);

    r = await get('/api/orders/42/receipt', cashier);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['order', 'payments', 'printer', 'shop_name', 'vat']);
    assert.equal(r.body.shop_name, require('../src/config/env').business.shopName);
    assert.ok(Math.abs(r.body.vat - (79000 - 79000 / 1.08)) < 1e-6);
    assert.equal(r.body.order.items.length, 2);

    orderService.getWithItems.mock.mockImplementationOnce(async () => ({ ...fx.ORDER, status: 'draft' }));
    r = await get('/api/orders/42/receipt', cashier);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'NOT_PRINTABLE');
  });

  await t.test('GET /api/tables?all=1 and the serving-table rule on PUT', async () => {
    reset();
    let r = await get('/api/tables?all=1');
    assert.equal(r.body.tables.length, 2);
    assert.equal(r.body.tables[0].is_active, 1);
    r = await api('PUT', '/api/tables/1', { token: admin, json: { is_active: false } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CONFLICT');
    assert.equal(called('table.update').length, 0);
    r = await api('PUT', '/api/tables/2', { token: admin, json: { is_active: '0' } });
    assert.equal(r.status, 200);
    assert.equal(called('table.update')[0].args[1].is_active, 0, "the string '0' means inactive");
  });

  await t.test('/api/admin/customers: list, detail, create, update', async () => {
    let r = await get('/api/admin/customers?q=Lan&debt=1&page=1');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['customers', 'page', 'page_size', 'pages', 'stats', 'total']);
    assert.equal(r.body.page_size, 25);
    assert.deepEqual(r.body.stats, { total_customers: 1, debt_customers: 1, total_debt: 120000 });
    assert.deepEqual(Object.keys(r.body.customers[0]).sort(), ['balance', 'created_at', 'id', 'name', 'note', 'order_count', 'phone', 'updated_at', 'zalo_user_id']);
    assert.deepEqual(lastArgs(customerModel.list)[0], { q: 'Lan', debtOnly: true, zaloOnly: false, limit: 25, offset: 0 });

    r = await get('/api/admin/customers/5');
    assert.deepEqual(Object.keys(r.body).sort(), ['customer', 'ledger', 'orders']);
    assert.equal(r.body.ledger.length, 2);
    assert.equal((await get('/api/admin/customers/6')).status, 404);

    reset();
    customerModel.create.mock.mockImplementationOnce(async () => 5);
    r = await api('POST', '/api/admin/customers', { token: admin, json: { name: ' Chị Lan ', phone: '0909000111' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.customer.id, 5);
    assert.deepEqual(lastArgs(customerModel.create)[0], { name: 'Chị Lan', phone: '0909000111', zalo_user_id: null, note: null });
    assert.equal((await api('POST', '/api/admin/customers', { token: admin, json: { phone: '1' } })).status, 400, 'name is required');

    customerModel.create.mock.mockImplementationOnce(async () => { throw Object.assign(new Error('dup'), { errno: 1062, sqlMessage: "Duplicate entry '0909' for key 'uq_customers_phone'" }); });
    r = await api('POST', '/api/admin/customers', { token: admin, json: { name: 'B', phone: '0909000111' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'DUPLICATE');
    assert.deepEqual(r.body.error.details, { field: 'phone' });

    r = await api('PUT', '/api/admin/customers/5', { token: admin, json: { name: 'Lan', phone: '', note: null } });
    assert.equal(r.status, 200);
    assert.deepEqual(lastArgs(customerModel.update)[1], { name: 'Lan', phone: null, note: null }, 'null or empty clears; absent fields stay');
    assert.equal((await api('PUT', '/api/admin/customers/6', { token: admin, json: { name: 'x' } })).status, 404);
  });

  await t.test('/api/admin/customers: collect, adjust, reconciliation, statement', async () => {
    reset();
    let r = await api('POST', '/api/admin/customers/5/collect', { token: admin, json: { amount: 50000, method: 'transfer', note: 'CK' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { amount: 50000, balance: 70000, settled: [fx.ORDER.order_code], zalo_notify: 'push_not_supported' });   // bot mode cannot push: the customer is not messaged
    assert.deepEqual(called('customer.collect')[0].args, [5, { amount: 50000, method: 'transfer', note: 'CK', userId: 1 }]);
    assert.equal((await api('POST', '/api/admin/customers/5/collect', { token: admin, json: { amount: 50000, method: 'bitcoin' } })).status, 400);
    assert.equal((await api('POST', '/api/admin/customers/5/collect', { token: admin, json: { amount: 0, method: 'cash' } })).status, 400);

    assert.equal((await api('POST', '/api/admin/customers/5/adjust', { token: admin, json: { amount: 1000, note: 'x' } })).status, 400, 'direction is required');
    customerService.adjust.mock.mockImplementationOnce(async (_id, a) => ({ balance: 150000, amount: a.amount, note: a.note, customer: { id: 5, name: 'Chị Lan', zalo_user_id: 'z-1234' } }));
    r = await api('POST', '/api/admin/customers/5/adjust', { token: admin, json: { amount: 30000, direction: 'increase', note: 'Nợ cũ' } });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['amount', 'balance', 'note', 'notify']);
    assert.equal(r.body.amount, 30000);
    assert.deepEqual(Object.keys(r.body.notify).sort(), ['customer', 'owner']);
    assert.ok(!JSON.stringify(r.body).includes('z-1234'), 'the Zalo id is not echoed');
    customerService.adjust.mock.mockImplementationOnce(async (_id, a) => ({ balance: 90000, amount: a.amount, note: a.note, customer: { id: 5, name: 'Chị Lan' } }));
    r = await api('POST', '/api/admin/customers/5/adjust', { token: admin, json: { amount: 30000, direction: 'decrease', note: 'Bớt' } });
    assert.equal(r.body.amount, -30000);
    assert.equal(r.body.notify, null);

    r = await get('/api/admin/customers/reconciliation?from=2026-10-13&to=2026-10-01&q=Lan');
    assert.equal(r.status, 200, 'declared before /customers/:id');
    assert.deepEqual(r.body.period, { from: '2026-10-01', to: '2026-10-13' }, 'a reversed range is swapped');
    assert.deepEqual(r.body.totals, { opening: 50000, increase: 100000, decrease: 30000, closing: 120000 });
    assert.deepEqual(r.body.presets.map((p) => p.key), ['month', 'last_month', 'year']);
    assert.deepEqual(lastArgs(customerModel.reconciliation).slice(0, 3), ['2026-10-01 00:00:00', '2026-10-14 00:00:00', { q: 'Lan' }]);

    r = await get('/api/admin/customers/5/statement?from=2026-10-01&to=2026-10-13');
    assert.deepEqual(Object.keys(r.body).sort(), ['closing', 'customer', 'decrease', 'entries', 'increase', 'opening', 'period', 'printer']);
    assert.equal(r.body.closing, 120000);
    assert.equal((await get('/api/admin/customers/6/statement')).status, 404);
  });

  await t.test('GET /api/admin/menu, /api/admin/bom and the photo endpoints', async () => {
    let r = await get('/api/admin/menu');
    assert.deepEqual(Object.keys(r.body).sort(), ['categories', 'items', 'products']);
    assert.deepEqual(r.body.products[0].aliases, ['Cà phê sữa đá', 'cf sữa']);
    assert.equal(r.body.items.length, 3);

    r = await get('/api/admin/bom');
    assert.deepEqual(Object.keys(r.body).sort(), ['catalog', 'categories', 'drinks', 'retail', 'stats']);
    assert.equal(r.body.drinks.length, 2);
    assert.equal(r.body.retail.length, 1);
    assert.equal(r.body.stats.missing, 1);
    assert.deepEqual(Object.keys(r.body.catalog[0]).sort(), ['active', 'id', 'name', 'unit', 'unitCost']);

    reset();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
    r = await api('PUT', '/api/admin/products/1/image', { token: admin, json: { image_data: `data:image/png;base64,${png.toString('base64')}` } });
    assert.equal(r.status, 200);
    assert.match(r.body.image_url, /^\/media\/\d+-ca-phe-sua-da\.png$/);
    assert.deepEqual(called('product.setImage')[0].args.slice(0, 2), [1, r.body.image_url]);
    assert.equal((await api('PUT', '/api/admin/products/1/image', { token: admin, json: { image_data: 'data:text/html;base64,AAAA' } })).status, 400);
    assert.equal((await api('PUT', '/api/admin/products/999/image', { token: admin, json: { image_data: `data:image/png;base64,${png.toString('base64')}` } })).status, 404);

    reset();
    r = await api('DELETE', '/api/admin/inventory/3/image', { token: admin });
    assert.deepEqual(r.body, { image_url: '' });
    assert.deepEqual(called('inventory.setImage')[0].args.slice(0, 2), [3, ''], "removed = '' (not NULL)");
    assert.equal(called('media.remove')[0].args[0], 900, 'the stored photo is deleted');
  });

  await t.test('API product/category writes follow the Web Admin rules (aliases, category code, recipe)', async () => {
    reset();
    const base = { category_id: 1, sku: 'MC', name: 'Matcha', price: 40000, stock_mode: 'bom' };
    assert.equal((await api('POST', '/api/products', { token: admin, json: { ...base, recipe: [{ inventory_item_id: 1, quantity: 1 }], aliases: 'matcha' } })).status, 400, 'aliases must be an array');
    assert.equal((await api('POST', '/api/products', { token: admin, json: { ...base, recipe: [{ inventory_item_id: 1, quantity: 1 }], aliases: Array.from({ length: 31 }, (_, i) => `a${i}`) } })).status, 400);
    assert.equal(called('product.create').length, 0);
    const r = await api('POST', '/api/products', { token: admin, json: { ...base, recipe: [{ inventory_item_id: 1, quantity: 10 }, { inventory_item_id: 1, quantity: 8.00004 }, { inventory_item_id: 3, quantity: 1 }], aliases: [' ma cha ', ''] } });
    assert.equal(r.status, 201);
    assert.deepEqual(called('product.setRecipe')[0].args[1], [{ inventory_item_id: 1, quantity: 18 }, { inventory_item_id: 3, quantity: 1 }], 'duplicates merged, 4 decimals');
    assert.deepEqual(called('product.setAliases')[0].args.slice(1, 3), ['Matcha', ['ma cha']]);

    reset();
    assert.equal((await api('POST', '/api/categories', { token: admin, json: { code: 'Trà sữa', name: 'Trà sữa' } })).status, 400);
    assert.equal((await api('POST', '/api/categories', { token: admin, json: { code: 'Tea_2', name: 'Trà' } })).status, 201);
    assert.equal(called('category.create')[0].args[0].code, 'tea_2', 'lowercased');
  });

  await t.test('GET /api/inventory?all=1, /api/inventory/:id, /api/inventory/purchases, movements ?type=', async () => {
    let r = await get('/api/inventory?all=1');
    assert.equal(r.body.items.length, 3);
    assert.equal(r.body.stock_value, 1400000 + 12600 + 810000);
    r = await get('/api/inventory/purchases?limit=500');
    assert.equal(r.status, 200, 'declared before /inventory/:id');
    assert.deepEqual(Object.keys(r.body.purchases[0]).sort(), ['balance_after', 'created_at', 'id', 'inventory_item_id', 'item_name', 'note', 'quantity_change', 'unit', 'unit_cost', 'user_name']);
    const adminModel = require('../src/models/adminModel');
    assert.equal(lastArgs(adminModel.recentPurchases)[0], 200, 'limit capped at 200');
    r = await get('/api/inventory/1');
    assert.deepEqual(Object.keys(r.body).sort(), ['item', 'movements', 'usage', 'used_in']);
    assert.deepEqual(Object.keys(r.body.usage).sort(), ['days', 'lastPurchase', 'received', 'used', 'wasted']);
    assert.equal(r.body.used_in.length, 2);
    assert.equal((await get('/api/inventory/99')).status, 404);
    r = await get('/api/inventory/1/movements?type=sale&limit=10');
    assert.equal(r.status, 200);
    assert.deepEqual(lastArgs(inventoryModel.movements)[3], { type: 'sale' });
    assert.equal((await get('/api/inventory/1/movements?type=gift')).status, 400);
  });

  await t.test('GET /api/admin/zalo and its writes', async () => {
    let r = await get('/api/admin/zalo');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['banks', 'chatbot', 'connection', 'drafts', 'events', 'failed', 'stats']);
    assert.equal('tokenHint' in r.body.connection, false);
    assert.ok(!JSON.stringify(r.body).includes('SECRET'), 'no token values');
    assert.ok(r.body.banks.some((b) => b.bin === '970436'));

    r = await api('PUT', '/api/admin/zalo/debt-recipient', { token: admin, json: { chatId: 'g-123', chatType: 'group' } });
    assert.deepEqual(r.body, { ok: true, chatId: 'g-123', chatType: 'group' });
    assert.equal((await api('PUT', '/api/admin/zalo/debt-recipient', { token: admin, json: { chatId: 'x', chatType: 'channel' } })).status, 400);
    assert.equal((await get('/api/admin/zalo')).body.connection.debtOwnerChatId, 'g-123');

    r = await api('PUT', '/api/admin/zalo/chatbot-info', { token: admin, json: { wifi: 'cafe12345', hours: '7h-22h' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.chatbot.wifi, 'cafe12345');
    r = await api('PUT', '/api/admin/zalo/chatbot-info', { token: admin, json: { address: '1 Lê Lợi' } });
    assert.equal(r.body.chatbot.wifi, 'cafe12345', 'fields left out keep their value');
    assert.equal(r.body.chatbot.address, '1 Lê Lợi');

    r = await api('POST', '/api/admin/zalo/register-webhook', { token: admin });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'NOT_PLATFORM');
  });

  await t.test('GET /api/admin/settings, PUT /api/admin/settings/printer', async () => {
    let r = await get('/api/admin/settings');
    assert.deepEqual(Object.keys(r.body).sort(), ['config', 'printer', 'shop_name']);
    assert.equal(typeof r.body.shop_name, 'string');
    assert.deepEqual(Object.keys(r.body.config).sort(), ['allowNegativeStock', 'draftTtlMinutes', 'publicBaseUrl', 'receiptImage', 'sessionHours', 'timezone', 'verifySignature']);
    assert.equal(r.body.config.publicBaseUrl, 'https://cafe.example.test');
    r = await api('PUT', '/api/admin/settings/printer', { token: admin, json: { paperMm: 58, autoPrint: false, footer: 'Hẹn gặp lại' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.printer.paperMm, 58);
    assert.equal(r.body.printer.autoPrint, false);
    assert.equal(r.body.printer.showVat, true, 'fields left out keep their value');
    assert.equal(r.body.printer.footer, 'Hẹn gặp lại');
    assert.equal((await api('PUT', '/api/admin/settings/printer', { token: admin, json: { autoPrint: 'yes' } })).status, 400);
    assert.equal((await api('PUT', '/api/admin/settings/printer', { token: admin, json: { paperMm: 72 } })).status, 400);
  });

  await t.test('/api/admin/users', async () => {
    let r = await get('/api/admin/users');
    assert.equal(r.body.users.length, 3);
    assert.ok(r.body.users.every((u) => !('pw_stamp' in u) && !('password_hash' in u)));
    reset();
    r = await api('POST', '/api/admin/users', { token: admin, json: { username: 'NhanVien1', password: 'long-enough-pw', full_name: 'Nhân viên', role: 'cashier' } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.user, { id: 99, username: 'nhanvien1', full_name: 'Nhân viên', role: 'cashier', is_active: 1 });
    r = await api('POST', '/api/admin/users', { token: admin, json: { username: 'nv2', password: 'short', full_name: 'X', role: 'cashier' } });
    assert.equal(r.body.error.code, 'WEAK_PASSWORD');
    r = await api('PUT', '/api/admin/users/1/active', { token: admin, json: { active: false } });
    assert.equal(r.status, 409, 'cannot lock yourself');
    assert.equal((await api('PUT', '/api/admin/users/2/active', { token: admin, json: { active: 'no' } })).status, 400);
    r = await api('PUT', '/api/admin/users/2/active', { token: admin, json: { active: false } });
    assert.equal(r.status, 200);
    assert.deepEqual(called('user.setActive')[0].args.slice(0, 2), [2, false]);
    assert.equal((await api('PUT', '/api/admin/users/2/password', { token: admin, json: { password: 'tiny' } })).status, 400);
  });
});
