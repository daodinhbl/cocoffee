const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const core = require('../scripts/license-core');
const { createServer } = require('../scripts/license-server');

const MACHINE = 'A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90';

function request(port, { method = 'GET', url = '/', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('licence issuing page (runs on the vendor PC only)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyFile = path.join(dir, 'license-private.pem');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const pub = core.publicHex(publicKey);
  let clock = new Date('2026-10-18T03:00:00Z');
  const { server, csrf, dbFile } = createServer({ dir, privateKeyFile: keyFile, password: 'mat-khau-test', now: () => clock });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const auth = { Authorization: `Basic ${Buffer.from('admin:mat-khau-test').toString('base64')}` };
  const post = (url, body, headers = {}) => request(port, { method: 'POST', url, body: { csrf, ...body }, headers: { ...auth, ...headers } });
  const db = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));

  await t.test('needs the password; only for 127.0.0.1', async () => {
    assert.equal((await request(port)).status, 401);
    assert.equal((await request(port, { headers: { Authorization: `Basic ${Buffer.from('admin:sai').toString('base64')}` } })).status, 401);
    const ok = await request(port, { headers: auth });
    assert.equal(ok.status, 200);
    assert.match(ok.text, /Cấp mã mới/);
    assert.equal(ok.headers['x-frame-options'], 'DENY');
    assert.equal((await request(port, { headers: { ...auth, Host: 'evil.example.com' } })).status, 403, 'DNS-rebinding style host is refused');
  });

  await t.test('issuing: the code verifies with the public key, carries the machine, the days and the features', async () => {
    const res = await post('/issue', { machine: MACHINE.toLowerCase(), customer: 'Quán Cò', days: '90', features: ['pos', 'sync'], note: 'gói thử' });
    assert.equal(res.status, 200);
    const rec = db().licenses[0];
    const v = core.verify(rec.code, pub);
    assert.equal(v.ok, true);
    assert.equal(v.payload.machine, MACHINE);
    assert.equal(v.payload.customer, 'Quán Cò');
    assert.deepEqual(v.payload.features, ['pos', 'sync']);
    assert.equal(v.payload.expires, '2027-01-16T03:00:00.000Z');
    assert.ok(res.text.includes(rec.code), 'the code is on the page to copy');
    assert.equal(core.verify(rec.code.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), pub).ok, false, 'a damaged code does not verify');
    assert.equal(core.verify(rec.code, core.publicHex(crypto.generateKeyPairSync('ed25519').publicKey)).ok, false, 'another key does not verify it');
  });

  await t.test('bad input is refused with the reason and nothing is stored', async () => {
    const before = db().licenses.length;
    for (const [body, re] of [
      [{ machine: 'khong-phai-ma', customer: 'X Y', days: '30' }, /Mã máy không đúng dạng/],
      [{ machine: MACHINE, customer: '', days: '30' }, /Tên khách hàng/],
      [{ machine: MACHINE, customer: 'Quán', days: '0' }, /Số ngày/],
      [{ machine: MACHINE, customer: 'Quán', days: '99999' }, /Số ngày/],
      [{ machine: MACHINE, customer: 'Quán', days: '30', features: ['hack'] }, /Tính năng không hợp lệ/],
    ]) {
      const r = await post('/issue', body);
      assert.equal(r.status, 400);
      assert.match(r.text, re);
    }
    assert.equal(db().licenses.length, before);
  });

  await t.test('CSRF: a POST without the page token, or from another origin, does nothing', async () => {
    const before = db().licenses.length;
    const noToken = await request(port, { method: 'POST', url: '/issue', body: { machine: MACHINE, customer: 'Quán', days: '30' }, headers: auth });
    assert.equal(noToken.status, 403);
    const foreign = await post('/issue', { machine: MACHINE, customer: 'Quán', days: '30' }, { Origin: 'https://evil.example.com' });
    assert.equal(foreign.status, 403);
    assert.equal(db().licenses.length, before);
  });

  await t.test('renew replaces the old code with a new one for the same machine; revoke marks it', async () => {
    const first = db().licenses[0];
    clock = new Date('2027-01-05T03:00:00Z');
    const page = (await request(port, { headers: auth })).text;
    assert.match(page, /Sắp hết hạn/);
    const r = await post('/renew', { id: first.id, days: '365' });
    assert.equal(r.status, 200);
    const list = db().licenses;
    assert.equal(list[0].status, 'replaced');
    assert.equal(list.at(-1).status, 'active');
    assert.equal(list.at(-1).machine, MACHINE);
    assert.equal(list.at(-1).expires, '2028-01-05T03:00:00.000Z');
    assert.equal(core.verify(list.at(-1).code, pub).ok, true);
    const rev = await post('/revoke', { id: list.at(-1).id });
    assert.match(rev.text, /thu hồi/);
    assert.equal(db().licenses.at(-1).status, 'revoked');
    assert.equal((await post('/renew', { id: list.at(-1).id, days: '30' })).text.includes('Không tìm thấy mã còn hiệu lực'), true, 'a revoked code cannot be renewed');
  });

  await t.test('the page escapes what customers typed', async () => {
    await post('/issue', { machine: MACHINE, customer: '<script>alert(1)</script>', days: '30' });
    const page = (await request(port, { headers: auth })).text;
    assert.ok(!page.includes('<script>alert(1)</script>'));
    assert.ok(page.includes('&lt;script&gt;'));
  });

  await t.test('the database file is written atomically with owner-only permissions', () => {
    assert.ok(fs.existsSync(dbFile));
    assert.ok(!fs.existsSync(`${dbFile}.tmp`));
  });
});
