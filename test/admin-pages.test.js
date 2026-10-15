/**
 * Web Admin: authentication, CSRF, every module page, and the form POSTs - all against the real Express app and
 * real EJS views, with the data layer faked (see helpers/adminFixture.js). No MySQL needed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, PASSWORD } = require('./helpers/adminFixture');

test('admin pages', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const called = (name) => fx.calls.filter((c) => c.name === name);
  const reset = () => { fx.calls.length = 0; };

  await t.test('everything except /login redirects to the login form when signed out', async () => {
    const c = fx.client();
    for (const p of ['/admin', '/admin/dashboard', '/admin/orders', '/admin/settings']) {
      const res = await c.get(p);
      assert.equal(res.status, 303, p);
      assert.match(res.headers.get('location'), /^\/admin\/(login|dashboard)/);
    }
    const res = await c.get('/admin/orders?status=draft');
    assert.equal(res.headers.get('location'), '/admin/login?next=%2Fadmin%2Forders%3Fstatus%3Ddraft');
    const post = await c.post('/admin/tables', { code: 'X', name: 'X' });
    assert.equal(post.headers.get('location'), '/admin/login', 'a signed-out POST never reaches a controller');
    assert.equal(called('table.create').length, 0);
  });

  await t.test('login page renders with CSP nonce and no inline handlers', async () => {
    const res = await fx.client().get('/admin/login');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /name="username"/);
    assert.match(html, /name="password" type="password"/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self' 'nonce-/);
    assert.ok(!/\son[a-z]+\s*=/i.test(html));
  });

  await t.test('wrong password / unknown user are refused without a session', async () => {
    for (const [u, p, status, msg] of [['boss', 'nope-nope-nope', 401, /Sai tên đăng nhập/], ['ghost', PASSWORD, 401, /Sai tên đăng nhập/]]) {
      const { c, res } = await fx.login(u, p);
      assert.equal(res.status, status, u);
      assert.match(await res.text(), msg);
      assert.equal(c.jar.has('cc_admin'), false);
    }
  });

  await t.test('successful login: HttpOnly + SameSite=Strict cookie scoped to /admin, then the dashboard works', async () => {
    const { c, res } = await fx.login();
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/dashboard');
    const setCookie = res.headers.getSetCookie().find((x) => x.startsWith('cc_admin='));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\/admin/i);
    const dash = await c.get('/admin/dashboard');
    assert.equal(dash.status, 200);
    const html = await dash.text();
    assert.match(html, /Doanh thu hôm nay/);
    assert.match(html, /400\.000đ/);
    assert.match(html, /Chủ Quán/);
    assert.match(html, /Sữa tươi/, 'low-stock item from the data layer');
    assert.match(html, /CF261013-00042/);
  });

  await t.test('?next= only honours same-site /admin paths (no open redirect)', async () => {
    for (const [next, want] of [['/admin/orders', '/admin/orders'], ['//evil.example', '/admin/dashboard'], ['https://evil.example', '/admin/dashboard'], ['/admin/../x', '/admin/dashboard']]) {
      const c = fx.client();
      const res = await c.post('/admin/login', { username: 'boss', password: PASSWORD, next });
      assert.equal(res.headers.get('location'), want, next);
    }
  });

  await t.test('a weak password forces the change-password page before anything else', async () => {
    const { c, res } = await fx.login('admin', 'admin');
    assert.equal(res.headers.get('location'), '/admin/settings/password');
    for (const p of ['/admin/dashboard', '/admin/orders']) {
      const r = await c.get(p);
      assert.equal(r.headers.get('location'), '/admin/settings/password', p);
    }
    const page = await c.get('/admin/settings/password');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Mật khẩu hiện tại quá yếu/);
    assert.ok(!html.includes('Tài khoản nhân viên'), 'staff management is hidden until the password is changed');
    const token = /name="_csrf" value="([0-9a-f]+)"/.exec(html)[1];
    reset();
    const bad = await c.post('/admin/settings/password', { _csrf: token, _back: '/admin/settings/password', current_password: 'admin', new_password: 'short', confirm_password: 'short' });
    assert.equal(bad.headers.get('location'), '/admin/settings/password');
    assert.equal(called('user.setPassword').length, 0);
    const ok = await c.post('/admin/settings/password', { _csrf: token, _back: '/admin/settings/password', current_password: 'admin', new_password: 'A-much-better-pw1', confirm_password: 'A-much-better-pw1' });
    assert.equal(ok.headers.get('location'), '/admin/settings');
    assert.equal(called('user.setPassword').length, 1);
    assert.notEqual(called('user.setPassword')[0].args[1], 'A-much-better-pw1', 'only a hash is stored');
    assert.equal((await c.get('/admin/dashboard')).status, 200, 'restrictions lifted after the change');
  });

  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);

  await t.test('every module page renders for an admin, with its real data and a CSP nonce', async () => {
    const checks = {
      '/admin/dashboard': [/Tổng quan/],
      '/admin/tables': [/Bàn 1/, /Có khách/, /Trống/],
      '/admin/orders': [/CF261013-00042/, /Chờ thu tiền/, /aria-current="page"[^>]*>1<\/a>/, /href="\/admin\/orders\?page=3"/, /237\.000đ/, /In hóa đơn CF261013-00042/],
      '/admin/orders/42': [/Cà phê sữa đá/, /ít đá/, /Gửi lại bill qua Zalo/, /Thu 79\.000đ/, /Zalo 500/],
      '/admin/menu': [/cf sữa/, /Thuốc lá 555/, /Ngừng bán/],
      '/admin/inventory': [/Sữa tươi/, /Sắp hết/, /Giá trị tồn kho/],
      '/admin/inventory/2': [/Lịch sử xuất nhập/, /Nhập kho/, /Bán hàng/],
      '/admin/receiving': [/Phiếu nhập/, /NCC A/],
      '/admin/bom-recipes': [/Cà phê sữa đá/, /Chưa có định mức/, /Hàng bán lẻ/],
      '/admin/reports': [/Doanh thu theo ngày/, /Món bán chạy/, /Chưa thu tiền/],
      '/admin/zalo': [/Webhook/, /user_send_text/, /CF-D/],
      '/admin/settings': [/Đổi mật khẩu/, /Tài khoản nhân viên/, /Cấu hình hệ thống/],
      '/admin/backup': [/Sao lưu ngay/, /Sao lưu tự động/],
    };
    for (const [path, patterns] of Object.entries(checks)) {
      const res = await admin.get(path);
      const html = await res.text();
      assert.equal(res.status, 200, path);
      for (const re of patterns) assert.match(html, re, `${path} should match ${re}`);
      const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy'))[1];
      const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/json)([^>]*)>/g)];
      assert.ok(inline.length >= 2 && inline.every((m) => m[1].includes(`nonce="${nonce}"`)), `${path}: inline scripts carry the nonce`);
      assert.ok(!/\son[a-z]+\s*=/i.test(html), `${path}: no inline handlers`);
      assert.match(html, /name="_csrf"/, `${path}: forms carry a CSRF token`);
      assert.ok(!html.includes('Dữ liệu mẫu'), `${path}: sample-data banner is gone`);
    }
  });

  await t.test('Zalo screen never leaks token values, and escapes event errors', async () => {
    const html = await (await admin.get('/admin/zalo')).text();
    assert.ok(!html.includes('SECRET-ACCESS') && !html.includes('SECRET-REFRESH'));
    assert.ok(!html.includes('boom <script>'));
    assert.match(html, /boom &lt;script&gt;/);
  });

  await t.test('unknown page and unknown order give an HTML error page, not JSON', async () => {
    const nf = await admin.get('/admin/nope');
    assert.equal(nf.status, 404);
    assert.match(await nf.text(), /Không tìm thấy trang/);
    const missing = await admin.get('/admin/orders/404');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type'), /html/);
  });

  await t.test('POST without / with a wrong CSRF token is bounced before the controller runs', async () => {
    reset();
    for (const form of [{ code: 'B9', name: 'Bàn 9' }, { _csrf: 'f'.repeat(token.length), code: 'B9', name: 'Bàn 9' }, { _csrf: 'short', code: 'B9', name: 'Bàn 9' }]) {
      const res = await admin.post('/admin/tables', { ...form, _back: '/admin/tables' });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/admin/tables');
    }
    assert.equal(called('table.create').length, 0);
    const html = await (await admin.get('/admin/tables')).text();
    assert.match(html, /Phiên làm việc đã hết hạn/, 'flash message shown once');
    assert.ok(!(await (await admin.get('/admin/tables')).text()).includes('Phiên làm việc đã hết hạn'), 'and not shown again');
  });

  await t.test('tables: create + deactivate rules', async () => {
    reset();
    const created = await admin.post('/admin/tables', { _csrf: token, _back: '/admin/tables', code: 'B9', name: 'Bàn 9', capacity: '6' });
    assert.equal(created.headers.get('location'), '/admin/tables');
    assert.deepEqual(called('table.create')[0].args[0], { code: 'B9', name: 'Bàn 9', capacity: 6 });
    assert.match(await (await admin.get('/admin/tables')).text(), /Đã thêm bàn B9/);

    reset();
    await admin.post('/admin/tables/1', { _csrf: token, _back: '/admin/tables', is_active: '0' });      // table 1 is serving
    assert.equal(called('table.update').length, 0, 'a table with an open order cannot be retired');
    assert.match(await (await admin.get('/admin/tables')).text(), /Bàn đang có đơn/);
    await admin.post('/admin/tables/2', { _csrf: token, _back: '/admin/tables', is_active: '0' });
    assert.equal(called('table.update')[0].args[1].is_active, 0);
  });

  await t.test('orders: filters are validated, pay/cancel/resend hit the service with the right arguments', async () => {
    const html = await (await admin.get('/admin/orders?status=bogus&from=2026-02-31&page=abc&q=%25_')).text();
    assert.match(html, /CF261013-00042/, 'garbage filters are ignored instead of erroring');

    reset();
    const pay = await admin.post('/admin/orders/42/pay', { _csrf: token, _back: '/admin/orders/42', method: 'transfer', reference: 'FT123', discount: '' });
    assert.equal(pay.headers.get('location'), '/admin/orders/42');
    const [id, opts] = called('order.pay')[0].args;
    assert.equal(id, 42);
    assert.equal(opts.method, 'transfer');
    assert.equal(opts.userId, 1);
    assert.equal(opts.discount, undefined);

    // "Thu tiền" on a Zalo order tells the customer on Zalo and says so to the owner
    reset();
    const paymentNotification = require('../src/services/zalo/paymentNotificationService');
    const confirm = require('node:test').mock.method(paymentNotification, 'notifyOrderPaidSoon', async () => 'sent');
    await admin.post('/admin/orders/42/pay', { _csrf: token, _back: '/admin/orders/42', method: 'cash' });
    assert.deepEqual(confirm.mock.calls[0].arguments, [42]);
    assert.match(await (await admin.get('/admin/orders/42')).text(), /Đã gửi xác nhận thanh toán cho khách qua Zalo/);
    confirm.mock.restore();

    reset();
    await admin.post('/admin/orders/42/pay', { _csrf: token, _back: '/admin/orders/42', method: 'bitcoin' });
    assert.equal(called('order.pay').length, 0, 'unknown payment method is rejected');
    assert.match(await (await admin.get('/admin/orders/42')).text(), /Hình thức thanh toán must be one of/);

    await admin.post('/admin/orders/42/cancel', { _csrf: token, _back: '/admin/orders/42' });
    assert.equal(called('order.cancel')[0].args[0], 42);
    await admin.post('/admin/orders/42/resend-receipt', { _csrf: token, _back: '/admin/orders/42' });
    assert.equal(called('receipt.send')[0].args[0], 42);
  });

  await t.test('inventory: receive, adjust, create go through the stock service', async () => {
    reset();
    const recv = await admin.post('/admin/receiving', { _csrf: token, _back: '/admin/receiving', inventory_item_id: '1', quantity: '1000', unit_cost: '300', note: 'NCC B' });
    assert.equal(recv.headers.get('location'), '/admin/receiving');
    const [, itemId, qty, cost, meta] = called('inventory.receive')[0].args;
    assert.deepEqual([itemId, qty, cost, meta.userId, meta.note], [1, 1000, 300, 1, 'NCC B']);
    assert.match(await (await admin.get('/admin/receiving')).text(), /Đã nhập kho/);

    reset();
    await admin.post('/admin/receiving', { _csrf: token, _back: '/admin/receiving', inventory_item_id: '1', quantity: '-5', unit_cost: '300' });
    assert.equal(called('inventory.receive').length, 0, 'negative quantity rejected');

    await admin.post('/admin/inventory/2/adjust', { _csrf: token, _back: '/admin/inventory', new_quantity: '100', type: 'waste', note: 'đổ' });
    const adj = called('inventory.adjust')[0].args;
    assert.deepEqual([adj[1], adj[2], adj[3].type], [2, 100, 'waste']);

    await admin.post('/admin/inventory', { _csrf: token, _back: '/admin/inventory', sku: 'DUONG', name: 'Đường', unit: 'g', min_stock: '200', quantity_on_hand: '500', avg_cost: '20' });
    assert.equal(called('inventory.create')[0].args[0].sku, 'DUONG');
    assert.equal(called('inventory.receive').length, 1 + 0, 'opening balance is booked as a purchase movement');

    reset();
    await admin.post('/admin/inventory', { _csrf: token, _back: '/admin/inventory', sku: 'DA', name: 'Đá', unit: 'g', quantity_on_hand: '500', avg_cost: '' });
    assert.equal(called('inventory.create').length, 0, 'opening stock without a cost is refused (it would zero COGS)');
  });

  await t.test('BOM: create/update merge duplicate lines; invalid recipes are refused; delete only takes it off the menu', async () => {
    reset();
    const recipe = JSON.stringify([{ inventory_item_id: 1, quantity: 18 }, { inventory_item_id: 3, quantity: 1 }, { inventory_item_id: 1, quantity: 2 }]);
    await admin.post('/admin/bom-recipes', { _csrf: token, _back: '/admin/bom-recipes', name: 'Bạc xỉu', sku: 'BAC-XIU', price: '29000', category_id: '1', recipe });
    assert.equal(called('product.create')[0].args[0].stock_mode, 'bom');
    assert.deepEqual(called('product.setRecipe')[0].args[1], [{ inventory_item_id: 1, quantity: 20 }, { inventory_item_id: 3, quantity: 1 }]);
    assert.equal(called('product.setAliases')[0].args[1], 'Bạc xỉu');

    reset();
    for (const bad of ['[]', 'not json', JSON.stringify([{ inventory_item_id: 1, quantity: 0 }]), JSON.stringify([{ inventory_item_id: 'x', quantity: 1 }])]) {
      await admin.post('/admin/bom-recipes', { _csrf: token, _back: '/admin/bom-recipes', name: 'X', sku: 'X', price: '1', category_id: '1', recipe: bad });
    }
    assert.equal(called('product.create').length, 0);

    reset();
    await admin.post('/admin/bom-recipes/1', { _csrf: token, _back: '/admin/bom-recipes', name: 'Cà phê sữa', sku: 'IGNORED', price: '26000', category_id: '1', recipe });
    const upd = called('product.update')[0].args;
    assert.equal(upd[0], 1);
    assert.equal(upd[1].name, 'Cà phê sữa');
    assert.equal(upd[1].inventory_item_id, null);
    assert.deepEqual(called('product.setAliases')[0].args.slice(1, 3), ['Cà phê sữa', ['cf sữa']], 'old name keyword dropped, custom keywords kept');

    reset();
    await admin.post('/admin/bom-recipes/2', { _csrf: token, _back: '/admin/bom-recipes', name: 'x', price: '1', category_id: '1', recipe });
    assert.equal(called('product.update').length, 0, 'retail goods have no recipe');
    await admin.post('/admin/bom-recipes/1/delete', { _csrf: token, _back: '/admin/bom-recipes' });
    assert.deepEqual(called('product.setActive')[0].args.slice(0, 2), [1, false]);
  });

  await t.test('menu: retail product create/update + aliases + categories', async () => {
    reset();
    await admin.post('/admin/menu/products', { _csrf: token, _back: '/admin/menu', sku: 'NUOC', name: 'Nước suối', price: '10000', category_id: '2', inventory_item_id: '3', aliases: 'nuoc suoi\nlavie, aquafina' });
    assert.equal(called('product.create')[0].args[0].stock_mode, 'direct');
    assert.deepEqual(called('product.setAliases')[0].args[2], ['nuoc suoi', 'lavie', 'aquafina']);

    reset();
    await admin.post('/admin/menu/products', { _csrf: token, _back: '/admin/menu', sku: 'NUOC', name: 'Nước suối', price: '10000', category_id: '2' });
    assert.equal(called('product.create').length, 0, 'retail goods need a stock link');

    reset();
    await admin.post('/admin/menu/products/2', { _csrf: token, _back: '/admin/menu', name: 'Thuốc lá 555', price: '62000', category_id: '2', inventory_item_id: '', is_active: ['0', '1'] });
    const u = called('product.update')[0].args[1];
    assert.equal(u.price, 62000);
    assert.equal(u.inventory_item_id, 3, 'blank select keeps the existing stock link');

    reset();
    await admin.post('/admin/menu/categories', { _csrf: token, _back: '/admin/menu', code: 'Bad Code!', name: 'X' });
    assert.equal(called('category.create').length, 0);
    await admin.post('/admin/menu/categories', { _csrf: token, _back: '/admin/menu', code: 'snack', name: 'Đồ ăn vặt', sort_order: '5' });
    assert.deepEqual(called('category.create')[0].args[0], { code: 'snack', name: 'Đồ ăn vặt', sort_order: 5, is_active: undefined });

    reset();   // the "active" checkbox of the create dialogs is honoured (hidden 0 alone = unchecked)
    await admin.post('/admin/menu/categories', { _csrf: token, _back: '/admin/menu', code: 'hidden_one', name: 'Ẩn', is_active: '0' });
    assert.equal(called('category.create')[0].args[0].is_active, 0);
    await admin.post('/admin/menu/products', { _csrf: token, _back: '/admin/menu', sku: 'N2', name: 'Nước 2', price: '10000', category_id: '2', inventory_item_id: '3', is_active: '0' });
    assert.equal(called('product.create')[0].args[0].is_active, 0);
  });

  await t.test('settings: staff management guards', async () => {
    reset();
    await admin.post('/admin/settings/users', { _csrf: token, _back: '/admin/settings', username: 'Bad Name', full_name: 'X', role: 'cashier', password: 'long-enough-pw' });
    await admin.post('/admin/settings/users', { _csrf: token, _back: '/admin/settings', username: 'newbie', full_name: 'X', role: 'cashier', password: 'short' });
    await admin.post('/admin/settings/users', { _csrf: token, _back: '/admin/settings', username: 'newbie', full_name: 'X', role: 'owner', password: 'long-enough-pw' });
    assert.equal(called('user.create').length, 0);
    await admin.post('/admin/settings/users', { _csrf: token, _back: '/admin/settings', username: 'newbie', full_name: 'Nhân viên mới', role: 'cashier', password: 'long-enough-pw' });
    const created = called('user.create')[0].args[0];
    assert.equal(created.username, 'newbie');
    assert.match(created.passwordHash, /^\$2[aby]\$/);

    reset();
    await admin.post('/admin/settings/users/1/active', { _csrf: token, _back: '/admin/settings', active: '0' });     // yourself
    assert.equal(called('user.setActive').length, 0, 'cannot lock your own account');
    await admin.post('/admin/settings/users/2/active', { _csrf: token, _back: '/admin/settings', active: '0' });
    assert.deepEqual(called('user.setActive')[0].args.slice(0, 2), [2, false]);
    await admin.post('/admin/settings/users/2/password', { _csrf: token, _back: '/admin/settings', password: 'tiny' });
    assert.equal(called('user.setPassword').length, 0);
    await admin.post('/admin/settings/users/2/password', { _csrf: token, _back: '/admin/settings', password: 'a-new-long-pass' });
    assert.equal(called('user.setPassword')[0].args[0], 2);
  });

  await t.test('reports: range parsing falls back safely and presets are linkable', async () => {
    const { readRange, presets } = require('../src/controllers/admin/reports');
    assert.deepEqual(readRange({ from: '2026-10-01', to: '2026-10-13' }, '2026-10-13'), { from: '2026-10-01', to: '2026-10-13' });
    assert.deepEqual(readRange({ from: '2026-10-13', to: '2026-10-01' }, '2026-10-13'), { from: '2026-10-01', to: '2026-10-13' }, 'reversed range is swapped');
    assert.deepEqual(readRange({}, '2026-10-13'), { from: '2026-10-07', to: '2026-10-13' });
    assert.deepEqual(readRange({ from: 'garbage' }, '2026-10-13'), { from: '2026-10-07', to: '2026-10-13' });
    assert.equal(readRange({ from: '2020-01-01', to: '2026-10-13' }, '2026-10-13').clamped, true);
    const p = Object.fromEntries(presets('2026-03-05').map((x) => [x.key, x]));
    assert.deepEqual([p.month.from, p.month.to, p.last_month.from, p.last_month.to], ['2026-03-01', '2026-03-05', '2026-02-01', '2026-02-28']);
    const res = await admin.get('/admin/reports?from=2026-10-01&to=2026-10-13');
    assert.match(await res.text(), /01\/10\/2026 – 13\/10\/2026/);
  });

  await t.test('DEMO_MODE: credentials on the login page, no forced change, account cannot be changed or locked', async () => {
    const env = require('../src/config/env');
    const before = { ...env.demo };
    Object.assign(env.demo, { enabled: true, username: 'admin', password: 'admin' });
    fx.resetPasswords();                       // an earlier test changed admin's password
    try {
      const html = await (await fx.client().get('/admin/login')).text();
      assert.match(html, /Tài khoản demo/);
      const { c, res } = await fx.login('admin', 'admin');
      assert.equal(res.headers.get('location'), '/admin/dashboard', 'demo account is not sent to the change-password page');
      assert.equal((await c.get('/admin/orders')).status, 200);
      const tok = await fx.csrfOf(c);
      reset();
      await c.post('/admin/settings/password', { _csrf: tok, _back: '/admin/settings', current_password: 'admin', new_password: 'A-much-better-pw1', confirm_password: 'A-much-better-pw1' });
      await c.post('/admin/settings/users/3/password', { _csrf: tok, _back: '/admin/settings', password: 'A-much-better-pw1' });
      await admin.post('/admin/settings/users/3/active', { _csrf: token, _back: '/admin/settings', active: '0' });
      assert.equal(called('user.setPassword').length, 0);
      assert.equal(called('user.setActive').length, 0);
    } finally {
      Object.assign(env.demo, before);
    }
    assert.doesNotMatch(await (await fx.client().get('/admin/login')).text(), /Tài khoản demo/, 'hidden when DEMO_MODE is off');
  });

  await t.test('POS: cashier signs in straight to the POS and cannot open management pages', async () => {
    const { c, res } = await fx.login('thungan', PASSWORD);
    assert.equal(res.headers.get('location'), '/admin/pos');
    const page = await c.get('/admin/pos');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Bán hàng POS/);
    assert.match(html, /Times New Roman/);
    assert.doesNotMatch(html, /href="\/admin\/dashboard"/, 'no "Quản lý" switch for a cashier');
    assert.doesNotMatch(html, /Trà đào <b>/, 'product names are JSON-escaped');
    assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
    for (const p of ['/admin/dashboard', '/admin/orders', '/admin/settings']) {
      assert.equal((await c.get(p)).headers.get('location'), '/admin/pos', p);
    }
    const tok = /"csrf":"([0-9a-f]+)"/.exec(html)[1];
    reset();
    const post = await c.post('/admin/tables', { _csrf: tok, _back: '/admin/tables', code: 'X', name: 'X' });
    assert.equal(post.status, 403);
    assert.equal(called('table.create').length, 0);
  });

  await t.test('POS: checkout creates + pays; a failed payment cancels the new order; hold needs a table', async () => {
    const { c } = await fx.login('thungan', PASSWORD);
    const html = await (await c.get('/admin/pos')).text();
    const tok = /"csrf":"([0-9a-f]+)"/.exec(html)[1];
    const items = [{ product_id: 1, quantity: 2 }];

    reset();
    let r = await c.postJson('/admin/pos/checkout', { _csrf: tok, table_id: 2, items, method: 'cash', discount: 5000, tendered: 100000 });
    let j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(called('order.createPos')[0].args[0].table_id, 2);
    assert.deepEqual(called('order.createPos')[0].args[0].items, items);
    assert.deepEqual(called('order.pay')[0].args, [77, { method: 'cash', tendered: 100000, discount: 5000, userId: 2 }]);

    reset();   // existing open order of a busy table: items replaced, then paid
    r = await c.postJson('/admin/pos/checkout', { _csrf: tok, order_id: 42, items, method: 'transfer' });
    assert.equal((await r.json()).ok, true);
    assert.equal(called('order.createPos').length, 0);
    assert.equal(called('order.replaceItems')[0].args[0], 42);

    const orderService = require('../src/services/orderService');
    const { AppError } = require('../src/utils/httpError');
    const original = orderService.payOrder;
    orderService.payOrder = async () => { throw new AppError(422, 'INSUFFICIENT_STOCK', 'x', { short: [{ name: 'Sữa', needed: 40, available: 10, unit: 'ml' }] }); };
    try {
      reset();
      r = await c.postJson('/admin/pos/checkout', { _csrf: tok, items, method: 'cash' });
      j = await r.json();
      assert.equal(r.status, 422);
      assert.match(j.message, /Không đủ tồn kho: Sữa/);
      assert.equal(called('order.cancel')[0].args[0], 77, 'the order created for this checkout is cancelled');
    } finally {
      orderService.payOrder = original;
    }

    reset();
    r = await c.postJson('/admin/pos/checkout', { _csrf: tok, items: [], method: 'cash' });
    assert.equal((await r.json()).ok, false);
    r = await c.postJson('/admin/pos/checkout', { _csrf: tok, items, method: 'bitcoin' });
    assert.equal((await r.json()).ok, false);
    r = await c.postJson('/admin/pos/hold', { _csrf: tok, items });
    assert.match((await r.json()).message, /Chọn bàn/);
    r = await c.postJson('/admin/pos/hold', { _csrf: tok, table_id: 2, items });
    assert.equal((await r.json()).ok, true);
    assert.equal(called('order.createPos').length, 1);
    assert.equal(called('order.pay').length, 0, 'hold never takes payment');

    reset();   // wrong CSRF never reaches the service
    r = await c.postJson('/admin/pos/checkout', { _csrf: 'nope', items, method: 'cash' });
    assert.equal(r.status, 303);
    assert.equal(called('order.createPos').length, 0);
  });

  await t.test('POS: 80mm receipt page (print CSS, cash change, frameable by itself only)', async () => {
    const { c } = await fx.login('thungan', PASSWORD);
    const res = await c.get('/admin/pos/receipt/42?print=1&given=100000');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /@page \{ size: 80mm auto; margin: 0; \}/);
    assert.match(html, /CF261013-00042/);
    assert.match(html, /Cà phê sữa đá/);
    assert.match(html, /Tiền thối/);
    assert.match(html, /21\.000đ/, 'change = 100.000 - 79.000');
    assert.match(html, /window\.print\(\)/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.ok(!/\son[a-z]+\s*=/i.test(html));
    const plain = await (await c.get('/admin/pos/receipt/42')).text();
    assert.doesNotMatch(plain, /Tiền thối/, 'no cash block without ?given=');
  });

  await t.test('Zalo Bot Platform token entered in the admin: checked, stored, secret generated, webhook registered', async () => {
    const axios = require('axios');
    const calls = [];
    const original = axios.post;
    axios.post = async (url, body) => {
      const method = url.split('/').pop();
      calls.push({ method, body, tokenOk: url.includes('/bot1234567890:GOOD-TOKEN/') });
      if (!url.includes('GOOD-TOKEN')) return { status: 401, data: { ok: false, description: 'invalid token', error_code: 401 } };
      if (method === 'getMe') return { status: 200, data: { ok: true, result: { id: 'b1', account_name: 'CoCoffee Bot' } } };
      return { status: 200, data: { ok: true, result: { url: body.url, verification: { ok: true, outcome: 'webhook.ok' } } } };
    };
    try {
      const page = await (await admin.get('/admin/zalo')).text();
      assert.match(page, /Zalo Bot Platform/);
      assert.match(page, /name="botToken" type="password"/);

      reset();
      let r = await admin.post('/admin/zalo/bot-token', { _csrf: token, _back: '/admin/zalo', botToken: '1234567890:BAD-TOKEN' });
      assert.equal(r.headers.get('location'), '/admin/zalo');
      assert.equal(called('settings.setMany').length, 0, 'a token Zalo rejects is not stored');

      r = await admin.post('/admin/zalo/bot-token', { _csrf: token, _back: '/admin/zalo', botToken: '1234567890:GOOD-TOKEN' });
      const saved = called('settings.setMany')[0].args[0];
      assert.equal(saved['zalo.botToken'], '1234567890:GOOD-TOKEN');
      assert.match(saved['zalo.webhookSecret'], /^[0-9a-f]{48}$/, 'webhook secret generated');
      const hook = calls.find((c) => c.method === 'setWebhook');
      assert.ok(hook.tokenOk);
      assert.match(hook.body.url, /\/api\/zalo\/webhook$/);
      assert.equal(hook.body.secret_token, saved['zalo.webhookSecret']);

      const after = await (await admin.get('/admin/zalo')).text();
      assert.match(after, /Đã có token …OKEN/);
      assert.doesNotMatch(after, /GOOD-TOKEN/, 'the token is never shown back');
    } finally {
      axios.post = original;
      require('../src/services/zalo/zaloConfig').invalidate();
    }
  });

  await t.test('customers: "Gán Zalo" picker on the list links / unlinks a Zalo account', async () => {
    const customerModel = require('../src/models/customerModel');
    const html = await (await admin.get('/admin/customers')).text();
    assert.match(html, /data-action="\/admin\/customers\/5\/zalo"/, 'every row has a Gán Zalo button');
    assert.match(html, /<datalist id="zalo-senders">[\s\S]*value="z-5678"[\s\S]*Anh Tuấn · 2 đơn/, 'recent unlinked bot senders are offered');
    assert.match(html, /Để trống rồi Lưu để gỡ liên kết/);
    const token = await fx.csrfOf(admin, '/admin/customers');
    customerModel.update.mock.resetCalls();
    let r = await admin.post('/admin/customers/5/zalo', { _csrf: token, _back: '/admin/customers', zalo_user_id: ' z-5678 ' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/admin/customers');
    assert.deepEqual(customerModel.update.mock.calls.at(-1).arguments.slice(0, 2), [5, { zalo_user_id: 'z-5678' }]);
    assert.match(decodeURIComponent(r.headers.getSetCookie().join(';')), /Đã gán Zalo ID z-5678 cho Chị Lan/);
    r = await admin.post('/admin/customers/5/zalo', { _csrf: token, _back: '/admin/customers', zalo_user_id: '' });
    assert.deepEqual(customerModel.update.mock.calls.at(-1).arguments.slice(0, 2), [5, { zalo_user_id: null }]);
    r = await admin.post('/admin/customers/5/zalo', { _csrf: token, _back: '/admin/customers', zalo_user_id: 'bad id!' });
    assert.match(decodeURIComponent(r.headers.getSetCookie().join(';')), /chỉ gồm chữ, số/);
    r = await admin.post('/admin/customers/999/zalo', { _csrf: token, _back: '/admin/customers', zalo_user_id: 'z-1' });
    assert.equal(r.status, 303);   // act(): the error becomes a flash message on the list
    assert.match(decodeURIComponent(r.headers.getSetCookie().join(';')), /Không tìm thấy khách hàng/);
  });

  await t.test('customers & debt: list, detail, collect (partial), adjust, reconciliation, printable statement', async () => {
    for (const [p, re] of [
      ['/admin/customers', /Chị Lan[\s\S]*120\.000đ/],
      ['/admin/customers/5', /Số dư công nợ[\s\S]*120\.000đ[\s\S]*Thu nợ/],
      ['/admin/customers/new', /Thêm khách hàng/],
      ['/admin/customers/5/edit', /value="0909000111"/],
      ['/admin/customers/reconciliation?from=2026-10-01&to=2026-10-13', /Nợ cuối kỳ[\s\S]*120\.000đ[\s\S]*Biên bản/],
    ]) {
      const r = await admin.get(p);
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), re, p);
    }
    const st = await (await admin.get('/admin/customers/5/statement?from=2026-10-01&to=2026-10-13')).text();
    assert.match(st, /BIÊN BẢN ĐỐI CHIẾU CÔNG NỢ/);
    assert.match(st, /Từ ngày 01\/10\/2026 đến ngày 13\/10\/2026/);
    assert.match(st, /Bên B còn nợ Bên A số tiền: <b>120\.000đ/);
    assert.equal((await admin.get('/admin/customers/999')).status, 404);

    reset();
    let r = await admin.post('/admin/customers/5/collect', { _csrf: token, _back: '/admin/customers/5', amount: '50000', method: 'transfer', note: 'CK' });
    assert.equal(r.headers.get('location'), '/admin/customers/5');
    assert.deepEqual(called('customer.collect')[0].args, [5, { amount: 50000, method: 'transfer', note: 'CK', userId: 1 }]);
    await admin.post('/admin/customers/5/collect', { _csrf: token, _back: '/admin/customers/5', amount: '50000', method: 'bitcoin' });
    assert.equal(called('customer.collect').length, 1, 'unknown method refused before the service');

    reset();
    await admin.post('/admin/customers/5/adjust', { _csrf: token, _back: '/admin/customers/5', direction: 'decrease', amount: '20000', note: 'xóa nợ lẻ' });
    assert.equal(called('customer.adjust')[0].args[1].amount, -20000);
    await admin.post('/admin/customers/5/adjust', { _csrf: token, _back: '/admin/customers/5', direction: 'increase', amount: '20000', note: '' });
    assert.equal(called('customer.adjust').length, 1, 'a reason is required');

    const { c } = await fx.login('thungan', PASSWORD);
    assert.equal((await c.get('/admin/customers')).headers.get('location'), '/admin/pos', 'cashiers cannot open customer debts');
  });

  await t.test('dashboard charts: best sellers, low stock, overstock, debtors named from customers', async () => {
    const html = await (await admin.get('/admin/dashboard')).text();
    for (const title of ['Món bán chạy', 'Hàng sắp hết', 'Nguyên liệu tồn kho nhiều', 'Khách hàng công nợ nhiều nhất']) assert.match(html, new RegExp(title));
    assert.match(html, /Chị Lan/);
    assert.match(html, /120\.000đ/);
    assert.match(html, /Sắp hết|Nguy cấp/, 'low-stock rows carry a text badge, not colour alone');
    assert.match(html, /1\.400\.000đ/, 'stock value of the biggest item');
  });

  await t.test('printer settings: saved from the settings page and applied to the receipt', async () => {
    const page = await (await admin.get('/admin/settings')).text();
    assert.match(page, /Máy in hóa đơn/);
    assert.match(page, /name="paperMm" value="80" checked/);

    reset();
    await admin.post('/admin/settings/printer', { _csrf: token, _back: '/admin/settings', paperMm: '57', copies: '1', vatRate: '8' });
    assert.equal(called('settings.setMany').length, 0, 'unknown paper size refused');
    await admin.post('/admin/settings/printer', { _csrf: token, _back: '/admin/settings', paperMm: '80', copies: '9', vatRate: '8' });
    assert.equal(called('settings.setMany').length, 0, 'copies 1..3');

    const save = await admin.post('/admin/settings/printer', {
      _csrf: token, _back: '/admin/settings', paperMm: '58', copies: '2', vatRate: '10', printerName: 'XP-58 quầy', shopAddress: '12 Lê Lợi, Đà Lạt',
      shopPhone: '0909 000 111', footer: 'Hẹn gặp lại <3', autoPrint: '0', showVat: ['0', '1'],
    });
    assert.equal(save.headers.get('location'), '/admin/settings');
    const saved = called('settings.setMany')[0].args[0];
    assert.equal(saved['printer.paperMm'], 58);
    assert.equal(saved['printer.autoPrint'], '0');
    assert.equal(saved['printer.showVat'], '1');
    assert.equal(called('settings.setMany')[0].args[1], 1, 'who changed it');

    const html = await (await admin.get('/admin/pos/receipt/42')).text();
    assert.match(html, /@page \{ size: 58mm auto; margin: 0; \}/);
    assert.equal((html.match(/<main class="paper">/g) || []).length, 2, 'two copies');
    assert.match(html, /12 Lê Lợi, Đà Lạt/);
    assert.match(html, /Hẹn gặp lại &lt;3/, 'escaped');
    assert.match(html, /Đã gồm VAT 10%/);
    assert.match(html, /Máy in: XP-58 quầy/);
    const sample = await (await admin.get('/admin/pos/receipt/sample')).text();
    assert.match(sample, /HÓA ĐƠN IN THỬ/);
    const pos = await (await admin.get('/admin/pos')).text();
    assert.match(pos, /"autoPrint":false/);

    // back to defaults for the other tests
    await admin.post('/admin/settings/printer', { _csrf: token, _back: '/admin/settings', paperMm: '80', copies: '1', vatRate: '8', autoPrint: '1', showVat: '1', footer: '' });
  });

  await t.test('POS: open order of a busy table is returned for editing', async () => {
    const { c } = await fx.login('thungan', PASSWORD);
    let j = await (await c.get('/admin/pos/orders/42')).json();
    assert.equal(j.ok, false, 'a completed order is not reopened');
    const orderService = require('../src/services/orderService');
    const original = orderService.getWithItems;
    orderService.getWithItems = async () => ({ ...fx.ORDER, status: 'open' });
    try {
      j = await (await c.get('/admin/pos/orders/42')).json();
      assert.equal(j.ok, true);
      assert.deepEqual(j.order.items, [{ productId: 1, qty: 2 }, { productId: 2, qty: 1 }]);
    } finally {
      orderService.getWithItems = original;
    }
  });

  await t.test('logout clears the session and the cookie no longer works', async () => {
    const { c } = await fx.login();
    const csrf = await fx.csrfOf(c, '/admin/dashboard');
    const bad = await c.post('/admin/logout', {});
    assert.equal(c.jar.has('cc_admin'), true, 'logout without a token does nothing');
    assert.equal(bad.status, 303);
    await c.post('/admin/logout', { _csrf: csrf });
    assert.equal(c.jar.has('cc_admin'), false);
    assert.equal((await c.get('/admin/dashboard')).status, 303);
  });

  await t.test('an API bearer token cannot be used as an admin cookie', async () => {
    const jwt = require('jsonwebtoken');
    const env = require('../src/config/env');
    const apiToken = jwt.sign({ sub: 1, role: 'admin' }, env.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await fx.client().req('/admin/dashboard', { headers: { cookie: `cc_admin=${apiToken}` } });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^\/admin\/login/);
  });
});
