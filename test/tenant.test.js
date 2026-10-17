process.env.TENANT_BASE_DOMAIN = 'example.test';
process.env.TENANT_DEFAULT_SLUG = 'cocoffee';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mock } = require('node:test');

const tenantContext = require('../src/config/tenantContext');
const tenantService = require('../src/services/tenantService');
const tenantModel = require('../src/models/tenantModel');
const apiToken = require('../src/services/apiToken');
const { requireAuth } = require('../src/middlewares/auth');
const { tenantResolver } = require('../src/middlewares/tenant');
const signupRoutes = require('../src/routes/signupRoutes');
const express = require('express');

const good = { slug: 'quan-a', name: 'Quán A', ownerName: 'Nguyễn Văn A', email: 'a@example.com', phone: '0909123456', username: 'chuquan', password: 'matkhau-dai-123' };

test('host -> shop', () => {
  assert.equal(tenantService.slugOfHost('quan-a.example.test'), 'quan-a');
  assert.equal(tenantService.slugOfHost('QUAN-A.example.test:3030'), 'quan-a');
  assert.equal(tenantService.slugOfHost('example.test'), 'cocoffee');
  assert.equal(tenantService.slugOfHost('www.example.test'), 'cocoffee');
  assert.equal(tenantService.slugOfHost('a.b.example.test'), null, 'two labels is not a shop');
  assert.equal(tenantService.slugOfHost('localhost'), null);
  assert.equal(tenantService.slugOfHost('evilexample.test'), null);
});

test('sign-up validation', () => {
  assert.doesNotThrow(() => tenantService.validateSignup(good));
  const bad = (patch, field) => assert.throws(() => tenantService.validateSignup({ ...good, ...patch }), (e) => e.status === 400 && (!field || e.field === field), JSON.stringify(patch));
  bad({ slug: 'ab' }, 'slug');
  bad({ slug: '-abc' }, 'slug');
  bad({ slug: 'abc-' }, 'slug');
  bad({ slug: 'Quán' }, 'slug');
  bad({ slug: 'www' }, 'slug');
  bad({ slug: 'cocoffee' }, 'slug');
  bad({ email: 'khong-phai-email' }, 'email');
  bad({ username: 'A B' }, 'username');
  bad({ password: 'ngan' }, 'password');
  bad({ password2: 'khac-hoan-toan-1' }, 'password2');
  bad({ name: 'x' }, 'name');
});

test('database passwords are encrypted at rest and tamper-evident', () => {
  const blob = tenantService.encrypt('p@ss w0rd');
  assert.ok(!blob.includes('p@ss'));
  assert.equal(tenantService.decrypt(blob), 'p@ss w0rd');
  assert.notEqual(tenantService.encrypt('p@ss w0rd'), blob, 'fresh IV each time');
  const raw = Buffer.from(blob, 'base64');
  raw[raw.length - 1] ^= 1;
  assert.throws(() => tenantService.decrypt(raw.toString('base64')));
});

test('a token of one shop never opens another shop (or the main one)', async () => {
  const user = { id: 1, role: 'admin', password_hash: '$2a$12$abcdefghijklmnopqrstuv' };
  const shop = { id: 7, slug: 'quan-a', name: 'Quán A', db: {} };
  const fromShop = tenantContext.run(shop, () => apiToken.issue(user));
  const fromMain = apiToken.issue(user);
  const call = (token, ctx) => {
    const req = { get: () => `Bearer ${token}`, path: '/orders' };
    const run = () => requireAuth(req, {}, () => {});
    return ctx ? tenantContext.run(ctx, run) : run();
  };
  await assert.rejects(call(fromShop, null), (e) => e.status === 401, 'shop token on the main site');
  await assert.rejects(call(fromMain, shop), (e) => e.status === 401, 'main token on a shop');
  await assert.rejects(call(fromShop, { ...shop, id: 8 }), (e) => e.status === 401, 'shop token on another shop');
});

