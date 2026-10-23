/**
 * Account deletion (Google Play): POST /api/account/delete from the app, the public page /xoa-tai-khoan, and the
 * purge after the grace period. Data layer faked.
 */
process.env.TENANT_BASE_DOMAIN = 'example.test';
process.env.TENANT_DEFAULT_SLUG = 'cocoffee';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { mock } = require('node:test');
const express = require('express');
const bcrypt = require('bcryptjs');

const tenantContext = require('../src/config/tenantContext');
const tenantService = require('../src/services/tenantService');
const tenantModel = require('../src/models/tenantModel');
const userModel = require('../src/models/userModel');
const accountDeletion = require('../src/services/accountDeletion');
const account = require('../src/controllers/api/accountApi');
const accountDeletionRoutes = require('../src/routes/accountDeletionRoutes');
const { errorHandler } = require('../src/middlewares/errorHandler');

const PASSWORD = 'matkhau-dai-123';
const HASH = bcrypt.hashSync(PASSWORD, 4);
const SHOP = { id: 7, slug: 'quan-a', name: 'Quán A', db: { host: 'x' } };

/** The registry: quan-a (active, own database), cho (waiting for a database). */
function fakeRegistry() {
  const rows = {
    7: { id: 7, slug: 'quan-a', name: 'Quán A', status: 'active', db_id: 3, db_name: 'u1_a', db_host: 'h', db_port: 3306, db_user: 'u', db_password_enc: tenantService.encrypt('p'), owner_username: 'chuquan', owner_password_hash: null, delete_after: null },
    8: { id: 8, slug: 'cho', name: 'Quán Chờ', status: 'pending', db_id: null, db_name: null, owner_username: 'chu2', owner_password_hash: HASH, delete_after: null },
  };
  const deleted = [];
  const released = [];
  mock.method(tenantModel, 'findById', async (id) => rows[id] || null);
  mock.method(tenantModel, 'findBySlug', async (s) => Object.values(rows).find((r) => r.slug === s) || null);
  mock.method(tenantModel, 'requestDeletion', async (id, days) => { rows[id] = { ...rows[id], status: 'suspended', delete_after: new Date(Date.now() + days * 864e5) }; });
  mock.method(tenantModel, 'listDueForPurge', async () => Object.values(rows).filter((r) => r.delete_after && r.delete_after <= new Date()).map((r) => ({ id: r.id })));
  mock.method(tenantModel, 'releaseDb', async (id) => { released.push(id); });
  mock.method(tenantModel, 'remove', async (id) => { deleted.push(id); delete rows[id]; });
  mock.method(tenantService, 'provisionPending', async () => 0);
  // The shop's own database: one admin, one cashier.
  const users = { chuquan: { id: 1, username: 'chuquan', role: 'admin', is_active: 1, password_hash: HASH }, thungan: { id: 2, username: 'thungan', role: 'cashier', is_active: 1, password_hash: HASH } };
  mock.method(userModel, 'findByUsername', async (u) => (tenantContext.current()?.id === 7 ? users[u] || null : null));
  return { rows, deleted, released };
}

