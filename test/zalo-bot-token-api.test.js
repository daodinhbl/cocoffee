/**
 * PUT /api/admin/zalo/bot-token: the app's way to enter the Zalo Bot Platform token (the Web Admin form's logic,
 * shared in admin/zalo.js storeBotToken). The token is write-only: stored on the server and never echoed in a
 * response, an error message, the overview or a log line.
 * Real Express app and middleware, data layer faked (helpers/adminFixture.js), Zalo faked at axios. No MySQL.
 * Every token below is an obviously fake test value.
 */
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { start, PASSWORD } = require('./helpers/adminFixture');

const GOOD = '123456:TEST-ONLY';
const SECOND = '654321:TEST-SECOND';
const REJECTED = '123456:TEST-REJECTED';
const HOOKFAIL = '123456:TEST-HOOKFAIL';

test('PUT /api/admin/zalo/bot-token', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  // guard: nothing in this file may reach a real database (a developer .env can point at one)
  const { pool } = require('../src/config/db');
  const realDb = mock.method(pool, 'query', async () => { throw new Error('test reached the real database'); });
  t.after(() => assert.equal(realDb.mock.callCount(), 0, 'no query reached the real pool'));

  const env = require('../src/config/env');
  const zaloConfig = require('../src/services/zalo/zaloConfig');
  const called = (name) => fx.calls.filter((c) => c.name === name);
  const reset = () => { fx.calls.length = 0; zalo.length = 0; };

  // Zalo: getMe / setWebhook answer by the token in the URL. A rejecting Zalo echoes the token in its description
  // on purpose: even then the app must not hand it back.
  const zalo = [];
  mock.method(axios, 'post', async (url, body) => {
    const method = url.split('/').pop();
    zalo.push({ url, method, body });
    const token = url.split('/')[3].replace(/^bot/, '');   // https://host/bot<TOKEN>/<method>
    if (token === REJECTED) return { status: 401, data: { ok: false, description: `invalid token ${token}`, error_code: 401 } };
    if (method === 'getMe') return { status: 200, data: { ok: true, result: { id: 'b1', account_name: 'CoCoffee Bot' } } };
    if (token === HOOKFAIL) return { status: 400, data: { ok: false, description: `webhook refused for ${token}`, error_code: 400 } };
    return { status: 200, data: { ok: true, result: { url: body.url, verification: { ok: true, outcome: 'webhook.ok' } } } };
  });

  // every log line of the run (logger.* goes to the console)
  const logged = [];
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, (...args) => { logged.push(args.join(' ')); });
  const noTokenLogged = () => assert.ok(![GOOD, SECOND, REJECTED, HOOKFAIL].some((tok) => logged.some((l) => l.includes(tok))), 'no log line holds a token');

  async function api(method, path, { token, json } = {}) {
    const res = await fetch(fx.base + path, {
      method,
      headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { body = text; }
    return { status: res.status, body, text };
  }
  const login = async (username) => (await api('POST', '/api/auth/login', { json: { username, password: PASSWORD } })).body.token;
  const admin = await login('boss');
  const cashier = await login('thungan');
  const put = (token, json) => api('PUT', '/api/admin/zalo/bot-token', { token, json });
  const overview = () => api('GET', '/api/admin/zalo', { token: admin });

  await t.test('the overview starts without a token', async () => {
    const r = await overview();
    assert.equal(r.status, 200);
    assert.equal(r.body.connection.tokenSet, false);
    assert.equal(r.body.connection.platform, false);
    assert.equal(r.body.connection.explicitMode, false, 'the app may show the token form');
  });

  await t.test('no bearer token: 401; a cashier: 403 and nothing reaches Zalo or the settings', async () => {
    reset();
    const anon = await api('PUT', '/api/admin/zalo/bot-token', { json: { token: GOOD } });
    assert.equal(anon.status, 401);
    const r = await put(cashier, { token: GOOD });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'FORBIDDEN');
    assert.ok(!r.text.includes(GOOD));
    assert.equal(zalo.length, 0, 'Zalo was not called');
    assert.equal(called('settings.setMany').length, 0, 'nothing was stored');
  });

  await t.test('empty, short, garbage and non-string tokens are rejected before Zalo is called', async () => {
    reset();
    const bad = [
      undefined, '', '   ', 'abc', '123456789', 'has spaces in it 12345', '123456:TEST<script>alert(1)</script>',
      'ünïcode-tóken-123456', 'x'.repeat(201), 12345678901234, { token: GOOD }, [GOOD], null, true,
    ];
    for (const token of bad) {
      const r = await put(admin, token === undefined ? {} : { token });
      const label = JSON.stringify(token)?.slice(0, 40);
      assert.equal(r.status, 400, `token ${label}`);
      assert.equal(r.body.error.code, 'VALIDATION', `token ${label}`);
      assert.match(r.body.error.message, /Bot Token không hợp lệ/);
      if (typeof token === 'string' && token.trim()) assert.ok(!r.text.includes(token), `the rejected value is not echoed (${label})`);
    }
    // the old Web Admin field name is not part of this contract
    assert.equal((await put(admin, { botToken: GOOD })).status, 400);
    assert.equal((await api('PUT', '/api/admin/zalo/bot-token', { token: admin })).status, 400, 'no body at all');
    assert.equal(zalo.length, 0, 'Zalo was not called');
    assert.equal(called('settings.setMany').length, 0, 'nothing was stored');
    assert.equal((await overview()).body.connection.tokenSet, false);
  });

  await t.test('a token set in hPanel (ZALO_BOT_TOKEN) cannot be replaced from the app: 409', async () => {
    reset();
    const before = env.zalo.botToken;
    env.zalo.botToken = 'HPANEL-TEST-TOKEN';
    try {
      const r = await put(admin, { token: GOOD });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'ENV_TOKEN');
      assert.ok(!r.text.includes(GOOD) && !r.text.includes('HPANEL-TEST-TOKEN'));
    } finally {
      env.zalo.botToken = before;
      zaloConfig.invalidate();
    }
    assert.equal(zalo.length, 0);
    assert.equal(called('settings.setMany').length, 0);
  });

  await t.test('a token Zalo refuses is not stored, and the error does not repeat the token (even if Zalo does)', async () => {
    reset();
    const r = await put(admin, { token: REJECTED });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'ZALO_BOT_API');
    assert.match(r.body.error.message, /^Zalo không chấp nhận token này: invalid token /);
    assert.ok(!r.text.includes(REJECTED), 'the token is not in the response');
    assert.deepEqual(zalo.map((z) => z.method), ['getMe'], 'checked with getMe only');
    assert.equal(called('settings.setMany').length, 0, 'nothing was stored');
    assert.equal((await overview()).body.connection.tokenSet, false);
  });

  let secret;
  await t.test('token saved but Zalo refuses the webhook: 502 that says the token IS saved, without the token', async () => {
    reset();
    const r = await put(admin, { token: HOOKFAIL });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'ZALO_BOT_API');
    assert.match(r.body.error.message, /^Đã lưu Bot Token, nhưng chưa đăng ký được webhook\. Zalo từ chối: webhook refused for /);
    assert.ok(!r.text.includes(HOOKFAIL), 'the token is not in the response');
    const stored = called('settings.setMany')[0].args[0];
    assert.equal(stored['zalo.botToken'], HOOKFAIL, 'it was stored before the webhook step');
    secret = stored['zalo.webhookSecret'];
    assert.match(secret, /^[0-9a-f]{48}$/, 'the webhook secret is generated with the first token');
    assert.equal((await overview()).body.connection.tokenSet, true);
  });

  await t.test('admin: the token is checked with getMe, stored, and the webhook registered with the existing secret', async () => {
    reset();
    const r = await put(admin, { token: `  ${GOOD}  ` });   // surrounding spaces are trimmed
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['message', 'ok']);
    assert.equal(r.body.ok, true);
    assert.match(r.body.message, /^Đã lưu Bot Token\. Đã đăng ký webhook cho CoCoffee Bot: Zalo gọi thử thành công\.$/);

    assert.deepEqual(zalo.map((z) => z.method), ['getMe', 'getMe', 'setWebhook'], 'check, then the registration (getMe for the bot name)');
    assert.ok(zalo.every((z) => z.url.includes(`/bot${GOOD}/`)), 'always with the new token');
    const stored = called('settings.setMany')[0].args[0];
    assert.equal(stored['zalo.botToken'], GOOD);
    assert.equal('zalo.webhookSecret' in stored, false, 'the secret is only generated when there is none');
    const hook = zalo.find((z) => z.method === 'setWebhook');
    assert.equal(hook.body.url, 'https://cafe.example.test/api/zalo/webhook');
    assert.equal(hook.body.secret_token, secret);
    assert.equal(called('settings.setMany')[0].args[1], 1, 'saved by the admin user');
    assert.ok(!r.text.includes(GOOD), 'the token is not in the response');
  });

  await t.test('the overview after saving: configured, but no token and no hint of it, anywhere', async () => {
    const r = await overview();
    assert.equal(r.status, 200);
    const c = r.body.connection;
    assert.equal(c.tokenSet, true);
    assert.equal(c.platform, true);
    assert.equal(c.mode, 'platform');
    assert.equal(c.tokenSource, 'admin');
    assert.equal(c.configured, true);
    assert.equal('tokenHint' in c, false);
    assert.ok(!r.text.includes(GOOD) && !r.text.includes('…ONLY') && !r.text.includes(secret), 'no token, hint or webhook secret in the JSON');
    assert.ok(!r.text.includes('botToken') && !r.text.includes('botWebhookSecret'));
  });

  await t.test('replacing the token keeps the same webhook secret and still never answers with it', async () => {
    reset();
    const r = await put(admin, { token: SECOND });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(SECOND));
    const stored = called('settings.setMany')[0].args[0];
    assert.equal(stored['zalo.botToken'], SECOND);
    assert.equal('zalo.webhookSecret' in stored, false);
    assert.equal(zalo.find((z) => z.method === 'setWebhook').body.secret_token, secret);
    const o = await overview();
    assert.ok(!o.text.includes(SECOND) && !o.text.includes('…COND'));
    assert.equal(o.body.connection.tokenSet, true);
  });

  await t.test('the web register-webhook button of the app still works with the stored token', async () => {
    reset();
    const r = await api('POST', '/api/admin/zalo/register-webhook', { token: admin });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(zalo.every((z) => z.url.includes(`/bot${SECOND}/`)));
    assert.ok(!r.text.includes(SECOND));
  });

  await t.test('re-registering with a token whose webhook Zalo refuses does not echo the token either', async () => {
    assert.equal((await put(admin, { token: HOOKFAIL })).status, 502);   // stores it (webhook step fails)
    reset();
    const r = await api('POST', '/api/admin/zalo/register-webhook', { token: admin });
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /^Zalo từ chối: webhook refused for … /);
    assert.ok(!r.text.includes(HOOKFAIL));
  });

  await t.test('no log line of the whole run contains a token', async () => {
    noTokenLogged();
  });
});
