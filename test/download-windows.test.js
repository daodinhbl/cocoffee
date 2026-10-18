/** Windows installer: the login page card and /download/windows/<file> (real Express app, faked data layer). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-win-release-'));
process.env.WINDOWS_RELEASE_DIR = dir;
process.env.APP_RELEASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-win-apk-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { start } = require('./helpers/adminFixture');

test('Windows installer download', async (t) => {
  const fx = await start();
  t.after(() => { fx.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const login = async () => (await fx.client().get('/admin/login')).text();

  await t.test('no installer: no card, the file URL is 404', async () => {
    assert.ok(!(await login()).includes('Tải bản cài Windows'));
    assert.equal((await fetch(`${fx.base}/download/windows/POS-Tasotek-Server-Setup-1.0.0.exe`)).status, 404);
  });

  await t.test('with an installer: card shows version and size, download is the file with its SHA-256', async () => {
    const body = crypto.randomBytes(3 * 1048576);
    fs.writeFileSync(path.join(dir, 'POS-Tasotek-Server-Setup-1.0.0.exe'), body);
    fs.writeFileSync(path.join(dir, 'POS-Tasotek-Server-Setup-1.2.0.exe'), body);
    fs.writeFileSync(path.join(dir, 'other.exe'), 'x');
    const page = await login();
    assert.ok(page.includes('Tải bản cài Windows'));
    assert.ok(page.includes('/download/windows/POS-Tasotek-Server-Setup-1.2.0.exe?v='), 'the newest version wins');
    assert.match(page, /Phiên bản 1\.2\.0, 3 MB/);
    const r = await fetch(`${fx.base}/download/windows/POS-Tasotek-Server-Setup-1.2.0.exe`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-checksum-sha256'), crypto.createHash('sha256').update(body).digest('hex'));
    assert.equal(Buffer.compare(Buffer.from(await r.arrayBuffer()), body), 0);
    assert.equal((await fetch(`${fx.base}/download/windows/POS-Tasotek-Server-Setup-1.0.0.exe`)).status, 404, 'only the published file is served');
    assert.equal((await fetch(`${fx.base}/download/windows/other.exe`)).status, 404);
    assert.equal((await fetch(`${fx.base}/download/windows/..%2Fother.exe`)).status, 404);
  });
});
