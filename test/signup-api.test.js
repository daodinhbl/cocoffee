/** /api/signup: the JSON sign-up the app's "Tạo quán mới" screen uses (same rules as /dang-ky). Data layer faked. */
process.env.TENANT_BASE_DOMAIN = 'example.test';
process.env.TENANT_DEFAULT_SLUG = 'cocoffee';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mock } = require('node:test');
const express = require('express');

const tenantService = require('../src/services/tenantService');
const tenantModel = require('../src/models/tenantModel');
const signupApiRoutes = require('../src/routes/signupApiRoutes');
const { errorHandler } = require('../src/middlewares/errorHandler');

const good = { slug: 'quan-a', name: 'Quán A', ownerName: 'Nguyễn Văn A', email: 'a@example.com', phone: '0909123456', username: 'ChuQuan', password: 'matkhau-dai-123' };

async function serve(t, setup = () => {}) {
  const app = express();
  app.use(express.json());
  setup(app);
  app.use('/api/signup', signupApiRoutes);
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); mock.restoreAll(); });
  return `http://127.0.0.1:${server.address().port}/api/signup`;
}

test('JSON sign-up: info, availability, create, waiting, errors', async (t) => {
  const base = await serve(t);
  const taken = new Set(['da-co']);
  const created = [];
  const rows = {};
  mock.method(tenantModel, 'slugTaken', async (s) => taken.has(s));
  mock.method(tenantModel, 'insert', async (row) => { created.push(row); taken.add(row.slug); return created.length; });
  mock.method(tenantModel, 'findBySlug', async (s) => rows[s] || null);
  let provisioned = 'active';
  mock.method(tenantService, 'provision', async () => provisioned);
  const post = (body) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await t.test('info names the base domain', async () => {
    assert.deepEqual(await (await fetch(base)).json(), { open: true, base_domain: 'example.test' });
  });

  await t.test('availability check', async () => {
    const free = await (await fetch(`${base}/check?slug=quan-moi`)).json();
    assert.equal(free.ok, true);
    assert.equal(free.url, 'https://quan-moi.example.test');
    assert.equal((await (await fetch(`${base}/check?slug=da-co`)).json()).ok, false);
    const reserved = await (await fetch(`${base}/check?slug=www`)).json();
    assert.equal(reserved.ok, false);
    assert.match(reserved.message, /dành riêng/);
  });

  await t.test('a valid sign-up answers 201 with the shop address, stores only a bcrypt hash', async () => {
    const res = await post({ ...good, password2: good.password });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body, { slug: 'quan-a', status: 'active', url: 'https://quan-a.example.test', base_domain: 'example.test', username: 'chuquan' });
    assert.equal(created.length, 1);
    assert.match(created[0].ownerPasswordHash, /^\$2[aby]\$12\$/);
    assert.ok(!JSON.stringify(created[0]).includes(good.password));
  });

  await t.test('no spare database yet: status pending, and /status follows it', async () => {
    provisioned = 'pending';
    const body = await (await post({ ...good, slug: 'quan-b', password2: good.password })).json();
    assert.equal(body.status, 'pending');
    rows['quan-b'] = { slug: 'quan-b', status: 'pending', db_name: null };
    assert.deepEqual(await (await fetch(`${base}/status?slug=quan-b`)).json(), { status: 'pending' });
    rows['quan-b'] = { slug: 'quan-b', status: 'active', db_name: 'u1_shop' };
    assert.deepEqual(await (await fetch(`${base}/status?slug=quan-b`)).json(), { status: 'active' });
    rows['quan-b'] = { slug: 'quan-b', status: 'suspended', db_name: 'u1_shop', delete_after: new Date() };
    assert.deepEqual(await (await fetch(`${base}/status?slug=quan-b`)).json(), { status: 'unknown' });
    assert.deepEqual(await (await fetch(`${base}/status?slug=khong-co`)).json(), { status: 'unknown' });
  });

  await t.test('errors carry the API shape and the field', async () => {
    const dup = await post({ ...good, slug: 'da-co', password2: good.password });
    assert.equal(dup.status, 409);
    const d = await dup.json();
    assert.equal(d.error.code, 'DUPLICATE');
    assert.deepEqual(d.error.details, { field: 'slug' });
    const bad = await post({ ...good, slug: 'quan-c', password2: 'khac-hoan-toan' });
    assert.equal(bad.status, 400);
    const b = await bad.json();
    assert.equal(b.error.code, 'VALIDATION');
    assert.equal(b.error.details.field, 'password2');
    assert.ok(!JSON.stringify(b).includes(good.password), 'the password is never echoed');
    const before = created.length;
    const bot = await post({ ...good, slug: 'bot-1', password2: good.password, website: 'http://spam' });
    assert.equal(bot.status, 400);
    assert.equal(created.length, before, 'the honeypot creates nothing');
  });
});

test('JSON sign-up is not served on a shop host', async (t) => {
  const base = await serve(t, (app) => app.use((req, _res, next) => { req.tenant = { id: 7 }; next(); }));
  const res = await fetch(base);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'NOT_FOUND');
});

test('the /api router mounts sign-up before the bearer-token wall', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/routes/index.js'), 'utf8');
  assert.ok(src.indexOf("router.use('/signup'") > 0 && src.indexOf("router.use('/signup'") < src.indexOf('router.use(requireAuth)'));
});