async function serve(t, mount) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.json());
  mount(app);
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); mock.restoreAll(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('in the app: an admin of a signed-up shop deletes it with password + slug', async (t) => {
  const reg = fakeRegistry();
  let as = { shop: SHOP, user: { id: 1, username: 'chuquan', role: 'admin' } };
  const base = await serve(t, (app) => {
    app.use((req, _res, next) => { req.user = as.user; return as.shop ? tenantContext.run(as.shop, () => next()) : next(); });
    app.get('/api/account', account.info);
    app.post('/api/account/delete', account.remove);
  });
  const del = (body) => fetch(`${base}/api/account/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const info = await (await fetch(`${base}/api/account`)).json();
  assert.deepEqual(info, { deletable: true, shop: { slug: 'quan-a', name: 'Quán A' }, grace_days: 30, reason: null });

  const wrongSlug = await del({ password: PASSWORD, confirm: 'quan-b' });
  assert.equal(wrongSlug.status, 400);
  assert.equal((await wrongSlug.json()).error.details.field, 'confirm');
  const wrongPw = await del({ password: 'sai-mat-khau-1', confirm: 'quan-a' });
  assert.equal(wrongPw.status, 401);
  assert.equal((await wrongPw.json()).error.code, 'BAD_CREDENTIALS', 'not UNAUTHORIZED: the app must not sign out');
  assert.equal(reg.rows[7].delete_after, null);

  const ok = await del({ password: PASSWORD, confirm: ' Quan-A ' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.slug, 'quan-a');
  assert.equal(body.grace_days, 30);
  assert.equal(reg.rows[7].status, 'suspended');
  assert.ok(reg.rows[7].delete_after > new Date(Date.now() + 29 * 864e5));

  as = { shop: SHOP, user: { id: 2, username: 'thungan', role: 'cashier' } };
  assert.equal((await (await fetch(`${base}/api/account`)).json()).reason, 'not_admin');
  assert.equal((await del({ password: PASSWORD, confirm: 'quan-a' })).status, 403);

  as = { shop: null, user: { id: 1, username: 'chuquan', role: 'admin' } };
  const main = await (await fetch(`${base}/api/account`)).json();
  assert.equal(main.deletable, false);
  assert.equal(main.reason, 'not_signup_shop');
  const refused = await del({ password: PASSWORD, confirm: 'cocoffee' });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'ACCOUNT_NOT_DELETABLE');
});

test('a shop with a deletion request stops serving (410)', async () => {
  mock.method(tenantModel, 'findBySlug', async () => ({ id: 7, slug: 'quan-z', status: 'suspended', db_name: 'x', delete_after: new Date() }));
  tenantService.forget('quan-z');
  try {
    assert.equal(await tenantService.resolve('quan-z'), 'deleting');
  } finally {
    tenantService.forget('quan-z');
    mock.restoreAll();
  }
});

test('the web page /xoa-tai-khoan: explains the in-app path and takes a request', async (t) => {
  const reg = fakeRegistry();
  const base = await serve(t, (app) => app.use('/xoa-tai-khoan', accountDeletionRoutes));
  const post = (body) => fetch(`${base}/xoa-tai-khoan`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

  const html = await (await fetch(`${base}/xoa-tai-khoan`)).text();
  assert.match(html, /Xóa tài khoản và dữ liệu/);
  assert.match(html, /Cài đặt › Xóa tài khoản và dữ liệu/);
  assert.match(html, /Xóa toàn bộ dữ liệu trên máy/);
  assert.match(html, /30 ngày/);
  assert.match(html, /\.example\.test/);
  assert.match(html, /href="mailto:[^"@]+@[^"]+"/);

  const noTick = await post({ slug: 'quan-a', username: 'chuquan', password: PASSWORD });
  assert.equal(noTick.status, 400);
  const wrong = await post({ slug: 'quan-a', username: 'chuquan', password: 'sai-mat-khau', agree: '1' });
  assert.equal(wrong.status, 401);
  const wrongHtml = await wrong.text();
  assert.match(wrongHtml, /Sai tên miền phụ/);
  assert.ok(!wrongHtml.includes('sai-mat-khau'), 'the password is never echoed');
  assert.equal((await post({ slug: 'quan-a', username: 'thungan', password: PASSWORD, agree: '1' })).status, 401, 'a cashier cannot delete the shop');
  assert.equal((await post({ slug: 'khong-co', username: 'chuquan', password: PASSWORD, agree: '1' })).status, 401);
  assert.equal(reg.rows[7].delete_after, null);

  const done = await post({ slug: 'quan-a', username: 'chuquan', password: PASSWORD, agree: '1' });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Đã nhận yêu cầu xóa quán <b>quan-a<\/b>/);
  assert.ok(reg.rows[7].delete_after);

  // A sign-up still waiting for its database: checked against the owner account kept in the registry.
  assert.equal((await post({ slug: 'cho', username: 'chu2', password: PASSWORD, agree: '1' })).status, 200);
  assert.ok(reg.rows[8].delete_after);

  const bot = await post({ slug: 'quan-a', username: 'chuquan', password: PASSWORD, agree: '1', website: 'http://spam' });
  assert.equal(bot.status, 303);
});

test('purge: past the grace period the tables are dropped, the database freed and the shop forgotten', async (t) => {
  const reg = fakeRegistry();
  t.after(() => mock.restoreAll());
  const sql = [];
  mock.method(tenantService, 'openConnection', async () => ({
    query: async (q) => {
      sql.push(q);
      return q.startsWith('SELECT') ? [[{ name: 'orders', type: 'BASE TABLE' }, { name: 'users', type: 'BASE TABLE' }, { name: 'v_sales', type: 'VIEW' }]] : [[]];
    },
    end: async () => {},
  }));
  reg.rows[7].delete_after = new Date(Date.now() + 864e5);
  assert.equal(await accountDeletion.purgeDue(), 0, 'not yet');
  reg.rows[7].delete_after = new Date(Date.now() - 1000);
  reg.rows[8].delete_after = new Date(Date.now() - 1000);
  assert.equal(await accountDeletion.purgeDue(), 2);
  assert.deepEqual(sql.filter((q) => q.startsWith('DROP')), ['DROP TABLE IF EXISTS `orders`', 'DROP TABLE IF EXISTS `users`', 'DROP VIEW IF EXISTS `v_sales`']);
  assert.deepEqual(reg.released.sort(), [7, 8]);
  assert.deepEqual(reg.deleted.sort(), [7, 8]);
  assert.equal(sql.filter((q) => q.startsWith('SELECT')).length, 1, 'the waiting sign-up had no database to empty');
});
