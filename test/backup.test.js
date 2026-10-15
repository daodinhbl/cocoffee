/**
 * Backup / restore: the dump writer, the strict restore parser, and the Web Admin page + upload route.
 * The database is faked (see helpers/adminFixture.js); files go to a temp folder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { mock } = require('node:test');
const { start, PASSWORD } = require('./helpers/adminFixture');

const CREATE = 'CREATE TABLE `customers` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `name` varchar(120) NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';

/** A connection that answers just the statements the dump and the table lookup issue. */
function fakeConn(rows) {
  const ran = [];
  return {
    ran,
    release() {},
    escape: (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`,
    async query(sql) {
      const text = typeof sql === 'string' ? sql : sql.sql;
      ran.push(text);
      if (/information_schema\.tables WHERE table_schema = DATABASE\(\) AND table_type/.test(text)) return [[{ name: 'customers' }]];
      if (/^SHOW CREATE TABLE/.test(text)) return [[{ 'Create Table': CREATE }]];
      if (/^SHOW KEYS/.test(text)) return [[{ Column_name: 'id', Seq_in_index: 1 }]];
      if (/avg_row_length/.test(text)) return [[{ size: 40 }]];
      if (/^SELECT \* FROM/.test(text)) return [/OFFSET 0$/.test(text) ? rows : []];
      return [[]];
    },
  };
}

test('backup', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-backup-'));
  const fx = await start();
  t.after(() => { fx.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const env = require('../src/config/env');
  env.backupDir = dir;
  const { pool } = require('../src/config/db');
  const svc = require('../src/services/backupService');
  const conn = fakeConn([{ id: 1, name: "Chị Lan 'VIP'\nlầu 2" }, { id: 2, name: null }]);
  mock.method(pool, 'getConnection', async () => conn);
  const known = new Set(['customers']);
  mock.method(require('../src/config/bootstrapDb'), 'ensureSchemaUpgrades', async () => 'ok');

  await t.test('a dump is one statement per line and parses back', async () => {
    const { name } = await svc.createStored('manual');
    assert.match(name, /^cocoffee-manual-\d{8}-\d{6}-[a-f0-9]{4}\.sql\.gz$/);
    const sql = zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString('utf8');
    assert.ok(sql.startsWith(svc.HEADER) && sql.trimEnd().endsWith(svc.FOOTER));
    assert.match(sql, /INSERT INTO `customers` \(`id`, `name`\) VALUES \(1,'Chị Lan \\'VIP\\'\\nlầu 2'\),\(2,NULL\);/);
    const parsed = svc.parse(fs.readFileSync(path.join(dir, name)), known);
    assert.deepEqual(parsed.tables, ['customers']);
    assert.ok(parsed.statements.every((s) => !s.includes('\n')));
    assert.ok(conn.ran.includes('START TRANSACTION WITH CONSISTENT SNAPSHOT'));
  });

  await t.test('the parser only accepts our own statements on our own tables', () => {
    const wrap = (...lines) => Buffer.from([svc.HEADER, ...lines, svc.FOOTER].join('\n'));
    const ok = ['DROP TABLE IF EXISTS `customers`;', `${CREATE.replace(/\n\s*/g, ' ')};`, 'INSERT INTO `customers` (`id`) VALUES (1);'];
    assert.equal(svc.parse(wrap(...ok), known).statements.length, 3);
    assert.throws(() => svc.parse(wrap(...ok, 'DROP DATABASE x;'), known), /không hợp lệ/);
    assert.throws(() => svc.parse(wrap('DROP TABLE IF EXISTS `users2`;'), known), /không có trong hệ thống/);
    assert.throws(() => svc.parse(wrap('INSERT INTO `customers` (`id`) VALUES (1);'), known), /đứng trước/);
    assert.throws(() => svc.parse(Buffer.from(`${svc.HEADER}\n${ok.join('\n')}`), known), /cắt dở/);
    assert.throws(() => svc.parse(Buffer.from('SELECT 1;'), known), /không phải file sao lưu/);
    assert.throws(() => svc.parse(Buffer.from([0x1f, 0x8b, 1, 2, 3]), known), /bị hỏng/);
  });

  await t.test('names are validated, so nothing outside the backup folder can be touched', () => {
    for (const bad of ['../x', 'cocoffee-manual-1.sql.gz', 'passwd', '..\\app.js']) assert.throws(() => svc.pathOf(bad), /Không tìm thấy/);
  });

  await t.test('retention keeps the newest N of one kind only', async () => {
    for (let i = 0; i < 4; i += 1) { await svc.createStored('auto'); await new Promise((r) => setTimeout(r, 15)); }
    await svc.createStored('pre-restore');
    const before = (await svc.list()).filter((f) => f.kind === 'manual').length;
    await svc.saveSettings({ autoEnabled: '1', intervalHours: '24', keep: '2' }, 1);
    await svc.runAutoIfDue();                      // a recent auto file exists: nothing new
    assert.equal((await svc.list()).filter((f) => f.kind === 'auto').length, 4);
    assert.equal(await svc.prune('auto', 2), 2);
    const list = await svc.list();
    assert.equal(list.filter((f) => f.kind === 'auto').length, 2);
    assert.equal(list.filter((f) => f.kind === 'manual').length, before, 'other kinds are untouched');
    assert.equal(list.filter((f) => f.kind === 'pre-restore').length, 1);
  });

  await t.test('restore replays the file and snapshots first', async () => {
    const { name } = (await svc.list()).find((f) => f.kind === 'manual');
    conn.ran.length = 0;
    const r = await svc.restore(name);
    assert.equal(r.tables, 1);
    assert.match(r.snapshot, /pre-restore/);
    const iDrop = conn.ran.findIndex((s) => s.startsWith('DROP TABLE'));
    assert.ok(iDrop > conn.ran.findIndex((s) => s === 'ROLLBACK'), 'the snapshot transaction ended before the first DROP');
    assert.ok(conn.ran.some((s) => s.startsWith('INSERT INTO `customers`')));
  });

  await t.test('page, upload route and restore password check (admin only)', async () => {
    const { c } = await fx.login();
    const page = await c.get('/admin/backup');
    const html = await page.text();
    assert.equal(page.status, 200);
    for (const re of [/Sao lưu ngay/, /Sao lưu tự động/, /cocoffee-manual-/, /Khôi phục từ file/]) assert.match(html, re);
    const csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)[1];

    const cashier = (await fx.login('thungan')).c;
    assert.equal((await cashier.get('/admin/backup')).status, 303, 'a cashier is sent away');

    const mine = (await svc.list()).find((f) => f.kind === 'manual').name;
    const file = zlib.gunzipSync(fs.readFileSync(path.join(dir, mine)));
    // the test client only sends form/json bodies, so use fetch directly with the session cookie
    const cookie = [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const send = (headers, body) => fetch(`${fx.base}/admin/backup/upload`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', ...headers }, body });
    assert.equal((await send({}, file)).status, 403, 'no CSRF header: refused');
    const bad = await send({ 'x-csrf-token': csrf }, Buffer.from('DROP DATABASE x;'));
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /không phải file sao lưu/);
    const good = await send({ 'x-csrf-token': csrf }, zlib.gzipSync(file));
    assert.equal(good.status, 200);
    const body = await good.json();
    assert.match(body.name, /^cocoffee-uploaded-/);
    assert.ok(fs.existsSync(path.join(dir, body.name)));

    conn.ran.length = 0;
    const wrongPw = await c.post(`/admin/backup/files/${body.name}/restore`, { _csrf: csrf, _back: '/admin/backup', password: 'not-my-password' });
    assert.equal(wrongPw.status, 303);
    assert.equal(conn.ran.filter((s) => s.startsWith('DROP TABLE')).length, 0, 'wrong password restores nothing');
    const okPw = await c.post(`/admin/backup/files/${body.name}/restore`, { _csrf: csrf, _back: '/admin/backup', password: PASSWORD });
    assert.equal(okPw.status, 303);
    assert.ok(conn.ran.some((s) => s.startsWith('DROP TABLE')), 'right password restores');

    const dl = await c.get(`/admin/backup/files/${body.name}`);
    assert.equal(dl.status, 200);
    assert.equal((await c.get('/admin/backup/files/..%2Fapp.js')).status, 404);
    const del = await c.post(`/admin/backup/files/${body.name}/delete`, { _csrf: csrf, _back: '/admin/backup' });
    assert.equal(del.status, 303);
    assert.ok(!fs.existsSync(path.join(dir, body.name)));
  });
});
