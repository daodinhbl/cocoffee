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

  await t.test('wrong password / unknown user / cashier are all refused without a session', async () => {
    for (const [u, p, status, msg] of [['boss', 'nope-nope-nope', 401, /Sai tên đăng nhập/], ['ghost', PASSWORD, 401, /Sai tên đăng nhập/], ['thungan', PASSWORD, 403, /không có quyền quản trị/]]) {
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
      '/admin/orders': [/CF261013-00042/, /Chờ thu tiền/, /Trang <span[^>]*>1<\/span> \/ <span[^>]*>3<\/span>/],
      '/admin/orders/42': [/Cà phê sữa đá/, /ít đá/, /Gửi lại bill qua Zalo/, /Thu 79\.000đ/, /Zalo 500/],
      '/admin/menu': [/cf sữa/, /Thuốc lá 555/, /Ngừng bán/],
      '/admin/inventory': [/Sữa tươi/, /Sắp hết/, /Giá trị tồn kho/],
      '/admin/inventory/2': [/Lịch sử xuất nhập/, /Nhập kho/, /Bán hàng/],
      '/admin/receiving': [/Phiếu nhập/, /NCC A/],
      '/admin/bom-recipes': [/Cà phê sữa đá/, /Chưa có định mức/, /Hàng bán lẻ/],
      '/admin/reports': [/Doanh thu theo ngày/, /Món bán chạy/, /Chưa thu tiền/],
      '/admin/zalo': [/Webhook/, /user_send_text/, /CF-D/],
      '/admin/settings': [/Đổi mật khẩu/, /Tài khoản nhân viên/, /Cấu hình hệ thống/],
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
