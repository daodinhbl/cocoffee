const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start, PASSWORD } = require('./helpers/adminFixture');

test('POS: order history and chốt ca', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const shiftModel = require('../src/models/shiftModel');
  const { c: cashier } = await fx.login('thungan', PASSWORD);
  const token = /"csrf":"([0-9a-f]+)"/.exec(await (await cashier.get('/admin/pos')).text())[1];

  await t.test('history lists the day and shows one order with its payments', async () => {
    let j = await (await cashier.get('/admin/pos/history')).json();
    assert.equal(j.ok, true);
    assert.match(j.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(j.orders[0].code, 'CF261013-00042');
    assert.equal(typeof j.orders[0].total, 'number');
    j = await (await cashier.get('/admin/pos/history?day=2026-02-31&status=nope&q=%25')).json();
    assert.equal(j.ok, true, 'a bad day / status falls back to today / all instead of failing');

    j = await (await cashier.get('/admin/pos/history/42')).json();
    assert.equal(j.ok, true);
    assert.equal(j.order.items.length, 2);
    assert.equal(j.order.items[0].name, 'Cà phê sữa đá');
    assert.equal(j.order.payments[0].label, 'Tiền mặt');
    assert.equal((await cashier.get('/admin/pos/history/abc')).status, 400);
  });

  await t.test('shift: preview, closing stores the till difference, a second close of the same period is refused', async () => {
    const T0 = new Date('2026-10-17T08:00:00Z');
    const T1 = new Date('2026-10-17T15:00:00Z');
    let prev = { id: 1, period_to: T0, counted_cash: 500000 };
    const saved = [];
    mock.method(shiftModel, 'last', async () => prev);
    mock.method(shiftModel, 'now', async () => T1);
    mock.method(shiftModel, 'paymentsByMethod', async () => ({ cash: 300000, transfer: 120000, card: 0, other: 0 }));
    mock.method(shiftModel, 'orderTotals', async () => ({ orders: 9, revenue: 420000, discount: 10000, unpaid: 0, cancelled: 1, open: 2, openAmount: 80000 }));
    mock.method(shiftModel, 'recent', async () => [{ id: 1, period_to: T0, revenue: 100, closed_by_name: 'Thu Ngân' }]);
    mock.method(shiftModel, 'insert', async (s) => {
      if (saved.some((x) => +x.from === +s.from)) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      saved.push(s); return 7;
    });
    mock.method(shiftModel, 'getById', async () => ({ id: 7, period_from: T0, period_to: T1, closed_by_name: 'Thu Ngân', opening_cash: 500000, counted_cash: 790000, expected_cash: 800000, difference: -10000,
      cash_total: 300000, transfer_total: 120000, card_total: 0, other_total: 0, orders_count: 9, cancelled_count: 1, revenue: 420000, discount_total: 10000, unpaid_total: 0, note: 'thiếu 10k' }));

    let j = await (await cashier.get('/admin/pos/shift')).json();
    assert.equal(j.ok, true);
    assert.equal(j.shift.suggestedOpening, 500000, 'the opening cash is what the previous shift counted');
    assert.equal(j.shift.pay.cash, 300000);
    assert.equal(j.shift.totals.open, 2);

    const post = async (body) => (await cashier.postJson('/admin/pos/shift/close', { _csrf: token, ...body })).json();
    j = await post({ opening_cash: 500000, counted_cash: 790000, note: 'thiếu 10k' });
    assert.equal(j.ok, true);
    assert.equal(j.shiftId, 7);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].expectedCash, 800000, 'opening + cash takings');
    assert.equal(saved[0].difference, -10000);
    assert.equal(+saved[0].from, +T0, 'the shift starts where the previous one ended');
    assert.equal(saved[0].closedBy, 2);

    j = await post({ opening_cash: 500000, counted_cash: 790000 });
    assert.equal(j.ok, false);
    assert.equal(j.code, 'SHIFT_EXISTS');

    prev = null;
    assert.equal((await post({ opening_cash: -5, counted_cash: 1 })).ok, false, 'negative money is refused');
    assert.equal((await post({ opening_cash: 'abc', counted_cash: 1 })).ok, false);
    assert.equal((await cashier.postJson('/admin/pos/shift/close', { opening_cash: 0, counted_cash: 0 })).status, 303, 'CSRF token required');
  });

  await t.test('shift report page is printable', async () => {
    const res = await cashier.get('/admin/pos/shift/7/print?print=1');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /PHIẾU CHỐT CA #7/);
    assert.match(html, /Thiếu/);
    assert.match(html, /window\.print/);
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
  });
});
