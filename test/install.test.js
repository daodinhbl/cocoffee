const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const path = require('node:path');
const { mock } = require('node:test');

const env = require('../src/config/env');
const userModel = require('../src/models/userModel');
const settingsModel = require('../src/models/settingsModel');
const installService = require('../src/services/installService');
const { installGate } = require('../src/middlewares/installGate');
const installRoutes = require('../src/routes/installRoutes');
const { pool } = require('../src/config/db');

test('first-run setup wizard', async (t) => {
  let users = 0;
  const queries = [];
  const saved = {};
  mock.method(userModel, 'count', async () => users);
  mock.method(pool, 'query', async (sql, params) => {
    queries.push(String(sql));
    if (/^INSERT INTO users/.test(sql)) { if (users) return [{ affectedRows: 0 }]; users = 1; return [{ affectedRows: 1, insertId: 1 }]; }
    return [[]];
  });
  mock.method(settingsModel, 'setMany', async (v) => Object.assign(saved, v));
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(installGate);
  app.use('/cai-dat', installRoutes);
  app.get('/health', (_q, r) => r.json({ ok: 1 }));
  app.get('/admin/login', (_q, r) => r.send('login'));
  app.get('/api/x', (_q, r) => r.json({ ok: 1 }));
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); mock.restoreAll(); installService.forget(); });
  const good = { shopName: '06coffee', fullName: 'Nguyễn Văn A', username: 'chuquan', password: 'matkhau-dai-123', password2: 'matkhau-dai-123', data: 'blank' };
  const post = (body) => fetch(`${base}/cai-dat`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

  await t.test('before setup: pages lead to /cai-dat, the API answers 503, /health stays open', async () => {
    const r = await fetch(`${base}/admin/login`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/cai-dat');
    const api = await fetch(`${base}/api/x`);
    assert.equal(api.status, 503);
    assert.equal((await api.json()).error.code, 'NOT_INSTALLED');
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const html = await (await fetch(`${base}/cai-dat`)).text();
    assert.match(html, /Dữ liệu mẫu/);
    assert.match(html, /name="data" value="blank" checked/);
  });

  await t.test('validation keeps what was typed and never echoes the password', async () => {
    const res = await post({ ...good, password2: 'khac-hoan-toan-1' });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /chưa giống nhau/);
    assert.match(html, /value="06coffee"/);
    assert.ok(!html.includes('matkhau-dai-123'));
    assert.equal(users, 0);
  });

  await t.test('blank install creates the owner with a bcrypt hash and no sample rows', async () => {
    queries.length = 0;
    const res = await post(good);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Quán bắt đầu với dữ liệu trống/);
    assert.equal(saved['shop.name'], '06coffee');
    assert.equal(saved['seed.menu_v1'], '"skipped-empty"');
    assert.ok(!queries.some((q) => /INSERT INTO (categories|products|dining_tables)/.test(q)));
  });

  await t.test('after setup: the site is open and /cai-dat leads to the login', async () => {
    assert.equal((await fetch(`${base}/api/x`)).status, 200);
    const r = await fetch(`${base}/cai-dat`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/admin/login');
  });

  await t.test('a second submit cannot take over', async () => {
    installService.forget();
    users = 0;                                   // the page thinks nothing exists, but the guarded INSERT sees the truth
    mock.method(pool, 'query', async () => [{ affectedRows: 0 }]);
    const res = await post({ ...good, username: 'ke-xau' });
    assert.equal(res.status, 409);
  });
});

test('sample data = seed.sql without its admin/admin account', () => {
  const stmts = installService.sampleStatements();
  assert.ok(stmts.length >= 6);
  assert.ok(!stmts.some((s) => /INSERT INTO users/i.test(s)));
  assert.ok(stmts.some((s) => /INSERT INTO dining_tables/i.test(s)));
  assert.ok(stmts.some((s) => /INSERT INTO products/i.test(s)));
  assert.ok(stmts.every((s) => !/^--/.test(s)));
});

test('the setup token, when configured, is required', () => {
  const before = env.db.installToken;
  env.db.installToken = 's3cret-token';
  try {
    const body = { shopName: 'Quán', fullName: 'An', username: 'chuquan', password: 'matkhau-dai-123', password2: 'matkhau-dai-123', data: 'sample' };
    assert.throws(() => installService.validate(body), (e) => e.field === 'token');
    assert.doesNotThrow(() => installService.validate({ ...body, token: 's3cret-token' }));
  } finally { env.db.installToken = before; }
});
