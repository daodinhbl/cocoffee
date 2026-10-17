const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');

test('Nhập kho: one slip, several items, bought by the box / kg, with a supplier and payment', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);
  const called = (n) => fx.calls.filter((c) => c.name === n);
  const post = (body) => admin.post('/admin/receiving', { _csrf: token, _back: '/admin/receiving', ...body });
  const flash = async () => (await (await admin.get('/admin/receiving')).text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  await t.test('the page offers the multi-line slip with supplier, payment and units', async () => {
    const html = await (await admin.get('/admin/receiving?item=2&supplier=1')).text();
    assert.match(html, /id="r-lines"/);
    assert.match(html, /name="supplier_id"/);
    assert.match(html, /<option value="1" selected>NCC A<\/option>/, 'a link from the supplier page preselects it');
    assert.match(html, /name="pay_mode" value="partial"/);
    assert.match(html, /"preselect":2/);
    assert.match(html, /<datalist id="r-catalog">/);
    assert.match(html, /PN261017-00005/, 'recent slips are listed');
  });

  await t.test('three lines bought in kg / pieces / boxes are booked in stock units, with supplier and part payment', async () => {
    fx.calls.length = 0;
    // 2 kg coffee at 280.000/kg; 500 ml milk at 30/ml; 1 box of 24 cups at 21.600/box
    await post({
      item_id: ['1', '2', '3'], quantity: ['2', '500', '1'], unit_cost: ['280000', '30', '21600'], factor: ['1000', '1', '24'], pack: ['kg', '', 'thùng'],
      supplier_id: '1', doc_no: 'HD-12', note: 'giao sáng', pay_mode: 'partial', paid_amount: '100000', pay_method: 'transfer',
    });
    const calls = called('inventory.receive');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => [c.args[1], c.args[2], c.args[3]]), [[1, 2000, 280], [2, 500, 30], [3, 24, 900]], 'stock units: 2000 g at 280đ, 500 ml, 24 cups at 900đ');
    assert.match(calls[0].args[4].note, /^PN261017-00005 · HĐ: HD-12 · giao sáng · 2 kg × 1000$/);
    assert.equal(calls[1].args[4].note, 'PN261017-00005 · HĐ: HD-12 · giao sáng', 'no pack text when bought in stock units');
    const lines = called('receipt.line').map((c) => c.args[1]);
    assert.deepEqual(lines.map((l) => [l.itemId, l.packQty, l.packFactor, l.packLabel, l.quantity, l.unitCost, l.lineTotal]),
      [[1, 2, 1000, 'kg', 2000, 280, 560000], [2, 500, 1, null, 500, 30, 15000], [3, 1, 24, 'thùng', 24, 900, 21600]]);
    assert.deepEqual(called('receipt.totals')[0].args.slice(0, 3), [5, 596600, 100000], 'total, paid');
    const pay = called('receipt.payment')[0].args[0];
    assert.deepEqual([pay.supplierId, pay.receiptId, pay.amount, pay.method], [1, 5, 100000, 'transfer']);
    assert.match(await flash(), /Đã nhập kho 3 dòng hàng \(PN261017-00005\), tổng tiền 596\.600đ, còn nợ 496\.600đ/);
    const exp = called('expense.insert')[0].args[0];                 // the slip is also an operating expense, booked in the same transaction
    assert.deepEqual([exp.categoryId, exp.amount, exp.payee, exp.supplierId, exp.purchaseReceiptId, exp.source, exp.docNo], [1, 596600, 'NCC A', 1, 5, 'purchase', 'HD-12']);
    assert.match(exp.note, /PN261017-00005/);
  });

  await t.test('pay modes: all (default), none (all on credit), retail (no supplier) is always paid in full', async () => {
    fx.calls.length = 0;
    await post({ item_id: '1', quantity: '1', unit_cost: '1000', supplier_id: '1' });
    assert.deepEqual(called('receipt.totals')[0].args.slice(1, 3), [1000, 1000], 'default: paid in full');
    fx.calls.length = 0;
    await post({ item_id: '1', quantity: '1', unit_cost: '1000', supplier_id: '1', pay_mode: 'none' });
    assert.deepEqual(called('receipt.totals')[0].args.slice(1, 3), [1000, 0]);
    assert.equal(called('receipt.payment').length, 0, 'nothing paid, no payment row');
    fx.calls.length = 0;
    await post({ item_id: '1', quantity: '1', unit_cost: '1000', pay_mode: 'none' });
    assert.deepEqual(called('receipt.totals')[0].args.slice(1, 3), [1000, 1000], 'without a supplier nothing can be owed');
    fx.calls.length = 0;
    await post({ item_id: '1', quantity: '1', unit_cost: '1000', supplier_id: '1', pay_mode: 'partial', paid_amount: '5000' });
    assert.equal(called('receipt.insert').length, 1, 'a part payment above the total is refused, but the slip row is rolled back by the transaction');
    assert.equal(called('receipt.totals').length, 0);
  });

  await t.test('a new supplier name creates the supplier', async () => {
    fx.calls.length = 0;
    await post({ item_id: '1', quantity: '1', unit_cost: '1000', supplier_new: 'Công ty Mới' });
    assert.equal(called('supplier.create')[0].args[0].name, 'Công ty Mới');
    assert.equal(called('receipt.insert')[0].args[0].supplierId, 2, 'the new supplier id');
  });

  await t.test('empty rows are skipped; one bad line rejects the whole slip', async () => {
    fx.calls.length = 0;
    await post({ item_id: ['1', '', '2'], quantity: ['10', '', '5'], unit_cost: ['1', '', '2'] });
    assert.equal(called('inventory.receive').length, 2);
    fx.calls.length = 0;
    await post({ item_id: ['1', '2'], quantity: ['10', '-5'], unit_cost: ['1', '2'] });
    assert.equal(called('inventory.receive').length, 0, 'validation happens before anything is booked');
    await post({ item_id: ['1'], quantity: ['1'], unit_cost: ['1'], factor: ['0'], pack: ['x'] });
    assert.equal(called('inventory.receive').length, 0, 'a zero conversion is refused');
    await post({ item_id: [''], quantity: [''], unit_cost: [''] });
    assert.equal(called('inventory.receive').length, 0);
    assert.match(await flash(), /Chọn ít nhất một mặt hàng/);
  });

  await t.test('the old single-line form still works', async () => {
    fx.calls.length = 0;
    await post({ inventory_item_id: '1', quantity: '5', unit_cost: '7' });
    assert.equal(called('inventory.receive').length, 1);
    assert.match(await flash(), /Đã nhập kho \(PN261017-00005\)\. Tồn mới/);
  });
});

