const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start, PASSWORD } = require('./helpers/adminFixture');

const jpeg = (fill = 7) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, fill)]).toString('base64')}`;
const flat = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('finance API for the app + the tax page', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const expenseModel = require('../src/models/expenseModel');
  const taxModel = require('../src/models/taxModel');
  const called = (n) => fx.calls.filter((c) => c.name === n);

  async function api(method, path, { token, json, headers = {} } = {}) {
    const res = await fetch(fx.base + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: json ? JSON.stringify(json) : undefined });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }
  const login = async (username) => (await api('POST', '/api/auth/login', { json: { username, password: PASSWORD } })).body.token;
  const boss = await login('boss');
  const cashier = await login('thungan');
  const today = new Date().toISOString().slice(0, 10);

  await t.test('every route is admin only; a cashier gets 403, no token 401, and other routes stay open to staff', async () => {
    for (const [m, p] of [['GET', '/api/expenses'], ['POST', '/api/expenses'], ['GET', '/api/expense-categories'], ['GET', '/api/finance/dashboard'], ['GET', '/api/tax/rates'], ['POST', '/api/tax/exports'], ['GET', '/api/tax/exports'], ['POST', '/api/tax/periods/lock']]) {
      assert.equal((await api(m, p, { token: cashier, json: m === 'POST' ? {} : undefined })).status, 403, `${m} ${p} for a cashier`);
      assert.equal((await api(m, p, { json: m === 'POST' ? {} : undefined })).status, 401, `${m} ${p} without a token`);
    }
    assert.equal((await api('GET', '/api/tables', { token: cashier })).status, 200, 'the admin guard of the finance routes does not leak onto routes mounted after it');
    assert.equal((await api('GET', '/api/pos/bootstrap', { token: cashier })).status, 200);
  });

  await t.test('categories and the expense list (keyset pages, totals follow the filter)', async () => {
    const cats = await api('GET', '/api/expense-categories', { token: boss });
    assert.equal(cats.status, 200);
    assert.deepEqual(Object.keys(cats.body.categories[0]).sort(), ['code', 'id', 'is_active', 'ledger_code', 'name', 'tax_treatment']);
    const seen = [];
    mock.method(expenseModel, 'listPage', async (q) => { seen.push(q); return [{ id: 22, expense_date: '2026-10-17', category_id: 1, category_name: 'NVL', tax_treatment: 'deductible', amount: 1000000, vat_included: 0, payee: 'NCC A', purchase_receipt_id: 5, receipt_code: 'PN1', doc_no: '', note: '', receipt_media_id: null, source: 'purchase', status: 'posted', user_name: 'Chủ Quán', created_at: new Date() }, { id: 21, expense_date: '2026-10-05', category_id: 2, category_name: 'Thuê', tax_treatment: 'deductible', amount: 8000000, vat_included: 1, payee: 'Chủ nhà', purchase_receipt_id: null, receipt_code: null, doc_no: 'PC-01', note: 'T10', receipt_media_id: 7, source: 'manual', status: 'posted', user_name: 'Chủ Quán', created_at: new Date() }]; });
    try {
      const r = await api('GET', '/api/expenses?limit=1&from=2026-10-01&to=2026-10-31&cat=2&q=nha&src=manual', { token: boss });
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 1);
      assert.equal(r.body.next_before_id, 22, 'a second page exists: ask with before_id=22');
      assert.deepEqual(r.body.items[0], { ...r.body.items[0], id: 22, date: '2026-10-17', category: 'NVL', amount: 1000000, source: 'purchase', has_receipt: false, purchase_receipt_code: 'PN1' });
      assert.deepEqual(r.body.totals, { count: 2, amount: 9000000, purchases: 1000000, manual: 8000000, deductible: 9000000 });
      assert.deepEqual([seen[0].limit, seen[0].categoryId, seen[0].from, seen[0].to, seen[0].source, seen[0].status], [2, 2, '2026-10-01', '2026-10-31', 'manual', 'posted'], 'one extra row is read to know whether there is a next page');
      const all = await api('GET', '/api/expenses?before_id=22&void=1', { token: boss });
      assert.equal(seen[1].beforeId, 22);
      assert.equal(seen[1].status, undefined, 'void=1 lists voided rows too');
      assert.equal(all.body.next_before_id, null, 'last page');
    } finally { expenseModel.listPage.mock.restore(); }
  });

  await t.test('create (with idempotency), update, void and receipt photo over the API', async () => {
    fx.calls.length = 0;
    const body = { expense_date: today, category_id: 2, amount: 8000000, payee: 'Chủ nhà', doc_no: 'PC-9', note: 'T10', vat_included: true, image_data: jpeg(4) };
    const key = { 'idempotency-key': 'exp-create-1' };
    const r = await api('POST', '/api/expenses', { token: boss, json: body, headers: key });
    assert.equal(r.status, 201);
    assert.equal(r.body.expense.id, 21, 'the row read back (fixture)');
    const e = called('expense.insert')[0].args[0];
    assert.deepEqual([e.expenseDate, e.categoryId, e.amount, e.vatIncluded, e.source, e.createdBy], [today, 2, 8000000, true, 'manual', 1]);
    assert.ok(e.receiptMediaId > 0 && /^[0-9a-f]{64}$/.test(e.receiptSha256));
    const again = await api('POST', '/api/expenses', { token: boss, json: body, headers: key });
    assert.equal(again.status, 201);
    assert.equal(called('expense.insert').length, 1, 'a replay with the same Idempotency-Key books nothing twice');
    assert.equal((await api('POST', '/api/expenses', { token: boss, json: { ...body, amount: 0 } })).status, 400);
    assert.equal((await api('POST', '/api/expenses', { token: boss, json: { ...body, category_id: 99 } })).status, 400);
    assert.equal((await api('POST', '/api/expenses', { token: boss, json: { ...body, image_data: 'data:text/plain;base64,QQ==' } })).status, 400);

    fx.calls.length = 0;
    assert.equal((await api('PUT', '/api/expenses/21', { token: boss, json: { ...body, amount: 8500000, image_data: undefined, remove_image: true } })).status, 200);
    assert.equal(called('expense.update')[0].args[1].amount, 8500000);
    assert.equal(called('expense.setReceipt')[0].args[1], null);
    fx.calls.length = 0;
    assert.equal((await api('PUT', '/api/expenses/22', { token: boss, json: { category_id: 3, note: 'Máy xay', amount: 1 } })).status, 200);
    assert.equal(called('expense.update').length, 0, 'purchase rows only take category and note');
    assert.equal(called('expense.setCat')[0].args[1].categoryId, 3);
    assert.equal((await api('PUT', '/api/expenses/99', { token: boss, json: body })).status, 404);

    fx.calls.length = 0;
    assert.equal((await api('POST', '/api/expenses/21/void', { token: boss, json: { reason: '' } })).status, 400);
    assert.equal((await api('POST', '/api/expenses/22/void', { token: boss, json: { reason: 'nhầm' } })).status, 409);
    assert.equal((await api('POST', '/api/expenses/21/void', { token: boss, json: { reason: 'Nhập trùng' } })).status, 200);
    assert.deepEqual(called('expense.void')[0].args.slice(0, 3), [21, 'Nhập trùng', 1]);

    const original = expenseModel.getById;
    mock.method(expenseModel, 'getById', async (id) => ({ ...(await original(id)), receipt_media_id: 1 }));
    try {
      const photo = await api('GET', '/api/expenses/21/receipt', { token: boss });
      assert.equal(photo.status, 200);
      assert.equal(photo.headers.get('content-type'), 'image/jpeg');
      assert.equal((await api('GET', '/api/expenses/21/receipt')).status, 401);
    } finally { expenseModel.getById.mock.restore(); }
    assert.equal((await api('GET', '/api/expenses/22/receipt', { token: boss })).status, 404, 'no photo on that row');
  });

  await t.test('finance dashboard: snake_case estimate, period neighbours, 6 months', async () => {
    const r = await api('GET', '/api/finance/dashboard?kind=quarter&date=2026-11-15', { token: boss });
    assert.equal(r.status, 200);
    assert.equal(r.body.estimated, true);
    assert.deepEqual(r.body.period, { kind: 'quarter', from: '2026-10-01', to: '2026-12-31', label: 'Quý 4/2026' });
    assert.equal(r.body.prev.from, '2026-07-01');
    assert.equal(r.body.next.from, '2027-01-01');
    const e = r.body.estimate;
    assert.deepEqual([e.revenue.net, e.vat, e.pit, e.tax, e.taxable_revenue], [500000000, 7800000, 3900000, 11700000, 300000000]);
    assert.deepEqual(e.year, { before: 300000000, through: 800000000, threshold: 500000000, exempt: false, remaining: 0 });
    assert.deepEqual(e.expenses, { deductible: 80000000, non_deductible: 2000000, capex: 3500000, total: 85500000 });
    assert.equal(e.categories[0].name, 'Dịch vụ ăn uống');
    assert.equal(r.body.lock, null);
    assert.equal(r.body.months.length, 2);
    assert.equal((await api('GET', '/api/finance/dashboard?kind=weekly', { token: boss })).body.period.kind, 'month', 'an unknown kind falls back to the month');
  });

  await t.test('lock / unlock / filed', async () => {
    fx.calls.length = 0;
    assert.equal((await api('POST', '/api/tax/periods/lock', { token: boss, json: { kind: 'month', date: today } })).status, 409, 'the current month is not over');
    const ok = await api('POST', '/api/tax/periods/lock', { token: boss, json: { kind: 'month', date: '2026-08-10' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.period.from, '2026-08-01');
    assert.equal(called('tax.lock')[0].args[0].kind, 'month');
    assert.equal((await api('POST', '/api/tax/periods/lock', { token: boss, json: { kind: 'decade' } })).status, 400);
    assert.equal((await api('POST', '/api/tax/periods/unlock', { token: boss, json: { kind: 'month', date: '2026-08-10' } })).status, 404, 'fixture: nothing stored');
  });

  await t.test('rates and exports: queue, poll, download', async () => {
    const rates = await api('GET', '/api/tax/rates', { token: boss });
    assert.equal(rates.body.rates[0].vat_rate, 0.03);
    assert.deepEqual(rates.body.config, { exempt_threshold: 500000000, pit_method: 'revenue', profit_rate: 0.15 });
    fx.calls.length = 0;
    const q = await api('POST', '/api/tax/exports', { token: boss, json: { kind: 'bundle', from: '2026-07-01', to: '2026-09-30' } });
    assert.equal(q.status, 202);
    assert.equal(q.body.export.id, 11);
    assert.deepEqual(called('export.insert')[0].args[0], { kind: 'bundle', from: '2026-07-01', to: '2026-09-30', userId: 1 });
    assert.equal((await api('POST', '/api/tax/exports', { token: boss, json: { kind: 'x', from: '2026-07-01', to: '2026-09-30' } })).status, 400);
    assert.equal((await api('POST', '/api/tax/exports', { token: boss, json: { kind: 'bundle', from: '2026-09-30', to: '2026-07-01' } })).status, 400);
    const list = await api('GET', '/api/tax/exports', { token: boss });
    assert.equal(list.body.exports[0].downloadable, true);
    assert.deepEqual(Object.keys(list.body.exports[0]).sort(), ['created_at', 'downloadable', 'error', 'expires_at', 'file_bytes', 'file_name', 'finished_at', 'from', 'id', 'kind', 'status', 'to']);
    assert.equal((await api('GET', '/api/tax/exports/11', { token: boss })).body.export.status, 'done');
    assert.equal((await api('GET', '/api/tax/exports/99', { token: boss })).status, 404);
    assert.equal((await api('GET', '/api/tax/exports/11/file', { token: boss })).status, 404, 'the file is not on disk in this test: a clear 404');
  });

  await t.test('web: the tax page shows the estimate, the lock state, the exports and the configuration', async () => {
    const { c: admin } = await fx.login();
    const token = await fx.csrfOf(admin);
    const html = await (await admin.get('/admin/tax?kind=quarter&date=2026-11-15')).text();
    const text = flat(html);
    assert.match(text, /Quý 4\/2026/);
    assert.match(text, /Doanh thu thuần 500\.000\.000đ/);
    assert.match(text, /Thuế ước tính 11\.700\.000đ GTGT 7\.800\.000đ · TNCN 3\.900\.000đ/);
    assert.match(text, /Lũy kế đến hết kỳ: 800\.000\.000đ/);
    assert.match(text, /Dịch vụ ăn uống 400\.000\.000đ/);
    assert.match(text, /Gói đủ các sổ/);
    assert.match(text, /Tải về \(20 KB\)/);
    assert.match(html, /name="exempt_threshold"[^>]*value="500000000"/);
    assert.match(html, /<option value="revenue" selected>/);
    assert.ok(html.includes('href="/admin/tax?kind=quarter&amp;date=2026-07-01"'), 'previous period link');

    fx.calls.length = 0;
    const post = (url, body) => admin.post(url, { _csrf: token, _back: '/admin/tax', ...body });
    await post('/admin/tax/exports', { export_kind: 'declaration', from: '2026-07-01', to: '2026-09-30' });
    assert.equal(called('export.insert')[0].args[0].kind, 'declaration');
    await post('/admin/tax/exports', { export_kind: 'zzz', from: '2026-07-01', to: '2026-09-30' });
    assert.equal(called('export.insert').length, 1);
    const settings = [];
    mock.method(require('../src/models/settingsModel'), 'setMany', async (v) => { settings.push(v); });
    try {
      await post('/admin/tax/config', { exempt_threshold: '1000000000', pit_method: 'profit', profit_rate_pct: '17' });
      assert.deepEqual(settings[0], { 'tax.exemptThreshold': '1000000000', 'tax.pitMethod': 'profit', 'tax.profitRate': '0.17' });
    } finally { require('../src/models/settingsModel').setMany.mock.restore(); }
    await post('/admin/tax/rates', { category_id: '1', effective_from: '2027-01-01', vat_pct: '2', pit_pct: '1', legal_basis: 'NĐ giả định' });
    const rate = called('tax.addRate')[0].args[0];
    assert.deepEqual([rate.categoryId, rate.effectiveFrom, rate.vatRate, rate.pitRate], [1, '2027-01-01', 0.02, 0.01]);
    await post('/admin/tax/lock', { kind: 'month', date: today });
    assert.equal(called('tax.lock').length, 0, 'the running month cannot be locked');
    const json = await (await admin.get('/admin/tax/exports.json')).json();
    assert.equal(json.exports[0].ready, true);
    assert.equal((await admin.get('/admin/tax/exports/11/file')).status, 404);
    const { c: cashier } = await fx.login('thungan', PASSWORD);
    assert.equal((await cashier.get('/admin/tax')).status, 303, 'cashiers cannot open the tax page');
  });

  await t.test('a locked period refuses expense changes (create, update, void)', async () => {
    mock.method(taxModel, 'lockedCovering', async () => ({ id: 1, kind: 'month', period_from: '2026-10-01', period_to: '2026-10-31' }));
    try {
      fx.calls.length = 0;
      const r = await api('POST', '/api/expenses', { token: boss, json: { expense_date: today, category_id: 2, amount: 1000 } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'PERIOD_LOCKED');
      assert.equal((await api('POST', '/api/expenses/21/void', { token: boss, json: { reason: 'x' } })).status, 409);
      assert.equal((await api('PUT', '/api/expenses/21', { token: boss, json: { expense_date: today, category_id: 2, amount: 5 } })).status, 409);
      assert.equal(called('expense.insert').length + called('expense.update').length + called('expense.void').length, 0);
    } finally { taxModel.lockedCovering.mock.restore(); }
  });
});
