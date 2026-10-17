const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start } = require('./helpers/adminFixture');

const flat = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('suppliers, purchase history and debt pages', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);
  const called = (n) => fx.calls.filter((c) => c.name === n);
  const post = (url, body) => admin.post(url, { _csrf: token, _back: '/admin/suppliers', ...body });

  await t.test('supplier list: totals, STT, zebra, debt, pager', async () => {
    const html = await (await admin.get('/admin/suppliers')).text();
    const text = flat(html);
    assert.match(text, /Nhà cung cấp 1 1 đang còn nợ/);
    assert.match(text, /Tổng tiền hàng đã nhập 1\.000\.000đ/);
    assert.match(text, /Công nợ phải trả 400\.000đ/);
    assert.match(html, />STT</);
    assert.match(html, /<tr data-row class="[^"]*bg-blue-50\/70/);
    assert.match(html, /href="\/admin\/receiving\?supplier=1"/);
    assert.match(text, /Hiển thị 1–1 trong 1 nhà cung cấp/);
    assert.match(html, /id="supplier-dialog"/);
  });

  await t.test('supplier detail: purchase and payment history, pay button', async () => {
    const html = await (await admin.get('/admin/suppliers/1')).text();
    const text = flat(html);
    assert.match(text, /NCC A/);
    assert.match(text, /Còn nợ 400\.000đ/);
    assert.match(text, /Lịch sử nhập hàng/);
    assert.match(text, /PN261017-00005/);
    assert.match(text, /Lịch sử thanh toán/);
    assert.match(html, /data-action="\/admin\/suppliers\/1\/pay"/);
    assert.equal((await admin.get('/admin/suppliers/99')).status, 404);
  });

  await t.test('create / update / duplicate name', async () => {
    await post('/admin/suppliers', { name: 'Công ty B', phone: '0988', address: 'Hà Nội', tax_code: '0101', note: 'x' });
    assert.deepEqual([called('supplier.create')[0].args[0].name, called('supplier.create')[0].args[0].phone], ['Công ty B', '0988']);
    const { supplierModel } = { supplierModel: require('../src/models/supplierModel') };
    mock.method(supplierModel, 'findByName', async (n) => (n === 'Trùng' ? { id: 9, name: 'Trùng' } : null));
    fx.calls.length = 0;
    await post('/admin/suppliers', { name: 'Trùng' });
    assert.equal(called('supplier.create').length, 0, 'duplicate name refused');
    await post('/admin/suppliers/1', { name: 'NCC A mới', is_active: '0' });
    assert.equal(called('supplier.update')[0].args[0], 1);
    assert.equal(called('supplier.update')[0].args[1].is_active, 0);
    fx.calls.length = 0;
    await post('/admin/suppliers/1', { name: 'Trùng' });
    assert.equal(called('supplier.update').length, 0, 'renaming onto another supplier is refused');
  });

  await t.test('pay the debt: allocated to the open receipt, overpaying is refused', async () => {
    fx.calls.length = 0;
    await post('/admin/suppliers/1/pay', { amount: '400000', method: 'transfer', note: 'chuyển khoản' });
    assert.deepEqual(called('receipt.addPaid')[0].args.slice(0, 2), [5, 400000]);
    const p = called('receipt.payment')[0].args[0];
    assert.deepEqual([p.supplierId, p.receiptId, p.amount, p.method], [1, 5, 400000, 'transfer']);
    fx.calls.length = 0;
    await post('/admin/suppliers/1/pay', { amount: '400001' });
    assert.equal(called('receipt.addPaid').length, 0, 'more than the debt is refused');
    await post('/admin/suppliers/1/pay', { amount: '0' });
    assert.equal(called('receipt.addPaid').length, 0);
    fx.calls.length = 0;
    await admin.post('/admin/receipts/5/pay', { _csrf: token, _back: '/admin/receipts/5', amount: '1000' });
    assert.deepEqual(called('receipt.addPaid')[0].args.slice(0, 2), [5, 1000]);
  });

  await t.test('history list: filters, totals, STT; detail shows pack conversion', async () => {
    const html = await (await admin.get('/admin/receipts')).text();
    const text = flat(html);
    assert.match(text, /Lịch sử nhập kho/);
    assert.match(text, /Tổng tiền hàng nhập 1\.000\.000đ/);
    assert.match(text, /Trả một phần/);
    assert.match(html, /name="supplier"/);
    assert.match(html, /<tr data-row class="[^"]*bg-blue-50\/70/);
    assert.match(flat(await (await admin.get('/admin/receipts?supplier=1&debt=1&from=2026-10-01&to=2026-10-31&q=PN')).text()), /Lịch sử nhập kho/);
    const d = flat(await (await admin.get('/admin/receipts/5')).text());
    assert.match(d, /Phiếu nhập PN261017-00005/);
    assert.match(d, /1 kg = 1\.000 g/);
    assert.match(d, /\+2\.000 g/);
    assert.match(d, /280đ/, 'cost per stock unit');
    assert.match(d, /Tổng cộng 1\.000\.000đ/);
    assert.equal((await admin.get('/admin/receipts/99')).status, 404);
  });
});
