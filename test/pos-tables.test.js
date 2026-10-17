process.env.FNB_NO_LISTEN = '1';
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

/**
 * Prepayment (thanh toán trước), ghép bàn and tách bàn on orderService, against a tiny in-memory database:
 * the models are replaced by functions over plain arrays, so the real service logic runs end to end.
 */
test('POS tables: prepayment, merge, split', async (t) => {
  const { pool } = require('../src/config/db');
  const orderModel = require('../src/models/orderModel');
  const tableModel = require('../src/models/tableModel');
  const productModel = require('../src/models/productModel');
  const inventoryService = require('../src/services/inventoryService');
  const orderService = require('../src/services/orderService');

  const db = {};
  const reset = () => {
    db.tables = [1, 2, 3, 4].map((id) => ({ id, code: `B0${id}`, name: `Bàn ${id}`, status: 'available', current_order_id: null, merged_into: null, is_active: 1 }));
    db.orders = []; db.items = []; db.payments = [];
    db.nextOrder = 100; db.nextItem = 1000;
  };
  reset();
  const products = new Map([[1, { id: 1, name: 'Cà phê', price: 25000, is_active: 1 }], [2, { id: 2, name: 'Trà đào', price: 30000, is_active: 1 }]]);
  const recalc = (id) => {
    const o = db.orders.find((x) => x.id === id);
    o.subtotal = db.items.filter((i) => i.order_id === id).reduce((s, i) => s + i.line_total, 0);
    o.total = Math.max(0, o.subtotal - o.discount);
  };

  mock.method(pool, 'getConnection', async () => ({ beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, query: async () => [[]] }));
  mock.method(productModel, 'getManyByIds', async (ids) => ids.map((i) => products.get(i)).filter(Boolean));
  mock.method(inventoryService, 'consumeForOrder', async (_c, _o, items) => ({ cogsTotal: 0, lines: items.map((i) => ({ itemId: i.id, unitCogs: 0, lineCogs: 0 })) }));

  mock.method(orderModel, 'insert', async ({ tableId = null, status = 'open', note = null, createdBy = null }) => {
    const id = db.nextOrder++;
    db.orders.push({ id, order_code: `CF-${id}`, table_id: tableId, status, payment_status: 'unpaid', subtotal: 0, discount: 0, total: 0, note, customer_id: null, created_by: createdBy });
    return id;
  });
  mock.method(orderModel, 'getById', async (id) => db.orders.find((o) => o.id === Number(id)) || null);
  mock.method(orderModel, 'getItems', async (id) => db.items.filter((i) => i.order_id === id));
  mock.method(orderModel, 'replaceItems', async (id, lines) => {
    db.items = db.items.filter((i) => i.order_id !== id);
    for (const l of lines) db.items.push({ id: db.nextItem++, order_id: id, ...l, line_total: l.unit_price * l.quantity });
    recalc(id);
  });
  mock.method(orderModel, 'recalcTotals', async (id) => recalc(id));
  mock.method(orderModel, 'setDiscount', async (id, d) => { db.orders.find((o) => o.id === id).discount = d; recalc(id); });
  mock.method(orderModel, 'setItemCogs', async () => {});
  mock.method(orderModel, 'markCompleted', async (id) => { db.orders.find((o) => o.id === id).status = 'completed'; });
  mock.method(orderModel, 'markPaid', async (id) => { db.orders.find((o) => o.id === id).payment_status = 'paid'; });
  mock.method(orderModel, 'markCancelled', async (id) => { db.orders.find((o) => o.id === id).status = 'cancelled'; });
  mock.method(orderModel, 'setNote', async (id, note) => { db.orders.find((o) => o.id === id).note = note; });
  mock.method(orderModel, 'insertPayment', async ({ orderId, method, amount, reference = null }) => { db.payments.push({ order_id: orderId, method, amount: Number(amount), reference }); });
  mock.method(orderModel, 'paidTotal', async (id) => db.payments.filter((p) => p.order_id === id).reduce((s, p) => s + p.amount, 0));
  mock.method(orderModel, 'paidByMethod', async (id) => {
    const by = {};
    for (const p of db.payments.filter((x) => x.order_id === id)) by[p.method] = (by[p.method] || 0) + p.amount;
    return Object.entries(by).filter(([, a]) => a > 0).map(([method, amount]) => ({ method, amount }));
  });
  mock.method(orderModel, 'movePayments', async (from, to) => { db.payments.forEach((p) => { if (p.order_id === from) p.order_id = to; }); });
  mock.method(orderModel, 'moveAllItems', async (from, to) => { db.items.forEach((i) => { if (i.order_id === from) i.order_id = to; }); });
  mock.method(orderModel, 'moveItem', async (id, to) => { db.items.find((i) => i.id === id).order_id = to; });
  mock.method(orderModel, 'setItemQuantity', async (id, q) => { const i = db.items.find((x) => x.id === id); i.quantity = q; i.line_total = i.unit_price * q; });
  mock.method(orderModel, 'insertItemCopy', async (item, to, q) => { db.items.push({ ...item, id: db.nextItem++, order_id: to, quantity: q, line_total: item.unit_price * q }); });

  const table = (id) => db.tables.find((x) => x.id === id);
  mock.method(tableModel, 'getById', async (id) => table(Number(id)) || null);
  mock.method(tableModel, 'setServing', async (id, orderId) => Object.assign(table(id), { status: 'serving', current_order_id: orderId, merged_into: null }));
  mock.method(tableModel, 'setMerged', async (id, primary) => Object.assign(table(id), { status: 'serving', current_order_id: null, merged_into: primary }));
  mock.method(tableModel, 'mergedInto', async (id) => db.tables.filter((x) => x.merged_into === id));
  mock.method(tableModel, 'release', async (id) => db.tables.forEach((x) => { if (x.id === id || x.merged_into === id) Object.assign(x, { status: 'available', current_order_id: null, merged_into: null }); }));

  const open = (tableId, items) => orderService.createPosOrder({ table_id: tableId, items, userId: 1 });
  const items = (...pairs) => pairs.map(([product_id, quantity]) => ({ product_id, quantity }));
  const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code, `expected ${code}`);
  t.beforeEach(reset);

  await t.test('prepayment: only the rest is collected at checkout; no second payment row when fully prepaid', async () => {
    const o = await open(1, items([1, 2], [2, 1]));                 // 80.000
    assert.equal(o.total, 80000);
    const r = await orderService.prepayOrder(o.id, { method: 'transfer', amount: 30000, reference: 'MB 123', userId: 1 });
    assert.equal(r.prepaid, 30000);
    assert.equal(db.payments[0].reference, 'Trả trước · MB 123');
    await rejects(orderService.prepayOrder(o.id, { method: 'cash', amount: 60000, userId: 1 }), 'PREPAY_TOO_MUCH');
    await rejects(orderService.prepayOrder(o.id, { method: 'cash', amount: 0, userId: 1 }), 'VALIDATION');

    await rejects(orderService.payOrder(o.id, { method: 'cash', tendered: 40000, userId: 1 }), 'INSUFFICIENT_PAYMENT');   // 50.000 due
    const paid = await orderService.payOrder(o.id, { method: 'cash', tendered: 100000, userId: 1 });
    assert.equal(paid.change, 50000, 'change is computed against what was still due');
    assert.equal(db.payments.length, 2);
    assert.equal(db.payments[1].amount, 50000);
    assert.equal(db.payments.reduce((s, p) => s + p.amount, 0), 80000, 'payments add up to the order total');
    assert.equal(table(1).status, 'available');

    const full = await open(2, items([1, 1]));
    await orderService.prepayOrder(full.id, { method: 'cash', amount: 25000, userId: 1 });
    const done = await orderService.payOrder(full.id, { method: 'cash', userId: 1 });
    assert.equal(done.change, 0);
    assert.equal(db.payments.filter((p) => p.order_id === full.id).length, 1, 'nothing more to collect: no extra row');
    assert.equal(db.orders.find((x) => x.id === full.id).payment_status, 'paid');
  });

  await t.test('prepayment: items cannot drop below it, a discount cannot exceed it, cancelling refunds it', async () => {
    const o = await open(1, items([2, 2]));                          // 60.000
    await orderService.prepayOrder(o.id, { method: 'cash', amount: 50000, userId: 1 });
    await rejects(orderService.replaceOpenOrderItems(o.id, items([1, 1])), 'BELOW_PREPAID');   // 25.000 < 50.000
    await orderService.replaceOpenOrderItems(o.id, items([2, 2], [1, 1]));                     // more items are fine
    await orderService.prepayOrder(o.id, { method: 'transfer', amount: 10000, userId: 1 });
    await orderService.cancelOrder(o.id);
    const refunds = db.payments.filter((p) => p.amount < 0);
    assert.deepEqual(refunds.map((p) => [p.method, p.amount]).sort(), [['cash', -50000], ['transfer', -10000]]);
    assert.equal(db.payments.reduce((s, p) => s + p.amount, 0), 0, 'the books net to zero');
    assert.equal(table(1).status, 'available');

    const d = await open(2, items([1, 2]));                          // 50.000
    await orderService.prepayOrder(d.id, { method: 'cash', amount: 50000, userId: 1 });
    await rejects(orderService.payOrder(d.id, { method: 'cash', discount: 10000, userId: 1, isAdmin: true }), 'PREPAID_EXCEEDS_TOTAL');
  });

  await t.test('merge: a free table is attached; paying frees the whole group', async () => {
    const o = await open(1, items([1, 1]));
    await orderService.mergeTables({ primaryTableId: 1, otherTableId: 2 });
    assert.deepEqual([table(2).status, table(2).merged_into, table(2).current_order_id], ['serving', 1, null]);
    await rejects(orderService.mergeTables({ primaryTableId: 1, otherTableId: 2 }), 'TABLE_MERGED');
    await rejects(orderService.mergeTables({ primaryTableId: 2, otherTableId: 3 }), 'TABLE_MERGED');       // a merged table cannot lead
    await rejects(orderService.mergeTables({ primaryTableId: 1, otherTableId: 1 }), 'VALIDATION');
    await orderService.payOrder(o.id, { method: 'cash', userId: 1 });
    assert.deepEqual(db.tables.map((x) => x.status), ['available', 'available', 'available', 'available']);
    assert.equal(table(2).merged_into, null);
  });

  await t.test('merge: a table with its own order has its items, payments and note moved over', async () => {
    const a = await open(1, items([1, 1]));
    const b = await open(2, items([1, 1], [2, 1]));
    await orderService.prepayOrder(b.id, { method: 'cash', amount: 20000, userId: 1 });
    db.orders.find((x) => x.id === b.id).note = 'ít đá';
    const merged = await orderService.mergeTables({ primaryTableId: 1, otherTableId: 2 });
    assert.equal(merged.id, a.id);
    assert.equal(merged.items.length, 3);
    assert.equal(merged.total, 80000);
    assert.equal(merged.note, 'ít đá');
    assert.equal(db.payments[0].order_id, a.id, 'the prepayment follows the items');
    const gone = db.orders.find((x) => x.id === b.id);
    assert.equal(gone.status, 'cancelled');
    assert.equal(gone.total, 0);
    assert.equal(table(2).current_order_id, null);
    assert.equal(db.payments.filter((p) => p.amount < 0).length, 0, 'no refund: the money moved, it did not leave');
    const closed = await orderService.payOrder(a.id, { method: 'cash', tendered: 100000, userId: 1 });
    assert.equal(closed.change, 40000, '80.000 - 20.000 prepaid = 60.000 due');
  });

  await t.test('unmerge: only a merged table can leave, and it becomes free', async () => {
    await open(1, items([1, 1]));
    await orderService.mergeTables({ primaryTableId: 1, otherTableId: 2 });
    await rejects(orderService.unmergeTable(3), 'TABLE_NOT_MERGED');
    await orderService.unmergeTable(2);
    assert.equal(table(2).status, 'available');
    assert.equal(table(1).status, 'serving');
  });

  await t.test('split: whole and partial lines move to a free table, which gets its own order', async () => {
    const o = await open(1, items([1, 3], [2, 1]));                  // 75.000 + 30.000
    const [cf, tea] = db.items.filter((i) => i.order_id === o.id);
    const r = await orderService.splitOrder({ orderId: o.id, targetTableId: 2, userId: 1, items: [{ item_id: cf.id, quantity: 2 }, { item_id: tea.id, quantity: 1 }] });
    assert.equal(r.source.items.length, 1);
    assert.equal(r.source.items[0].quantity, 1);
    assert.equal(r.source.total, 25000);
    assert.equal(r.target.total, 80000);
    assert.equal(r.target.table_id, 2);
    assert.equal(table(2).current_order_id, r.target.id);
    assert.equal(table(2).status, 'serving');
  });

  await t.test('split: onto a table that already has an order appends to it', async () => {
    const a = await open(1, items([1, 2]));
    const b = await open(2, items([2, 1]));
    const [line] = db.items.filter((i) => i.order_id === a.id);
    const r = await orderService.splitOrder({ orderId: a.id, targetTableId: 2, userId: 1, items: [{ item_id: line.id, quantity: 1 }] });
    assert.equal(r.target.id, b.id);
    assert.equal(r.target.total, 55000);
  });

  await t.test('split: refuses to empty the order, to overdraw a line, to break a prepayment or to target merged tables', async () => {
    const o = await open(1, items([1, 2], [2, 1]));
    const [cf, tea] = db.items.filter((i) => i.order_id === o.id);
    const split = (items, target = 3) => orderService.splitOrder({ orderId: o.id, targetTableId: target, userId: 1, items });
    await rejects(split([{ item_id: cf.id, quantity: 2 }, { item_id: tea.id, quantity: 1 }]), 'SPLIT_ALL');
    await rejects(split([{ item_id: cf.id, quantity: 3 }]), 'VALIDATION');
    await rejects(split([{ item_id: 99999, quantity: 1 }]), 'VALIDATION');
    await rejects(split([]), 'VALIDATION');
    await rejects(split([{ item_id: cf.id, quantity: 1 }], 1), 'VALIDATION');                 // its own table
    await orderService.mergeTables({ primaryTableId: 1, otherTableId: 4 });
    await rejects(split([{ item_id: cf.id, quantity: 1 }], 4), 'TABLE_MERGED');
    await orderService.prepayOrder(o.id, { method: 'cash', amount: 70000, userId: 1 });      // total 80.000
    await rejects(split([{ item_id: tea.id, quantity: 1 }]), 'BELOW_PREPAID');               // left 50.000 < 70.000
  });
});
