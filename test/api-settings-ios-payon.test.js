/**
 * The app's Settings screen: iOS download link and PayOn connection through /api/admin/settings/* (same rules as the
 * Web Admin forms, which share the services). Real Express app, data layer faked (helpers/adminFixture.js), PayOn and
 * the IP lookup faked. No MySQL, no network.
 */
process.env.PUBLIC_BASE_URL = 'https://cafe.example.test';
process.env.PAYON_APP_ID = ''; process.env.PAYON_SECRET_KEY = ''; process.env.PAYON_ENV = '';
process.env.PAYON_MERCHANT_ID = ''; process.env.PAYON_AUTH_USER = ''; process.env.PAYON_AUTH_PASS = '';
process.env.IOS_APP_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { start, PASSWORD } = require('./helpers/adminFixture');
const payonClient = require('../src/services/payon/payonClient');
const payonConfig = require('../src/services/payon/payonConfig');
const iosApp = require('../src/services/iosApp');

const TF = 'https://testflight.apple.com/join/AbCd1234';
const PAYON = { env: 'sandbox', appId: '160088PayON', merchantId: '12345', authUser: 'mc-user', authPass: 'pass-SECRET-1', secretKey: 'key-SECRET-2', expireMinutes: 15 };

test('app settings API: iOS link and PayOn', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const api = async (method, path, { token, json } = {}) => {
    const res = await fetch(fx.base + path, {
      method,
      headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  const login = async (username) => (await api('POST', '/api/auth/login', { json: { username, password: PASSWORD } })).body.token;
  const admin = await login('boss');
  const cashier = await login('thungan');

  await t.test('GET: both sections are there, nothing configured yet, no secrets', async () => {
    const r = await api('GET', '/api/admin/settings', { token: admin });
    assert.equal(r.status, 200);
    assert.equal(r.body.ios_app.url, '');
    assert.equal(r.body.ios_app.link, null);
    assert.equal(r.body.ios_app.app.bundleId, 'com.tasotek.fnb');
    assert.equal(r.body.payon.config.ready, false);
    assert.equal(r.body.payon.config.authPassSet, false);
    assert.equal(r.body.payon.ipnUrl, 'https://cafe.example.test/api/payon/ipn');
    assert.deepEqual(r.body.payon.banks, []);
  });

  await t.test('PUT ios-app: only Apple https links; a good one is stored and in force; empty clears it', async () => {
    iosApp.invalidate();
    let r = await api('PUT', '/api/admin/settings/ios-app', { token: admin, json: { url: 'https://example.com/app.ipa' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION');
    r = await api('PUT', '/api/admin/settings/ios-app', { token: admin, json: { url: ` ${TF} ` } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ios_app.url, TF);
    assert.equal(r.body.ios_app.link.kind, 'testflight');
    assert.equal((await api('GET', '/api/admin/settings', { token: admin })).body.ios_app.link.label, 'TestFlight');
    r = await api('PUT', '/api/admin/settings/ios-app', { token: admin, json: { url: '' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ios_app.url, '');
    assert.equal(r.body.ios_app.link, null);
    assert.equal((await api('PUT', '/api/admin/settings/ios-app', { token: admin, json: {} })).status, 200, 'a missing url clears it like an empty one');
  });

  await t.test('PUT payon: secrets are stored but never returned; blank keeps them; switching on needs a bank from the test list', async (tt) => {
    tt.mock.method(payonClient, 'qrBanks', async () => [{ code: 'VCB', name: 'Vietcombank' }, { code: 'ACB', name: 'ACB' }]);
    payonConfig.invalidate();

    let r = await api('PUT', '/api/admin/settings/payon', { token: admin, json: PAYON });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /chưa bật/);
    assert.equal(r.body.payon.config.complete, true);
    assert.equal(r.body.payon.config.ready, false);
    assert.equal(r.body.payon.config.authPassSet, true);
    assert.equal(r.body.payon.config.authPassHint, '…ET-1');
    assert.doesNotMatch(r.text, /pass-SECRET-1|key-SECRET-2/, 'secrets are never in a response');

    r = await api('PUT', '/api/admin/settings/payon', { token: admin, json: { ...PAYON, authPass: '', secretKey: '', bankCode: 'VCB', enabled: true } });
    assert.equal(r.status, 400, 'the bank list comes from a connection test');
    assert.match(r.body.error.message, /Ngân hàng QR không nằm trong danh sách/);

    r = await api('POST', '/api/admin/settings/payon/test', { token: admin });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /thành công: 2 ngân hàng/);
    assert.deepEqual(r.body.payon.banks.map((b) => b.code), ['VCB', 'ACB']);
    assert.doesNotMatch(r.text, /pass-SECRET-1|key-SECRET-2/);

    r = await api('PUT', '/api/admin/settings/payon', { token: admin, json: { ...PAYON, authPass: '', secretKey: '', bankCode: 'VCB', enabled: true } });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /Đã lưu và bật/);
    assert.equal(r.body.payon.config.ready, true);
    assert.equal(r.body.payon.config.bankName, 'Vietcombank', 'the bank name comes from the saved list');
    payonConfig.invalidate();
    const cfg = await payonConfig.get();
    assert.equal(cfg.authPass, 'pass-SECRET-1', 'blank keeps the stored password');
    assert.equal(cfg.secretKey, 'key-SECRET-2');

    r = await api('PUT', '/api/admin/settings/payon', { token: admin, json: { ...PAYON, merchantId: 'abc', authPass: '', secretKey: '' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /MC_ID/);
  });

  await t.test('POST payon/ip: the address PayOn sees; an unreachable lookup is a 502', async (tt) => {
    const m = tt.mock.method(axios, 'get', async () => ({ data: { ip: '203.0.113.7' } }));
    let r = await api('POST', '/api/admin/settings/payon/ip', { token: admin });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /203\.0\.113\.7/);
    m.mock.restore();
    tt.mock.method(axios, 'get', async () => { throw new Error('offline'); });
    r = await api('POST', '/api/admin/settings/payon/ip', { token: admin });
    assert.equal(r.status, 502);
  });

  await t.test('cashiers and anonymous callers are refused', async () => {
    for (const [method, path] of [['PUT', '/api/admin/settings/ios-app'], ['PUT', '/api/admin/settings/payon'], ['POST', '/api/admin/settings/payon/test'], ['POST', '/api/admin/settings/payon/ip']]) {
      assert.equal((await api(method, path, { token: cashier, json: {} })).status, 403, `${method} ${path} as cashier`);
      assert.equal((await api(method, path, { json: {} })).status, 401, `${method} ${path} anonymous`);
    }
  });
});
