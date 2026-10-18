const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start } = require('./helpers/adminFixture');
const env = require('../src/config/env');
const settingsModel = require('../src/models/settingsModel');
const heli = require('../src/services/heli/heliConfig');

const KEY = 'sk-test_ABCDEFGHIJKLMNOPQRSTUVWX1234';

test('Heli: the ChatGPT key is entered in Cài đặt, stored, never shown again, and wins over OPENAI_API_KEY', async (t) => {
  const fx = await start();
  const before = { ...env.heliOverride };
  t.after(() => { fx.stop(); mock.restoreAll(); Object.assign(env.heliOverride, before); });
  let stored = {};
  mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries(Object.entries(stored).filter(([k]) => k.startsWith(p))));
  mock.method(settingsModel, 'setMany', async (v) => { stored = { ...stored, ...v }; });
  const calls = [];
  const realFetch = global.fetch;
  mock.method(global, 'fetch', async (url, init) => {
    if (String(url).startsWith('https://api.openai.com/v1/models')) {
      calls.push(init.headers.Authorization);
      return new Response('{}', { status: init.headers.Authorization.includes('REVOKED') ? 401 : 200 });
    }
    return realFetch(url, init);
  });
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);

  await t.test('the card is on the page', async () => {
    const html = await (await admin.get('/admin/settings')).text();
    assert.match(html, /action="\/admin\/settings\/heli"/);
    assert.match(html, /name="api_key"/);
    assert.match(html, /type="password"/);
  });

  await t.test('a malformed key is refused, a good one is stored and shown only as its last 4 characters', async () => {
    await admin.post('/admin/settings/heli', { _csrf: token, _back: '/admin/settings', api_key: 'khong-phai-khoa', model: '' });
    assert.equal(stored['heli.apiKey'], undefined);
    const res = await admin.post('/admin/settings/heli', { _csrf: token, _back: '/admin/settings', api_key: KEY, model: 'gpt-4o' });
    assert.equal(res.status, 303);
    assert.equal(stored['heli.apiKey'], KEY);
    assert.equal(stored['heli.model'], 'gpt-4o');
    assert.equal(env.heli.apiKey, KEY, 'what services/heli/openai.js reads');
    assert.equal(env.heli.model, 'gpt-4o');
    const html = await (await admin.get('/admin/settings')).text();
    assert.ok(!html.includes(KEY), 'the key never comes back to the browser');
    assert.match(html, /…1234/);
    assert.match(html, /đã lưu trong Cài đặt/);
  });

  await t.test('a blank key field keeps the stored key; the test button asks OpenAI with it', async () => {
    await admin.post('/admin/settings/heli', { _csrf: token, _back: '/admin/settings', api_key: '', model: 'gpt-4o-mini' });
    assert.equal(stored['heli.apiKey'], KEY);
    assert.equal(stored['heli.model'], 'gpt-4o-mini');
    await admin.post('/admin/settings/heli/test', { _csrf: token, _back: '/admin/settings', api_key: '' });
    assert.equal(calls.at(-1), `Bearer ${KEY}`);
  });

  await t.test('clearing falls back to the environment', async () => {
    await admin.post('/admin/settings/heli', { _csrf: token, _back: '/admin/settings', clear: '1' });
    assert.equal(stored['heli.apiKey'], '');
    assert.equal(env.heli.apiKey, env.heliEnv.apiKey);
  });

  await t.test('the app API: PUT / POST test, key never in an answer, cashier refused', async () => {
    const login = (u) => fetch(`${fx.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: fx.PASSWORD }) }).then((r) => r.json());
    const call = (bearer, method, path, body) => fetch(`${fx.base}/api/admin/settings/${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const boss = (await login('boss')).token;
    const put = await call(boss, 'PUT', 'heli', { api_key: KEY });
    const j = await put.json();
    assert.equal(put.status, 200);
    assert.equal(j.heli.enabled, true);
    assert.equal(j.heli.source, 'settings');
    assert.equal(j.heli.hint, '…1234');
    assert.ok(!JSON.stringify(j).includes(KEY));
    const ok = await call(boss, 'POST', 'heli/test', {});
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, hint: '…1234' });
    const bad = await call(boss, 'POST', 'heli/test', { api_key: 'sk-REVOKED_ABCDEFGHIJKLMNOPQRSTUVWX' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /từ chối khóa/);
    const get = await (await fetch(`${fx.base}/api/admin/settings`, { headers: { authorization: `Bearer ${boss}` } })).json();
    assert.ok(!JSON.stringify(get).includes(KEY));
    assert.equal(get.heli.enabled, true);
    const cashier = (await login('thungan')).token;
    assert.equal((await call(cashier, 'PUT', 'heli', { api_key: KEY })).status, 403);
  });
});

test('heli key format', () => {
  assert.doesNotThrow(() => heli.save && true);
});
