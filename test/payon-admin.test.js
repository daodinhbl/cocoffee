/**
 * PayOn in the Web Admin and the public notification endpoint, against the real Express app + EJS views with the data
 * layer faked (helpers/adminFixture.js) and PayOn itself faked (helpers/payonWorld.js). No MySQL, no network.
 */
process.env.PUBLIC_BASE_URL = 'https://cafe.example.test';
process.env.PAYON_APP_ID = ''; process.env.PAYON_SECRET_KEY = ''; process.env.PAYON_ENV = '';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');
const { world, ipnItem, signedIpn, paidAnswer, CFG } = require('./helpers/payonWorld');
const payonClient = require('../src/services/payon/payonClient');
const payonConfig = require('../src/services/payon/payonConfig');
const payonService = require('../src/services/payon/payonService');

test('PayOn: notification endpoint and admin screens', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const { c: admin } = await fx.login('boss');
  const token = await fx.csrfOf(admin, '/admin/settings');
  const postIpn = (body, headers = { 'content-type': 'application/json' }) => fetch(`${fx.base}/api/payon/ipn`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

  await t.test('POST /api/payon/ipn needs no session: a signed notification pays the order; a bad one is refused', async (tt) => {
    const w = world(tt);
    const view = await payonService.createOrderQr(42, { userId: 1 });
    w.check = paidAnswer();
    const rid = w.rows.get(view.id).merchant_request_id;

    const bad = signedIpn([ipnItem(rid)], 'other-secret');
    let res = await postIpn(bad.rawBody);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error_code, '04');
    assert.equal(w.paid.length, 0);

    const good = signedIpn([ipnItem(rid)]);
    res = await postIpn(good.rawBody);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { error_code: '00', error_message: 'Success' });
    assert.equal(w.paid.length, 1);
    res = await postIpn(good.rawBody);                            // PayOn retries: answered, not applied again
    assert.equal(res.status, 200);
    assert.equal(w.paid.length, 1);
  });

  await t.test('the checksum is computed over the body exactly as received (raw member), not only over a re-encoding', async (tt) => {
    const w = world(tt);
    const view = await payonService.createOrderQr(42, { userId: 1 });
    w.check = paidAnswer();
    const items = [ipnItem(w.rows.get(view.id).merchant_request_id, { transaction_detail: { order_amount: 79000, note: 'a/b ☕' } })];
    const raw = `{"data":${JSON.stringify(items)},"checksum":"x"}`;                  // unescaped, as a Java/Node sender writes it
    const crypto = require('../src/services/payon/payonCrypto');
    const sum = crypto.checksum('160088PayON', JSON.stringify(items), 'S3cretKey');
    const res = await postIpn(raw.replace('"x"', `"${sum}"`));
    assert.equal(res.status, 200);
    assert.equal(w.paid.length, 1);
  });

  await t.test('malformed notifications: 400, nothing applied, no crash', async (tt) => {
    const w = world(tt);
    assert.equal((await postIpn('not json')).status, 400);
    assert.equal((await postIpn({ data: [] })).status, 400, 'no checksum');
    assert.equal((await postIpn('data=1&checksum=2', { 'content-type': 'application/x-www-form-urlencoded' })).status, 400);
    assert.equal((await postIpn('[]')).status, 400);
    assert.equal(w.paid.length, 0);
    assert.equal((await fetch(`${fx.base}/api/payon/ipn`)).status, 200, 'GET: reachability check');
  });

  await t.test('Settings: PayOn section shows the URLs, never a secret; blank secrets keep the stored ones', async (tt) => {
    tt.mock.method(payonClient, 'qrBanks', async () => [{ code: 'VCB', name: 'Vietcombank' }, { code: 'ACB', name: 'ACB' }]);
    const form = { _csrf: token, _back: '/admin/settings', env: 'sandbox', appId: '160088PayON', merchantId: '12345', authUser: 'mc-user', authPass: 'pass-SECRET-1', secretKey: 'key-SECRET-2', bankCode: '', expireMinutes: '15', enabled: '0' };
    let res = await admin.post('/admin/settings/payon', form);
    assert.equal(res.status, 303);
    payonConfig.invalidate();
    let html = await (await admin.get('/admin/settings')).text();
    assert.match(html, /Thanh toán QR \(PayOn \/ NextPay\)/);
    assert.match(html, /https:\/\/cafe\.example\.test\/api\/payon\/ipn/);
    assert.doesNotMatch(html, /pass-SECRET-1|key-SECRET-2/, 'secrets are never rendered');
    assert.match(html, /đã lưu …ET-1/);
    assert.match(html, /Chưa bật/);

    // switching on needs a bank from the list PayOn gave
    res = await admin.post('/admin/settings/payon', { ...form, authPass: '', secretKey: '', bankCode: 'VCB', enabled: '1' });
    html = await (await admin.get('/admin/settings')).text();
    assert.match(decodeURIComponent(res.headers.get('set-cookie') || ''), /Ngân hàng QR không nằm trong danh sách/);

    await admin.post('/admin/settings/payon/test', { _csrf: token, _back: '/admin/settings' });
    payonConfig.invalidate();
    html = await (await admin.get('/admin/settings')).text();
    assert.match(html, /<option value="VCB"[^>]*>Vietcombank<\/option>/);

    res = await admin.post('/admin/settings/payon', { ...form, authPass: '', secretKey: '', bankCode: 'VCB', enabled: '1' });
    assert.equal(res.status, 303);
    payonConfig.invalidate();
    const cfg = await payonConfig.get();
    assert.equal(cfg.ready, true);
    assert.equal(cfg.authPass, 'pass-SECRET-1', 'blank keeps the stored password');
    assert.equal(cfg.secretKey, 'key-SECRET-2');
    assert.equal(cfg.bankName, 'Vietcombank', 'bank name comes from the saved list, not from the form');
    html = await (await admin.get('/admin/settings')).text();
    assert.match(html, /Đang bật/);

    // a forged bank name is ignored
    await admin.post('/admin/settings/payon', { ...form, authPass: '', secretKey: '', bankCode: 'VCB', bankName: '<script>x</script>', enabled: '1' });
    payonConfig.invalidate();
    assert.equal((await payonConfig.get()).bankName, 'Vietcombank');
  });

  await t.test('Settings: enabling without the full set of keys is refused; the test button needs saved keys', async (tt) => {
    payonConfig.invalidate();
    const settingsModel = require('../src/models/settingsModel');
    await settingsModel.setMany({ 'payon.appId': '', 'payon.authPass': '', 'payon.secretKey': '', 'payon.enabled': '0' }, 1);
    payonConfig.invalidate();
    const res = await admin.post('/admin/settings/payon', { _csrf: token, _back: '/admin/settings', env: 'sandbox', appId: '', merchantId: '12345', authUser: 'u', bankCode: '', enabled: '1' });
    assert.match(decodeURIComponent(res.headers.get('set-cookie') || ''), /Nhập đủ APP_ID/);
    const test = await admin.post('/admin/settings/payon/test', { _csrf: token, _back: '/admin/settings' });
    assert.match(decodeURIComponent(test.headers.get('set-cookie') || ''), /Lưu đủ APP_ID/);
    const bad = await admin.post('/admin/settings/payon', { _csrf: token, _back: '/admin/settings', env: 'sandbox', appId: 'a', merchantId: 'abc', authUser: 'u', enabled: '0' });
    assert.match(decodeURIComponent(bad.headers.get('set-cookie') || ''), /MC_ID\)? phải là số/);
    tt.mock.restoreAll();
  });

  await t.test('Order page: off -> no QR block; on -> "Tạo mã QR PayOn"; create -> QR drawn locally; polling + check endpoints', async (tt) => {
    const w = world(tt);
    payonConfig.get.mock.mockImplementation(async () => ({ ...CFG, ready: false, enabled: false }));
    let html = await (await admin.get('/admin/orders/42')).text();
    assert.doesNotMatch(html, /Tạo mã QR PayOn/);

    payonConfig.get.mock.mockImplementation(async () => CFG);
    html = await (await admin.get('/admin/orders/42')).text();
    assert.match(html, /Thanh toán QR \(PayOn\)/);
    assert.match(html, /Tạo mã QR PayOn/);
    assert.doesNotMatch(html, /data-payon-poll/);

    const tok = await fx.csrfOf(admin, '/admin/orders/42');
    const res = await admin.post('/admin/orders/42/payon-qr', { _csrf: tok, _back: '/admin/orders/42' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/orders/42');
    assert.equal(w.rows.size, 1);
    const id = [...w.rows.keys()][0];
    html = await (await admin.get('/admin/orders/42')).text();
    assert.match(html, new RegExp(`data-payon-poll="/admin/payon/${id}/status"`));
    assert.match(html, /<svg[\s\S]*<\/svg>/, 'QR drawn on the server: no third-party image service');
    assert.match(html, /Kiểm tra thanh toán/);
    assert.match(html, /79\.000đ/);

    w.check = null;                                              // PayOn answered with nothing usable: still pending, no crash
    let st = await admin.get(`/admin/payon/${id}/status`);
    assert.deepEqual(await st.json(), { status: 'pending', open: true, checkError: false });
    w.check = paidAnswer({ status: 1 });
    st = await admin.get(`/admin/payon/${id}/status`);
    assert.deepEqual(await st.json(), { status: 'pending', open: true, checkError: false });
    w.check = paidAnswer();
    st = await admin.get(`/admin/payon/${id}/status`);
    assert.deepEqual(await st.json(), { status: 'paid', open: false, checkError: false });
    assert.equal(w.paid.length, 1);

    const check = await admin.post(`/admin/payon/${id}/refresh`, { _csrf: tok, _back: '/admin/orders/42' });
    assert.equal(check.status, 303);
    assert.equal(w.paid.length, 1, 'checking again never pays twice');
  });

  await t.test('a base64 picture from PayOn is shown only when it is clean base64; a hostile value is dropped', async () => {
    const { imageSrc } = require('../src/controllers/admin/payon');
    assert.equal(imageSrc('iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(imageSrc('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(imageSrc('x" onerror="alert(1)'), '');
    assert.equal(imageSrc('<svg onload=1>'), '');
    assert.equal(imageSrc(''), '');
  });

  await t.test('cashiers and signed-out visitors reach none of the admin PayOn endpoints', async (tt) => {
    world(tt);
    const cashier = (await fx.login('thungan')).c;
    for (const c of [fx.client(), cashier]) {
      const r = await c.get('/admin/payon/1/status');
      assert.equal(r.status, 303);
      assert.match(r.headers.get('location'), /^\/admin\/(login|pos)/);
      const p = await c.post('/admin/orders/42/payon-qr', { _csrf: 'x' });
      assert.ok([303, 403].includes(p.status));
    }
  });
});
