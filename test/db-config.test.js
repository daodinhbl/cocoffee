const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock } = require('node:test');
const mysql = require('mysql2/promise');
const { start } = require('./helpers/adminFixture');
const env = require('../src/config/env');
const dbConfig = require('../src/services/dbConfig');

const NEWPW = 'mat-khau-csdl-moi-9X';

test('Kết nối cơ sở dữ liệu: change server, name, user, password from Cài đặt', async (t) => {
  const fx = await start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbcfg-'));
  const before = env.dbConfigFile;
  env.dbConfigFile = path.join(dir, 'db-config.json');
  const attempts = [];
  let failWith = null;
  mock.method(mysql, 'createConnection', async (o) => {
    attempts.push({ host: o.host, port: o.port, user: o.user, database: o.database, password: o.password });
    if (failWith) { const e = new Error('x'); e.code = failWith; throw e; }
    return { query: async (sql) => [[/VERSION/.test(sql) ? { v: '10.11.6-MariaDB' } : { n: 35 }]], end: async () => {} };
  });
  t.after(() => { fx.stop(); mock.restoreAll(); env.dbConfigFile = before; fs.rmSync(dir, { recursive: true, force: true }); });
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);
  const form = (over = {}) => ({ _csrf: token, _back: '/admin/settings', section: 'cloud', host: 'srv2089.hstgr.io', port: '3306', name: 'u1_cocoffee', user: 'u1_cocoffee', password: NEWPW, admin_password: fx.PASSWORD, ...over });
  const saved = () => (fs.existsSync(env.dbConfigFile) ? JSON.parse(fs.readFileSync(env.dbConfigFile, 'utf8')) : null);

  await t.test('the card is on the page and shows no password', async () => {
    const html = await (await admin.get('/admin/settings')).text();
    assert.match(html, /Kết nối cơ sở dữ liệu/);
    assert.match(html, /action="\/admin\/settings\/db\/save"/);
    assert.match(html, /name="admin_password"/);
  });

  await t.test('a wrong admin password stops everything: nothing is tested or saved', async () => {
    await admin.post('/admin/settings/db/save', form({ admin_password: 'sai-mat-khau' }));
    await admin.post('/admin/settings/db/test', form({ admin_password: '' }));
    assert.equal(attempts.length, 0);
    assert.equal(saved(), null);
  });

  await t.test('validation: host, port, names, missing password', async () => {
    for (const bad of [{ host: 'a b' }, { host: '' }, { port: '70000' }, { name: 'ten csdl' }, { user: '' }, { password: '' }]) {
      await admin.post('/admin/settings/db/save', form(bad));
    }
    assert.equal(attempts.length, 0);
    assert.equal(saved(), null);
  });

  await t.test('a connection that does not open is not saved, with the reason', async () => {
    failWith = 'ER_ACCESS_DENIED_ERROR';
    await admin.post('/admin/settings/db/save', form());
    assert.equal(attempts.length, 1);
    assert.equal(saved(), null);
    await assert.rejects(dbConfig.test('cloud', form()), (e) => e.status === 400 && /Sai tên người dùng hoặc mật khẩu/.test(e.message));
    failWith = 'ECONNREFUSED';
    await assert.rejects(dbConfig.test('cloud', form()), /từ chối kết nối/);
    failWith = 'ENOTFOUND';
    await assert.rejects(dbConfig.test('cloud', form()), /Không tìm thấy máy chủ/);
    failWith = null;
  });

  await t.test('test button reports the server and the tables; save writes the file and asks for a restart', async () => {
    attempts.length = 0;
    await admin.post('/admin/settings/db/test', form());
    assert.equal(attempts.at(-1).host, 'srv2089.hstgr.io');
    assert.equal(saved(), null, 'testing does not save');
    const res = await admin.post('/admin/settings/db/save', form());
    assert.equal(res.status, 303);
    assert.deepEqual(saved().cloud, { host: 'srv2089.hstgr.io', port: 3306, name: 'u1_cocoffee', user: 'u1_cocoffee', password: NEWPW });
    const html = await (await admin.get('/admin/settings')).text();
    assert.ok(!html.includes(NEWPW), 'the password never comes back to the browser');
    assert.match(html, /Cần khởi động lại/);
    assert.match(html, /Để trống để giữ mật khẩu hiện tại/);
    assert.match(html, /value="srv2089\.hstgr\.io"/);
    assert.equal(dbConfig.view().sections.cloud.restartNeeded, true);
  });

  await t.test('a blank password field keeps the saved one', async () => {
    attempts.length = 0;
    await admin.post('/admin/settings/db/save', form({ password: '', user: 'u1_other' }));
    assert.equal(attempts.at(-1).password, NEWPW, 'the saved password is kept');
    assert.equal(attempts.at(-1).user, 'u1_other');
    assert.equal(saved().cloud.password, NEWPW);
  });

  await t.test('the env reads the file at start (what makes the change apply after a restart)', () => {
    const code = `const e = require(${JSON.stringify(path.resolve(__dirname, '../src/config/env'))}); process.stdout.write(JSON.stringify({ h: e.cloudSync.host, n: e.cloudSync.name, p: e.cloudSync.password }));`;
    const out = require('node:child_process').execFileSync(process.execPath, ['-e', code], {
      env: { ...process.env, DB_CONFIG_FILE: env.dbConfigFile, DB_NAME: 'x', DB_USER: 'x', DB_PASSWORD: 'x', CLOUD_DB_HOST: 'env-host' }, encoding: 'utf8',
    });
    const j = JSON.parse(out);
    assert.equal(j.h, 'srv2089.hstgr.io', 'the file wins over CLOUD_DB_HOST');
    assert.equal(j.n, 'u1_cocoffee');
  });

  await t.test('reset removes the section; restart needs a supervisor', async () => {
    await admin.post('/admin/settings/db/reset', form());
    assert.equal(saved().cloud, undefined);
    assert.equal(dbConfig.canRestart(), false);
    assert.throws(() => dbConfig.restart(), (e) => e.status === 409 && /tự khởi động lại/.test(e.message));
  });

  await t.test('the app API: needs admin_password, never returns the password, cashier refused', async () => {
    const login = (u) => fetch(`${fx.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: fx.PASSWORD }) }).then((r) => r.json());
    const call = (bearer, method, p, body) => fetch(`${fx.base}/api/admin/settings/${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const boss = (await login('boss')).token;
    const body = { section: 'cloud', host: 'srv2089.hstgr.io', port: 3306, name: 'u1_cocoffee', user: 'u1_cocoffee', password: NEWPW };
    assert.equal((await call(boss, 'PUT', 'db', { ...body, admin_password: 'sai' })).status, 403);
    const t1 = await call(boss, 'POST', 'db/test', { ...body, admin_password: fx.PASSWORD });
    assert.equal(t1.status, 200);
    assert.deepEqual(await t1.json(), { ok: true, version: '10.11.6-MariaDB', tables: 35, empty: false });
    const put = await call(boss, 'PUT', 'db', { ...body, admin_password: fx.PASSWORD });
    const pj = await put.json();
    assert.equal(put.status, 200);
    assert.equal(pj.restartNeeded, true);
    assert.ok(!JSON.stringify(pj).includes(NEWPW));
    const get = await (await fetch(`${fx.base}/api/admin/settings`, { headers: { authorization: `Bearer ${boss}` } })).json();
    assert.ok(!JSON.stringify(get).includes(NEWPW));
    assert.equal(get.db_conn.sections.cloud.saved.hasPassword, true);
    assert.equal((await call(boss, 'DELETE', 'db', { section: 'cloud', admin_password: fx.PASSWORD })).status, 200);
    const cashier = (await login('thungan')).token;
    assert.equal((await call(cashier, 'PUT', 'db', { ...body, admin_password: fx.PASSWORD })).status, 403);
  });
});
