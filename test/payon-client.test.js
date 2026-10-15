process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
process.env.PAYON_APP_ID = ''; process.env.PAYON_MERCHANT_ID = ''; process.env.PAYON_AUTH_USER = ''; process.env.PAYON_AUTH_PASS = '';
process.env.PAYON_SECRET_KEY = ''; process.env.PAYON_ENV = '';
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const crypto = require('../src/services/payon/payonCrypto');
const payonClient = require('../src/services/payon/payonClient');
const payonConfig = require('../src/services/payon/payonConfig');
const settingsModel = require('../src/models/settingsModel');

const CFG = { complete: true, appId: '160088PayON', merchantId: '12345', authUser: 'mc-user', authPass: 'mc-pass', secretKey: 'S3cretKey', baseUrl: 'https://dev.example/v1/merchant', bankCode: 'VCB', expireMinutes: 15 };

/** axios.post faked: records the call, answers with `answer(call)`. */
function fakeAxios(t, answer) {
  const calls = [];
  t.mock.method(axios, 'post', async (url, body, opts) => { calls.push({ url, body, opts }); return answer({ url, body, opts }); });
  return calls;
}
const ok = (data, extra = {}) => ({ status: 200, data: { error_code: '00', error_message: 'Xử lý thành công', data, ...extra } });

test('a call is encrypted, checksummed and sent with Basic auth to {base}/{function}', async (t) => {
  const calls = fakeAxios(t, () => ok({ payment_id: 1 }));
  const out = await payonClient.call('checkPayment', { merchant_request_id: 'CF-1' }, { config: CFG });
  assert.deepEqual(out, { payment_id: 1 });
  const { url, body, opts } = calls[0];
  assert.equal(url, 'https://dev.example/v1/merchant/checkPayment');
  assert.deepEqual(opts.auth, { username: 'mc-user', password: 'mc-pass' });
  assert.equal(body.app_id, '160088PayON');
  assert.equal(body.checksum, crypto.checksum('160088PayON', body.data, 'S3cretKey'), 'md5(app_id + data + secret)');
  assert.deepEqual(JSON.parse(crypto.decrypt(body.data, 'S3cretKey')), { merchant_request_id: 'CF-1' });
  assert.equal(opts.timeout, 15000);
});

test('the answer data may be an object or an encrypted string (both forms appear in the documentation)', async (t) => {
  fakeAxios(t, () => ok(crypto.encrypt(JSON.stringify({ status: 2 }), CFG.secretKey)));
  assert.deepEqual(await payonClient.call('checkPayment', {}, { config: CFG }), { status: 2 });
  t.mock.restoreAll();
  fakeAxios(t, () => ok(JSON.stringify({ status: 3 })));
  assert.deepEqual(await payonClient.call('checkPayment', {}, { config: CFG }), { status: 3 });
  t.mock.restoreAll();
  fakeAxios(t, () => ok(null));
  assert.deepEqual(await payonClient.call('checkPayment', {}, { config: CFG }), {});
});

test('PayOn error codes become readable errors (IP not declared, bad checksum, duplicate id); other failures are 502s', async (t) => {
  for (const [code, pattern] of [['02', /chặn địa chỉ IP/], ['04', /sai mã kiểm tra/], ['1001-02', /đã tồn tại/], ['77', /lỗi 77: boom/]]) {
    t.mock.restoreAll();
    fakeAxios(t, () => ({ status: 200, data: { error_code: code, error_message: 'boom' } }));
    await assert.rejects(payonClient.call('createQRCode', {}, { config: CFG }), (e) => e.code === 'PAYON_ERROR' && e.status === 502 && pattern.test(e.message) && e.details.payonCode === code);
  }
  t.mock.restoreAll();
  fakeAxios(t, () => ({ status: 503, data: 'down' }));
  await assert.rejects(payonClient.call('x', {}, { config: CFG }), { code: 'PAYON_HTTP' });
  t.mock.restoreAll();
  fakeAxios(t, () => { const e = new Error('timeout of 15000ms exceeded'); e.code = 'ECONNABORTED'; throw e; });
  await assert.rejects(payonClient.call('x', {}, { config: CFG }), { code: 'PAYON_UNREACHABLE' });
  await assert.rejects(payonClient.call('x', {}, { config: { ...CFG, complete: false } }), { code: 'PAYON_NOT_CONFIGURED' });
});

test('error texts never include the keys', async (t) => {
  fakeAxios(t, () => ({ status: 200, data: { error_code: '04', error_message: 'checksum 1234' } }));
  await assert.rejects(payonClient.call('x', {}, { config: CFG }), (e) => !e.message.includes(CFG.secretKey) && !e.message.includes(CFG.authPass));
});