test('item dialog: packaging ("Quy cách nhập") is saved and offered when receiving', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);
  const called = (n) => fx.calls.filter((c) => c.name === n);
  const html = await (await admin.get('/admin/inventory')).text();
  assert.match(html, /name="pack_name"/);
  assert.match(html, /name="pack_size"/);

  await admin.post('/admin/inventory', { _csrf: token, _back: '/admin/inventory', name: 'Nước Lavie', sku: '', unit: 'chai', group_code: 'retail', pack_name: 'thùng', pack_size: '24', quantity_on_hand: '0' });
  const created = called('inventory.create')[0].args[0];
  assert.deepEqual([created.pack_name, created.pack_size], ['thùng', 24]);

  await admin.post('/admin/inventory/1', { _csrf: token, _back: '/admin/inventory', name: 'Cà phê rang xay', unit: 'g', min_stock: '1000', pack_name: 'bao', pack_size: '5000' });
  const patch = called('inventory.update')[0].args[1];
  assert.deepEqual([patch.pack_name, patch.pack_size], ['bao', 5000]);
  fx.calls.length = 0;
  await admin.post('/admin/inventory/1', { _csrf: token, _back: '/admin/inventory', name: 'Cà phê rang xay', unit: 'g', min_stock: '1000', pack_name: '', pack_size: '' });
  assert.deepEqual([called('inventory.update')[0].args[1].pack_name, called('inventory.update')[0].args[1].pack_size], ['', null], 'cleared');
  fx.calls.length = 0;
  await admin.post('/admin/inventory', { _csrf: token, _back: '/admin/inventory', name: 'X', sku: 'X', unit: 'g', pack_name: 'bao', pack_size: '', quantity_on_hand: '0' });
  assert.equal(called('inventory.create').length, 0, 'a pack name without its size is refused');
});
