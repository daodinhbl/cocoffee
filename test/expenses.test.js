const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start, PASSWORD } = require('./helpers/adminFixture');

const flat = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const jpeg = (fill = 7) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, fill)]).toString('base64')}`;

test('sổ chi phí: categories, manual expenses with a receipt photo, void, purchase expenses', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const expenseModel = require('../src/models/expenseModel');
  const { shopDay, addDays } = require('../src/utils/shopTime');
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);
  const called = (n) => fx.calls.filter((c) => c.name === n);
  const post = (url, body) => admin.post(url, { _csrf: token, _back: '/admin/expenses', ...body });
  const today = shopDay();
  const base = { expense_date: today, category_id: '2', amount: '8000000', payee: 'Chủ nhà', doc_no: 'PC-01', note: 'Tháng 10' };
  const flash = async () => flat(await (await admin.get('/admin/expenses')).text());

  await t.test('list page: totals, split by category, STT + zebra, purchase rows link to their receipt', async () => {
    const html = await (await admin.get('/admin/expenses')).text();
    const text = flat(html);
    assert.match(text, /Tổng chi phí 9\.000\.000đ/);
    assert.match(text, /Tiền hàng nhập 1\.000\.000đ/);
    assert.match(text, /Chi phí khác 8\.000\.000đ/);
    assert.match(text, /Chi phí theo danh mục/);
    assert.match(html, />STT</);
    assert.match(html, /<tr data-row class="[^"]*bg-blue-50\/70/);
    assert.match(html, /href="\/admin\/receipts\/5"[^>]*>PN261017-00005/);
    assert.match(html, /src="\/admin\/expenses\/21\/receipt"/, 'a row with a photo shows its thumbnail');
    assert.doesNotMatch(html, /src="\/admin\/expenses\/22\/receipt"/);
    assert.match(text, /Hiển thị 1–2 trong 2 khoản chi/);
    assert.match(html, /id="expense-dialog"/);
    assert.match(flat(await (await admin.get('/admin/expenses?all=1&cat=2&src=manual&q=nha&void=1')).text()), /Sổ chi phí/);
  });

  await t.test('categories page and CRUD', async () => {
    const text = flat(await (await admin.get('/admin/expense-categories')).text());
    assert.match(text, /Nguyên vật liệu & hàng hóa/);
    assert.match(text, /Được trừ khi tính thuế/);
    assert.ok(text.includes('Tài sản / thiết bị'));
    await post('/admin/expense-categories', { name: 'Vệ sinh', code: 'Vệ sinh!', tax_treatment: 'deductible', ledger_code: 'VS', sort_order: '20' });
    const made = called('expcat.create')[0].args[0];
    assert.deepEqual([made.code, made.name, made.taxTreatment, made.ledgerCode], ['v-sinh', 'Vệ sinh', 'deductible', 'VS']);
    fx.calls.length = 0;
    await post('/admin/expense-categories', { name: 'X', code: 'thue-mat-bang', tax_treatment: 'deductible' });
    assert.equal(called('expcat.create').length, 0, 'duplicate code refused');
    await post('/admin/expense-categories', { name: 'X', code: 'x', tax_treatment: 'weird' });
    assert.equal(called('expcat.create').length, 0, 'unknown tax treatment refused');
    await post('/admin/expense-categories/2', { name: 'Thuê nhà', tax_treatment: 'deductible', ledger_code: 'TN', sort_order: '4', is_active: '1' });
    assert.equal(called('expcat.update')[0].args[1].name, 'Thuê nhà');
    fx.calls.length = 0;
    await post('/admin/expense-categories/1', { name: 'NVL', tax_treatment: 'deductible', is_active: '0' });
    assert.equal(called('expcat.update').length, 0, 'the purchase category cannot be hidden');
  });

  await t.test('create: money, date and category are validated; a photo is stored, hashed and linked', async () => {
    fx.calls.length = 0;
    await post('/admin/expenses', { ...base, image_data: jpeg(1) });
    const e = called('expense.insert')[0].args[0];
    assert.deepEqual([e.expenseDate, e.categoryId, e.amount, e.payee, e.docNo, e.source, e.createdBy], [today, 2, 8000000, 'Chủ nhà', 'PC-01', 'manual', 1]);
    assert.ok(e.receiptMediaId > 0, 'photo stored in media_files');
    assert.match(e.receiptSha256, /^[0-9a-f]{64}$/);
    assert.equal(called('media.create')[0].args[0].folder, 'expense');
    fx.calls.length = 0;
    await post('/admin/expenses', { ...base, amount: '0' });
    await post('/admin/expenses', { ...base, amount: '-5' });
    await post('/admin/expenses', { ...base, expense_date: addDays(today, 5) });
    await post('/admin/expenses', { ...base, expense_date: '2026-02-31' });
    await post('/admin/expenses', { ...base, category_id: '99' });
    await post('/admin/expenses', { ...base, image_data: 'data:text/html;base64,PGI+' });
    assert.equal(called('expense.insert').length, 0, 'every invalid form is refused');
    await post('/admin/expenses', { ...base, expense_date: addDays(today, -40) });
    assert.equal(called('expense.insert').length, 1, 'a past date is fine');
  });

  await t.test('the same photo cannot back two expenses', async () => {
    fx.calls.length = 0;
    mock.method(expenseModel, 'findBySha', async () => ({ id: 21, expense_date: '2026-10-05', amount: 8000000 }));
    await post('/admin/expenses', { ...base, image_data: jpeg(2) });
    assert.equal(called('expense.insert').length, 0);
    assert.equal(called('media.create').length, 0, 'nothing is stored for a refused duplicate');
    assert.match(await flash(), /đã được dùng cho khoản chi #21/);
    expenseModel.findBySha.mock.restore();
  });

  await t.test('update: manual rows are editable, rows from a stock receipt only change category and note', async () => {
    fx.calls.length = 0;
    await post('/admin/expenses/21', { ...base, amount: '8500000', image_data: jpeg(3) });
    assert.equal(called('expense.update')[0].args[1].amount, 8500000);
    assert.ok(called('expense.setReceipt')[0].args[1] > 0, 'the new photo replaces the old one');
    assert.equal(called('media.remove')[0].args[0], 7, 'the old photo row is deleted');
    fx.calls.length = 0;
    await post('/admin/expenses/21', { ...base, image_remove: '1' });
    assert.equal(called('expense.setReceipt')[0].args[1], null, 'removing the photo');
    fx.calls.length = 0;
    await post('/admin/expenses/22', { source: 'purchase', category_id: '3', note: 'Máy xay' });
    assert.equal(called('expense.update').length, 0, 'amount is not editable on a purchase row');
    assert.deepEqual([called('expense.setCat')[0].args[1].categoryId, called('expense.setCat')[0].args[1].note], [3, 'Máy xay']);
    fx.calls.length = 0;
    await post('/admin/expenses/22', { ...base, amount: '1' });
    assert.equal(called('expense.update').length, 0, 'even a forged full form cannot change the money of a purchase row');
  });

  await t.test('void: needs a reason, only manual rows', async () => {
    fx.calls.length = 0;
    await post('/admin/expenses/21/void', { reason: '' });
    assert.equal(called('expense.void').length, 0);
    await post('/admin/expenses/22/void', { reason: 'nhầm' });
    assert.equal(called('expense.void').length, 0, 'a purchase row cannot be voided on its own');
    await post('/admin/expenses/21/void', { reason: 'Nhập trùng' });
    assert.deepEqual(called('expense.void')[0].args.slice(0, 3), [21, 'Nhập trùng', 1]);
  });

  await t.test('the receipt photo is admin-only: served to the session, 404 on the public /media route', async () => {
    assert.ok(called('media.create').length >= 0);
    const original = expenseModel.getById;
    mock.method(expenseModel, 'getById', async (id) => ({ ...(await original(id)), receipt_media_id: 1 }));
    const res = await admin.get('/admin/expenses/21/receipt');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(res.headers.get('cache-control'), /private/);
    assert.equal((await fetch(`${fx.base}/media/1-chung-tu.jpg`)).status, 404, 'not on the public route');
    assert.equal((await fetch(`${fx.base}/admin/expenses/21/receipt`, { redirect: 'manual' })).status, 303, 'logged out: sent to the login page');
    expenseModel.getById.mock.restore();
    assert.equal((await admin.get('/admin/expenses/22/receipt')).status, 404, 'no photo');
  });

  await t.test('a cashier cannot open the expense book', async () => {
    const { c: cashier } = await fx.login('thungan', PASSWORD);
    assert.equal((await cashier.get('/admin/expenses')).status, 303);
    assert.equal((await cashier.get('/admin/expenses/21/receipt')).status, 303);
  });
});