test('qrBanks reads the bank list in any of the shapes (array, keyed object) and createQr sends the documented fields', async (t) => {
  fakeAxios(t, () => ok({ Banks: { a: { code: 'VCB', trade_name: 'Vietcombank', full_name: 'Ngân hàng TMCP Ngoại thương' }, b: { code: 'ACB', full_name: 'ACB full' }, c: {} } }));
  assert.deepEqual(await payonClient.qrBanks(CFG), [{ code: 'VCB', name: 'Vietcombank' }, { code: 'ACB', name: 'ACB full' }]);
  t.mock.restoreAll();
  const calls = fakeAxios(t, () => ok({ Banks: [{ code: 'TCB', trade_name: 'Techcombank' }] }));
  assert.deepEqual(await payonClient.qrBanks(CFG), [{ code: 'TCB', name: 'Techcombank' }]);
  assert.deepEqual(JSON.parse(crypto.decrypt(calls[0].body.data, CFG.secretKey)), { service_type_code: 'PAYNOW', service_code: 'PAYNOW_QRLOCALBANK_DYNAMIC', method_code: 'LOCALBANK' });

  t.mock.restoreAll();
  const q = fakeAxios(t, () => ok({ payment_id: 9, qrcode_pay: '000201', qrcode_image: '', amount_payment: 79000 }));
  t.mock.method(payonConfig, 'get', async () => CFG);
  await payonClient.createQr({ requestId: 'CF-1-abc123', amount: 79000.4, description: 'Thanh toan CF-1', expireSeconds: 900, bankCode: 'VCB', urlNotify: 'https://x/ipn', urlRedirect: 'https://x/o', urlCancel: 'https://x/o' });
  assert.deepEqual(JSON.parse(crypto.decrypt(q[0].body.data, CFG.secretKey)), {
    merchant_id: 12345, service_type_code: 'PAYNOW', service_code: 'PAYNOW_QRLOCALBANK_DYNAMIC', method_code: 'LOCALBANK',
    merchant_request_id: 'CF-1-abc123', amount: 79000, time_expire: 900, bank_code: 'VCB', description: 'Thanh toan CF-1', currency: 'VND',
    url_redirect: 'https://x/o', url_notify: 'https://x/ipn', url_cancel: 'https://x/o',
  });
});

// ------------------------------------------------------------------------------------------------ settings

function memorySettings(t, initial = {}) {
  const store = new Map(Object.entries(initial));
  t.mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries([...store].filter(([k]) => k.startsWith(p))));
  t.mock.method(settingsModel, 'setMany', async (values) => { for (const [k, v] of Object.entries(values)) store.set(k, String(v)); });
  payonConfig.invalidate();
  return store;
}
const FORM = { env: 'sandbox', appId: 'APP1', merchantId: '777', authUser: 'user', authPass: 'pw-1234', secretKey: 'key-9999', bankCode: 'VCB', bankName: 'Vietcombank', expireMinutes: '20', enabled: '1' };

test('settings: saving, switching on, secrets masked in the view, blank keeps the stored secret', async (t) => {
  const store = memorySettings(t);
  let cfg = await payonConfig.save(FORM, 1);
  assert.equal(cfg.ready, true);
  assert.equal(cfg.baseUrl, payonConfig.URLS.sandbox);
  assert.equal(cfg.expireMinutes, 20);
  const view = await payonConfig.view();
  assert.equal(view.authPassSet, true);
  assert.equal(view.authPassHint, '…1234');
  assert.equal(view.secretKeyHint, '…9999');
  assert.ok(!JSON.stringify(view).includes('pw-1234') && !JSON.stringify(view).includes('key-9999'), 'no secret value in the view');

  cfg = await payonConfig.save({ ...FORM, authPass: '', secretKey: '', env: 'production', expireMinutes: '999' }, 1);
  assert.equal(cfg.authPass, 'pw-1234');
  assert.equal(cfg.secretKey, 'key-9999');
  assert.equal(cfg.baseUrl, payonConfig.URLS.production);
  assert.equal(cfg.expireMinutes, 60, 'clamped');
  cfg = await payonConfig.save({ ...FORM, enabled: '0' }, 1);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.ready, false);
  assert.equal(store.get('payon.enabled'), '0');
});

test('settings: validation (merchant id numeric, switch-on needs everything and a bank, long values)', async (t) => {
  memorySettings(t);
  await assert.rejects(payonConfig.save({ ...FORM, merchantId: 'abc' }, 1), /phải là số/);
  await assert.rejects(payonConfig.save({ ...FORM, appId: '' }, 1), /Nhập đủ APP_ID/);
  await assert.rejects(payonConfig.save({ ...FORM, bankCode: '' }, 1), /chọn ngân hàng QR/);
  await assert.rejects(payonConfig.save({ ...FORM, appId: 'x'.repeat(61) }, 1), /tối đa 60/);
  const cfg = await payonConfig.save({ ...FORM, appId: '', enabled: '0' }, 1);   // saving half-filled while off is fine
  assert.equal(cfg.complete, false);
});

test('settings: a database error falls back to the environment instead of breaking the notification endpoint', async (t) => {
  t.mock.method(settingsModel, 'getByPrefix', async () => { throw new Error('db down'); });
  payonConfig.invalidate();
  const cfg = await payonConfig.get();
  assert.equal(cfg.ready, false);
  assert.equal(cfg.env, 'sandbox');
  payonConfig.invalidate();
});
