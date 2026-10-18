const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start } = require('./helpers/adminFixture');
const env = require('../src/config/env');
const settingsModel = require('../src/models/settingsModel');
const publicUrl = require('../src/services/publicUrl');

test('normalize: https only (http for the private network), no path, scheme added', () => {
  assert.equal(publicUrl.normalize('quan.ngrok-free.app'), 'https://quan.ngrok-free.app');
  assert.equal(publicUrl.normalize(' https://Quan.example.com/ '), 'https://quan.example.com');
  assert.equal(publicUrl.normalize('https://quan.example.com:8443'), 'https://quan.example.com:8443');
  assert.equal(publicUrl.normalize('http://192.168.1.10:3000'), 'http://192.168.1.10:3000');
  assert.equal(publicUrl.normalize(''), '');
  for (const bad of ['http://quan.example.com', 'https://quan.example.com/admin', 'https://u:p@quan.example.com', 'https://quan example.com', 'ftp://x.com', 'https://a.com?x=1']) {
    assert.throws(() => publicUrl.normalize(bad), (e) => e.status === 400, bad);
  }
});

test('Cài đặt: the public address is editable and wins over PUBLIC_BASE_URL', async (t) => {
  const fx = await start();
  const before = env.publicUrlOverride.value;
  t.after(() => { fx.stop(); mock.restoreAll(); env.publicUrlOverride.value = before; });
  let stored = {};
  mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries(Object.entries(stored).filter(([k]) => k.startsWith(p))));
  mock.method(settingsModel, 'setMany', async (v) => { stored = { ...stored, ...v }; });
  const webhookGuard = require('../src/services/zalo/webhookGuard');
  let guarded = 0;
  mock.method(webhookGuard, 'ensure', async () => { guarded += 1; });
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);

  await t.test('the form is on the page', async () => {
    const html = await (await admin.get('/admin/settings')).text();
    assert.match(html, /action="\/admin\/settings\/public-url"/);
    assert.match(html, /name="public_url"/);
  });

  await t.test('saving sets it everywhere env.publicBaseUrl is read, and re-registers the Zalo webhook', async () => {
    const res = await admin.post('/admin/settings/public-url', { _csrf: token, _back: '/admin/settings', public_url: 'quan-moi.ngrok-free.app' });
    assert.equal(res.status, 303);
    assert.equal(stored['app.publicBaseUrl'], 'https://quan-moi.ngrok-free.app');
    assert.equal(env.publicBaseUrl, 'https://quan-moi.ngrok-free.app');
    assert.equal(guarded, 1);
    const html = await (await admin.get('/admin/settings')).text();
    assert.match(html, /value="https:\/\/quan-moi\.ngrok-free\.app"/);
    assert.match(html, /đã lưu trong Cài đặt/);
  });

  await t.test('a bad address is refused and nothing changes; an empty one goes back to the environment', async () => {
    await admin.post('/admin/settings/public-url', { _csrf: token, _back: '/admin/settings', public_url: 'http://quan.example.com' });
    assert.equal(stored['app.publicBaseUrl'], 'https://quan-moi.ngrok-free.app');
    await admin.post('/admin/settings/public-url', { _csrf: token, _back: '/admin/settings', public_url: '' });
    assert.equal(stored['app.publicBaseUrl'], '');
    assert.equal(env.publicBaseUrl, env.publicUrlEnv);
  });

  await t.test('the app API: PUT /api/admin/settings/public-url', async () => {
    const login = (user) => fetch(`${fx.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: fx.PASSWORD }) }).then((r) => r.json());
    const put = (bearer, body) => fetch(`${fx.base}/api/admin/settings/public-url`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const boss = (await login('boss')).token;
    const ok = await put(boss, { url: 'https://api-set.example.com' });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.config.publicBaseUrl, 'https://api-set.example.com');
    assert.equal(j.config.publicBaseUrlSource, 'settings');
    assert.equal((await put(boss, { url: 'http://nope.example.com' })).status, 400);
    const cashier = (await login('thungan')).token;
    assert.equal((await put(cashier, { url: 'https://x.example.com' })).status, 403);
  });
});