test('the resolver sends a request into its shop, and answers 404 / 503 for unknown / waiting ones', async () => {
  const shops = { 'quan-a': { id: 7, slug: 'quan-a', name: 'Quán A', db: { host: 'x' } }, cho: 'pending', khoa: 'suspended' };
  mock.method(tenantService, 'resolve', async (slug) => shops[slug] ?? null);
  const app = express();
  app.use(tenantResolver);
  app.get('/who', (req, res) => res.json({ id: tenantContext.key(), name: tenantContext.current()?.name || null }));
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  // fetch() ignores a custom Host header, so use http.get
  const get = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/who', headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(body) }));
    }).on('error', reject);
  });
  try {
    assert.deepEqual(await (await get('quan-a.example.test')).json(), { id: 7, name: 'Quán A' });
    assert.deepEqual(await (await get('cocoffee.example.test')).json(), { id: 0, name: null }, 'main shop');
    assert.deepEqual(await (await get('localhost')).json(), { id: 0, name: null }, 'unrelated host');
    assert.equal((await get('Xin_chao.example.test')).status, 404);
    assert.equal((await get('khong-co.example.test')).status, 404);
    assert.equal((await get('cho.example.test')).status, 503);
    assert.equal((await get('khoa.example.test')).status, 403);
  } finally {
    server.close();
    mock.restoreAll();
  }
});

test('sign-up page and form', async (t) => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').join(__dirname, '..', 'views'));
  app.use('/dang-ky', signupRoutes);
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); mock.restoreAll(); });
  const taken = new Set(['da-co']);
  const created = [];
  mock.method(tenantModel, 'slugTaken', async (s) => taken.has(s));
  mock.method(tenantModel, 'insert', async (row) => { created.push(row); taken.add(row.slug); return created.length; });
  let provisioned = 'active';
  mock.method(tenantService, 'provision', async () => provisioned);
  const post = (body) => fetch(`${base}/dang-ky`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

  await t.test('the form shows the base domain', async () => {
    const html = await (await fetch(`${base}/dang-ky`)).text();
    assert.match(html, /\.example\.test/);
    assert.match(html, /name="slug"/);
    assert.match(html, /src="\/signup\/signup\.js"/);
  });

  await t.test('availability check', async () => {
    assert.equal((await (await fetch(`${base}/dang-ky/kiem-tra?slug=quan-moi`)).json()).ok, true);
    assert.equal((await (await fetch(`${base}/dang-ky/kiem-tra?slug=da-co`)).json()).ok, false);
    assert.equal((await (await fetch(`${base}/dang-ky/kiem-tra?slug=www`)).json()).ok, false);
  });

  await t.test('a valid sign-up stores a bcrypt hash, never the password, and links to the shop', async () => {
    const res = await post({ ...good, password2: good.password });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /https:\/\/quan-a\.example\.test/);
    assert.equal(created.length, 1);
    assert.match(created[0].ownerPasswordHash, /^\$2[aby]\$12\$/);
    assert.ok(!JSON.stringify(created[0]).includes(good.password));
    assert.equal(created[0].ownerUsername, 'chuquan');
  });

  await t.test('no free database yet: the sign-up is kept as waiting', async () => {
    provisioned = 'pending';
    const html = await (await post({ ...good, slug: 'quan-b', password2: good.password })).text();
    assert.match(html, /đang chờ cấp cơ sở dữ liệu/);
  });

  await t.test('a taken name, a bad field and the honeypot', async () => {
    const dup = await post({ ...good, slug: 'da-co', password2: good.password });
    assert.equal(dup.status, 409);
    assert.match(await dup.text(), /đã có người dùng/);
    const bad = await post({ ...good, slug: 'quan-c', email: 'sai', password2: good.password });
    assert.equal(bad.status, 400);
    const html = await bad.text();
    assert.match(html, /Email không hợp lệ/);
    assert.match(html, /value="quan-c"/, 'what was typed is kept');
    assert.ok(!html.includes(good.password), 'the password is never echoed');
    const before = created.length;
    const bot = await fetch(`${base}/dang-ky`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...good, slug: 'bot-1', password2: good.password, website: 'http://spam' }) });
    assert.equal(bot.status, 303);
    assert.equal(created.length, before);
  });
});

test('sign-up is not served on a shop host', async () => {
  const app = express();
  app.use((req, _res, next) => { req.tenant = { id: 7 }; next(); });
  app.use('/dang-ky', signupRoutes);
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/dang-ky`)).status, 404);
  } finally { server.close(); }
});
