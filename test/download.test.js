/**
 * /download (Android app landing page, APK, manifest, QR code) and the QR card on the login page, against the real
 * Express app with the data layer faked (helpers/adminFixture.js). The release directory is a temp dir. No MySQL.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-release-'));
process.env.APP_RELEASE_DIR = dir;                 // read once by services/appRelease.js when the app loads

const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');
const { publish, metaFromProject } = require('../scripts/publish-apk');

/** A fake Flutter project with just the files publish-apk.js falls back to when aapt is not used. */
function fakeMobile(root, version = '1.2.3+45') {
  fs.mkdirSync(path.join(root, 'android', 'app', 'src', 'main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), `name: cocoffee_mobile\nversion: ${version}\n`);
  fs.writeFileSync(path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest><application android:label="Tasotek FnB"/></manifest>');
  fs.writeFileSync(path.join(root, 'android', 'app', 'build.gradle.kts'), 'android {\n  defaultConfig {\n    applicationId = "com.tasotek.cocoffee_mobile"\n    minSdk = flutter.minSdkVersion\n  }\n}\n');
  return root;
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('Android app download', async (t) => {
  const fx = await start();
  const appRelease = require('../src/services/appRelease');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-apk-src-'));
  const mobile = fakeMobile(path.join(work, 'mobile'));
  t.after(() => { fx.stop(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); });
  const get = (p, headers = {}) => fetch(fx.base + p, { redirect: 'manual', headers });

  await t.test('nothing published yet: the page says so, APK and manifest are 404, the login page has no QR card', async () => {
    const page = await get('/download');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Chưa có bản cài đặt/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'nonce-/);
    assert.equal((await get('/download/manifest.json')).status, 404);
    assert.equal((await get('/download/cocoffee.apk')).status, 404);
    assert.equal((await get('/download/nope')).status, 404);
    assert.doesNotMatch(await (await fx.client().get('/admin/login')).text(), /download\/qr\.svg/);
    // the QR code exists regardless: it points at the landing page, not at the file
    const qr = await get('/download/qr.svg');
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /^image\/svg\+xml/);
    assert.match(await qr.text(), /^<svg/);
  });

  const bytes = crypto.randomBytes(3 * 1024 * 1024);
  const sha = sha256(bytes);
  const src = path.join(work, 'app-release.apk');
  fs.writeFileSync(src, bytes);

  await t.test('publish-apk.js: cocoffee-<version>-<code>.apk + manifest.json, one release at a time', async () => {
    assert.deepEqual(metaFromProject(mobile), { package: 'com.tasotek.cocoffee_mobile', version_code: 45, version_name: '1.2.3', min_sdk: 24, app_name: 'Tasotek FnB', source: 'pubspec.yaml' });
    const first = publish({ src, dir, mobileDir: fakeMobile(path.join(work, 'old'), '1.0.0+1'), aapt: false, now: new Date('2026-10-01T00:00:00Z') });
    assert.equal(first.file, 'cocoffee-1.0.0-1.apk');
    const m = publish({ src, dir, mobileDir: mobile, aapt: false, now: new Date('2026-10-14T03:00:00Z') });
    assert.deepEqual(m, {
      file: 'cocoffee-1.2.3-45.apk', app_name: 'Tasotek FnB', package: 'com.tasotek.cocoffee_mobile', version_name: '1.2.3', version_code: 45,
      min_sdk: 24, size: bytes.length, sha256: sha, built_at: '2026-10-14T03:00:00.000Z', metadata_source: 'pubspec.yaml',
    });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['cocoffee-1.2.3-45.apk', 'manifest.json'], 'the previous APK is gone');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), m);
    assert.throws(() => publish({ src: path.join(work, 'missing.apk'), dir, mobileDir: mobile, aapt: false }), /APK not found/);
  });

  await t.test('with a release: landing page, APK headers and bytes, Range/HEAD, manifest, QR card on the login page', async () => {
    appRelease.invalidate();
    const page = await (await get('/download')).text();
    assert.match(page, /1\.2\.3/);
    assert.match(page, /3,0 MB/);
    assert.match(page, /Android 7\.0 trở lên/);
    assert.match(page, /href="\/download\/cocoffee\.apk\?v=[0-9a-f]{12}"/);
    assert.match(page, /https:\/\/cafe\.example\.test\/download/, 'PUBLIC_BASE_URL wins over the Host header');
    assert.match(page, /Tasotek-FnB-1\.2\.3\.apk/);

    const apk = await get('/download/cocoffee.apk?v=abc');
    assert.equal(apk.status, 200);
    assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(apk.headers.get("content-disposition"), /^attachment; filename="?Tasotek-FnB-1.2.3.apk"?$/);
    assert.equal(Number(apk.headers.get('content-length')), bytes.length);
    assert.equal(apk.headers.get('cache-control'), 'no-cache');
    assert.equal(apk.headers.get('x-checksum-sha256'), sha);
    assert.ok(apk.headers.get('etag'));
    assert.equal(sha256(Buffer.from(await apk.arrayBuffer())), sha, 'the bytes are the published file');

    const head = await fetch(`${fx.base}/download/cocoffee.apk`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), bytes.length);
    const range = await get('/download/cocoffee.apk', { Range: 'bytes=0-9' });
    assert.equal(range.status, 206, 'download managers resume with Range');
    assert.equal((await range.arrayBuffer()).byteLength, 10);

    const res = await get('/download/manifest.json');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      app_name: 'Tasotek FnB', package: 'com.tasotek.cocoffee_mobile', version_name: '1.2.3', version_code: 45, min_sdk: 24,
      size: bytes.length, sha256: sha, built_at: '2026-10-14T03:00:00.000Z', file: 'Tasotek-FnB-1.2.3.apk',
      url: 'https://cafe.example.test/download/cocoffee.apk', page: 'https://cafe.example.test/download',
    });

    const login = await (await fx.client().get('/admin/login')).text();
    assert.match(login, /src="\/download\/qr\.svg"/);
    assert.match(login, /Tasotek FnB <span[^>]*>v1\.2\.3</);
    assert.match(login, /3,0 MB/);
    assert.match(login, /href="\/download"/);
    assert.doesNotMatch(login, /\son[a-z]+="/i, 'no inline handlers (CSP)');
  });

  await t.test('the file wins over its manifest: wrong size -> checksum recomputed; path in `file` ignored; no/garbage manifest -> version from the file name', async () => {
    const mPath = path.join(dir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    fs.writeFileSync(mPath, JSON.stringify({ ...m, size: m.size + 1, sha256: 'f'.repeat(64) }));
    appRelease.invalidate();
    assert.equal(appRelease.current().sha256, sha);
    assert.equal(appRelease.current().size, bytes.length);

    fs.writeFileSync(mPath, JSON.stringify({ ...m, file: '../../etc/passwd' }));
    appRelease.invalidate();
    assert.equal(appRelease.current().file, m.file);
    assert.equal(appRelease.current().app_name, 'Tasotek FnB');

    fs.rmSync(mPath);
    fs.renameSync(path.join(dir, m.file), path.join(dir, 'cocoffee-2.0.0-7.apk'));
    appRelease.invalidate();
    const r = appRelease.current();
    assert.equal(r.version_name, '2.0.0');
    assert.equal(r.version_code, 7);
    assert.equal(r.sha256, sha);
    assert.equal(appRelease.downloadName(r), 'Tasotek-FnB-2.0.0.apk');

    fs.writeFileSync(mPath, '{not json');
    appRelease.invalidate();
    assert.equal(appRelease.current().version_name, '2.0.0');
    assert.equal((await get('/download/manifest.json')).status, 200);
  });

  await t.test('QR code is rendered once per URL; the Host header is ignored while PUBLIC_BASE_URL is set', async () => {
    const a = await (await get('/download/qr.svg')).text();
    const b = await (await get('/download/qr.svg')).text();
    assert.equal(a, b);
    assert.equal(appRelease.baseUrl({ get: () => 'evil.example', protocol: 'http' }), 'https://cafe.example.test');
    assert.equal(appRelease.sizeLabel(61416895), '59 MB');
    assert.equal(appRelease.sizeLabel(4.2 * 1024 * 1024), '4,2 MB');
    assert.equal(appRelease.androidLabel(26), 'Android 8.0 trở lên');
  });
});
