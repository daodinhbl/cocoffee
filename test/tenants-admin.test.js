process.env.TENANT_BASE_DOMAIN = 'example.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start } = require('./helpers/adminFixture');
const tenantModel = require('../src/models/tenantModel');
const tenantService = require('../src/services/tenantService');

test('Admin > Đăng ký quán', async (t) => {
  const fx = await start();
  t.after(() => { fx.stop(); mock.restoreAll(); });
  const shops = [
    { id: 1, slug: 'quan-a', name: 'Quán A', owner_name: 'An', owner_email: 'an@example.com', owner_phone: '090', owner_username: 'an', status: 'active', db_id: 1, db_name: 'db_a', error: null, created_at: new Date('2026-10-17T03:00:00Z') },
    { id: 2, slug: 'quan-b', name: 'Quán B', owner_name: 'Bình', owner_email: 'binh@example.com', owner_phone: null, owner_username: 'binh', status: 'pending', db_id: null, db_name: null, error: 'Chưa có database trống để cấp', created_at: new Date('2026-10-17T04:00:00Z') },
  ];
  const dbs = [{ id: 1, db_host: '127.0.0.1', db_name: 'db_a', db_user: 'u', tenant_id: 1, slug: 'quan-a' }, { id: 2, db_host: '127.0.0.1', db_name: 'db_spare', db_user: 'u', tenant_id: null, slug: null }];
  mock.method(tenantModel, 'list', async () => shops);
  mock.method(tenantModel, 'listDbs', async () => dbs);
  mock.method(tenantModel, 'findById', async (id) => shops.find((s) => s.id === id) || null);
  const calls = [];
  mock.method(tenantModel, 'setStatus', async (id, st) => { calls.push(['status', id, st]); });
  mock.method(tenantService, 'addDatabase', async (d) => { calls.push(['addDb', d.name, d.password]); return 3; });
  mock.method(tenantService, 'provisionPending', async () => 1);
  mock.method(tenantService, 'provision', async (id) => { calls.push(['provision', id]); return 'active'; });
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  await t.test('lists shops, statuses and spare databases; the sidebar links to it', async () => {
    const html = await (await admin.get('/admin/tenants')).text();
    const plain = text(html);
    assert.match(plain, /Quán A/);
    assert.match(plain, /quan-b\.example\.test/);
    assert.match(plain, /Chờ cấp DB/);
    assert.match(plain, /Chưa có database trống để cấp/);
    assert.match(plain, /db_spare/);
    assert.match(html, /href="\/admin\/tenants"/);
    assert.ok(!html.includes('owner_password'));
  });

  await t.test('adding a database sends the password to the service and finishes waiting shops', async () => {
    const res = await admin.post('/admin/tenants/databases', { _csrf: token, _back: '/admin/tenants', host: '127.0.0.1', port: '3306', name: 'db_new', user: 'u', password: 'bí-mật-123' });
    assert.equal(res.status, 303);
    assert.deepEqual(calls.find((c) => c[0] === 'addDb'), ['addDb', 'db_new', 'bí-mật-123']);
    const page = text(await (await admin.get('/admin/tenants')).text());
    assert.match(page, /hoàn tất 1 quán đang chờ/);
    assert.ok(!page.includes('bí-mật-123'), 'the password is never shown back');
  });

  await t.test('provision, suspend and reopen', async () => {
    await admin.post('/admin/tenants/2/provision', { _csrf: token, _back: '/admin/tenants' });
    assert.deepEqual(calls.find((c) => c[0] === 'provision'), ['provision', 2]);
    await admin.post('/admin/tenants/1/status', { _csrf: token, _back: '/admin/tenants', status: 'suspended' });
    assert.deepEqual(calls.find((c) => c[0] === 'status'), ['status', 1, 'suspended']);
    await admin.post('/admin/tenants/2/status', { _csrf: token, _back: '/admin/tenants', status: 'active' });
    assert.equal(calls.filter((c) => c[0] === 'status').length, 1, 'a shop without a database cannot be reopened');
  });

  await t.test('a write needs the CSRF token', async () => {
    const before = calls.length;
    await admin.post('/admin/tenants/1/status', { _back: '/admin/tenants', status: 'suspended' });
    assert.equal(calls.length, before, 'nothing happened without the token');
  });
});
