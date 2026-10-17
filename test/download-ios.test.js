/**
 * /download/ios (iPhone/iPad landing page + QR code) and the iOS row of the app card on the login page. The link
 * comes from app_settings "ios.app_url" (Web Admin > Cài đặt > Ứng dụng iOS). Real Express app, faked data layer
 * (helpers/adminFixture.js), no MySQL.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.IOS_APP_URL = '';   // a developer .env must not leak into the "nothing configured" case
const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ios-release-'));
process.env.APP_RELEASE_DIR = releaseDir;   // no Android APK here, whatever releases/android/ holds on this machine
const iosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ios-ipa-'));
process.env.IOS_RELEASE_DIR = iosDir;        // no ad-hoc .ipa until the subtest that publishes one

const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');
const { publish: publishIpa } = require('../scripts/publish-ipa');
const crypto = require('node:crypto');

const TF = 'https://testflight.apple.com/join/AbCd1234';
const STORE = 'https://apps.apple.com/vn/app/pos-tasotek/id123456789';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('iOS app download', async (t) => {
  const fx = await start();
  const iosApp = require('../src/services/iosApp');
  const settingsModel = require('../src/models/settingsModel');
  t.after(() => { fx.stop(); for (const d of [releaseDir, iosDir]) fs.rmSync(d, { recursive: true, force: true }); });
  const get = (p) => fetch(fx.base + p, { redirect: 'manual' });
  const text = async (p) => (await get(p)).text();
  const loginPage = async () => (await fx.client().get('/admin/login')).text();
  const saves = () => fx.calls.filter((c) => c.name === 'settings.setMany');

  await t.test('classify: only https links on Apple TestFlight / App Store hosts', () => {
    assert.deepEqual(iosApp.classify(` ${TF} `), { kind: 'testflight', label: 'TestFlight', action: 'Mở trong TestFlight', url: TF });
    assert.equal(iosApp.classify(STORE).kind, 'appstore');
    assert.equal(iosApp.classify('https://beta.itunes.apple.com/v1/app/123').kind, 'testflight');
    assert.equal(iosApp.classify('https://TESTFLIGHT.apple.com/join/x').kind, 'testflight');
    const bad = ['', null, 42, 'not a url', 'http://testflight.apple.com/join/x', 'https://evil.example/testflight.apple.com/join/x',
      'https://testflight.apple.com.evil.example/join/x', 'itms-services://?action=download-manifest', 'https://user:pw@apps.apple.com/x',
      'javascript:alert(1)', `https://apps.apple.com/${'a'.repeat(300)}`,
      `https://apps.apple.com/${'ă'.repeat(60)}`];   // 84 chars typed, but the stored (percent-encoded) href would be 383: refused up front, not dropped later
    for (const v of bad) assert.equal(iosApp.classify(v), null, String(v));
    assert.equal(iosApp.classify(`https://apps.apple.com/${'a'.repeat(277)}`).url.length, 300, 'exactly at the cap is accepted');
    assert.equal(iosApp.classify(`https://apps.apple.com/${'a'.repeat(278)}`), null, 'one over the cap is refused');
  });

  await t.test('the login page still renders from the admin error handler (rate-limited POST): no app-card local is required', async () => {
    const c = fx.client();
    let res;
    for (let i = 0; i < 9; i++) res = await c.post('/admin/login', { username: 'nobody-here', password: 'wrong-password' });   // 8 tries per account, then 429
    assert.equal(res.status, 429);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const html = await res.text();
    assert.match(html, /Thử đăng nhập quá nhiều lần/);
    assert.match(html, /iPhone \/ iPad · POS Tasotek <span[^>]*>sắp có</, 'the iOS row falls back to its defaults');
    assert.doesNotMatch(html, /src="\/download\/qr\.svg"/);
  });

  await t.test('nothing configured: the page says the build is coming, the QR code works, the login page shows the iOS row as "sắp có"', async () => {
    const page = await get('/download/ios');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /POS Tasotek/);
    assert.match(html, /id="ios-install-pending"[^>]*aria-disabled="true"/, 'the install button is there, inactive');
    assert.match(html, /id="ios-download-pending"[^>]*aria-disabled="true"/, 'the download button is there, inactive');
    assert.match(html, /đang được chuẩn bị/);
    assert.doesNotMatch(html, /id="ios-link"|id="ios-install"|id="ios-download"/);
    assert.match(html, /https:\/\/cafe\.example\.test\/download\/ios/, 'PUBLIC_BASE_URL wins over the Host header');
    assert.match(html, /src="\/download\/ios\/qr\.svg"/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'nonce-/);
    assert.doesNotMatch(html, /\son[a-z]+="/i, 'no inline handlers (CSP)');

    const qr = await get('/download/ios/qr.svg');
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /^image\/svg\+xml/);
    assert.match(await qr.text(), /^<svg/);
    assert.notEqual(await (await get('/download/ios/qr.svg')).text(), await (await get('/download/qr.svg')).text(), 'a different page, a different code');
    assert.equal((await get('/download/ios/nope')).status, 404);

    const login = await loginPage();
    assert.match(login, /src="\/download\/ios\/qr\.svg"/);
    assert.match(login, /href="\/download\/ios"/);
    assert.match(login, /iPhone \/ iPad · POS Tasotek <span[^>]*>sắp có</);
    assert.doesNotMatch(login, /src="\/download\/qr\.svg"/, 'no Android APK published in this test: no Android row');
  });

  await t.test('settings: a bad link is refused, a TestFlight link is stored and used by the page and the login card', async () => {
    const { c: admin } = await fx.login('boss');
    const token = await fx.csrfOf(admin, '/admin/settings');
    const before = saves().length;

    const bad = await admin.post('/admin/settings/ios-app', { _csrf: token, _back: '/admin/settings', url: 'https://example.com/app.ipa' });
    assert.equal(bad.status, 303);
    assert.equal(saves().length, before, 'nothing stored');
    assert.match(await (await admin.get('/admin/settings')).text(), /Liên kết phải là địa chỉ https của TestFlight/);

    const ok = await admin.post('/admin/settings/ios-app', { _csrf: token, _back: '/admin/settings', url: ` ${TF} ` });
    assert.equal(ok.headers.get('location'), '/admin/settings');
    assert.deepEqual(saves().at(-1).args[0], { 'ios.app_url': TF });
    const settings = await (await admin.get('/admin/settings')).text();
    assert.match(settings, /Đã lưu liên kết tải ứng dụng iOS \(TestFlight\)/);
    assert.match(settings, /Ứng dụng iOS \(iPhone \/ iPad\)/);
    assert.match(settings, new RegExp(`value="${escapeRe(TF)}"`));

    const html = await text('/download/ios');
    assert.match(html, new RegExp(`id="ios-link" href="${escapeRe(TF)}"`));
    assert.match(html, /Mở trong TestFlight/);
    assert.match(html, /apps\.apple\.com\/app\/testflight\/id899247664/, 'step 1 installs TestFlight');
    assert.match(html, /iOS 15\.0 trở lên/);
    assert.match(html, /cafe\.example\.test/);
    assert.doesNotMatch(html, /đang được chuẩn bị|ios-install-pending/);

    const login = await loginPage();
    assert.match(login, /iPhone \/ iPad · POS Tasotek <span[^>]*>TestFlight</);
    assert.doesNotMatch(login, /sắp có/);
    assert.doesNotMatch(login, /\son[a-z]+="/i);
  });

  await t.test('an App Store link changes the wording; clearing the field puts the page back to "coming soon"', async () => {
    const { c: admin } = await fx.login('boss');
    const token = await fx.csrfOf(admin, '/admin/settings');
    await admin.post('/admin/settings/ios-app', { _csrf: token, _back: '/admin/settings', url: STORE });
    const store = await text('/download/ios');
    assert.match(store, /Tải trên App Store/);
    assert.match(store, /Bản chính thức trên App Store/);
    assert.doesNotMatch(store, /id899247664/);
    assert.match(await loginPage(), /<span[^>]*>App Store</);

    await admin.post('/admin/settings/ios-app', { _csrf: token, _back: '/admin/settings', url: '' });
    assert.deepEqual(saves().at(-1).args[0], { 'ios.app_url': '' });
    assert.match(await (await admin.get('/admin/settings')).text(), /Đã bỏ liên kết tải ứng dụng iOS/);
    assert.doesNotMatch(await text('/download/ios'), /id="ios-link"/);
    assert.match(await loginPage(), /sắp có/);
  });

  await t.test('an ad-hoc build published with publish-ipa.js: direct install on the page, manifest.plist, app.ipa, login row', async () => {
    const iosRelease = require('../src/services/iosRelease');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ipa-src-'));
    const bytes = crypto.randomBytes(2 * 1024 * 1024);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(work, 'POS-Tasotek-1.4.0-12.ipa'), bytes);
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ file: 'POS-Tasotek-1.4.0-12.ipa', app_name: 'POS Tasotek', bundle_id: 'com.tasotek.fnb', version_name: '1.4.0', version_code: 12, min_ios: '15.0', size: bytes.length, sha256: sha, built_at: '2026-10-20T03:00:00Z', method: 'release-testing' }));
    assert.throws(() => publishIpa({ src: path.join(work, 'nope'), dir: iosDir }), /Build not found/);
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ file: 'POS-Tasotek-1.4.0-12.ipa', size: bytes.length + 1 }));
    assert.throws(() => publishIpa({ src: work, dir: iosDir }), /incomplete/);
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ file: 'POS-Tasotek-1.4.0-12.ipa', app_name: 'POS Tasotek', bundle_id: 'com.tasotek.fnb', version_name: '1.4.0', version_code: 12, min_ios: '15.0', size: bytes.length, sha256: sha, built_at: '2026-10-20T03:00:00Z', method: 'release-testing' }));
    const m = publishIpa({ src: work, dir: iosDir });
    assert.deepEqual(m, { file: 'POS-Tasotek-1.4.0-12.ipa', app_name: 'POS Tasotek', bundle_id: 'com.tasotek.fnb', version_name: '1.4.0', version_code: 12, min_ios: '15.0', size: bytes.length, sha256: sha, built_at: '2026-10-20T03:00:00.000Z', method: 'release-testing' });
    assert.deepEqual(fs.readdirSync(iosDir).sort(), ['POS-Tasotek-1.4.0-12.ipa', 'manifest.json']);
    iosRelease.invalidate();
    assert.deepEqual(iosRelease.loginCard(), { version_name: '1.4.0', version_code: 12, sizeLabel: '2,0 MB' });
    try {
    const page = await text('/download/ios');
    assert.match(page, /id="ios-install" href="itms-services:\/\/\?action=download-manifest&amp;url=https%3A%2F%2Fcafe\.example\.test%2Fdownload%2Fios%2Fmanifest\.plist"/);
    assert.match(page, /Cài đặt trực tiếp · 2,0 MB/);
    assert.ok(page.includes(`id="ios-download" href="/download/ios/app.ipa?v=${sha.slice(0, 12)}" download="POS-Tasotek-1.4.0.ipa"`), 'the .ipa download button');
    assert.match(page, /Tải tệp \.ipa · 2,0 MB/);
    assert.doesNotMatch(page, /ios-install-pending/);
    assert.match(page, /bằng <b>Safari<\/b>/);
    assert.match(page, /POS-Tasotek-1\.4\.0\.ipa/);
    assert.doesNotMatch(page, /id="ios-link"/, 'no TestFlight link set: no alternative section');

    const plist = await get('/download/ios/manifest.plist');
    assert.equal(plist.status, 200);
    assert.match(plist.headers.get('content-type'), /^application\/xml/);
    const xml = await plist.text();
    assert.match(xml, /<key>bundle-identifier<\/key><string>com\.tasotek\.fnb<\/string>/);
    assert.match(xml, /<key>bundle-version<\/key><string>1\.4\.0<\/string>/);
    assert.ok(xml.includes(`<string>https://cafe.example.test/download/ios/app.ipa?v=${sha.slice(0, 12)}</string>`), 'the .ipa URL carries the checksum prefix');
    assert.match(xml, /<string>https:\/\/cafe\.example\.test\/brand\/apple-touch-icon\.png<\/string>/);

    const info = await get('/download/ios/manifest.json');
    assert.equal(info.status, 200);
    assert.equal(info.headers.get('cache-control'), 'no-cache');
    const infoJson = await info.json();
    assert.equal(infoJson.version_name, '1.4.0');
    assert.equal(infoJson.bundle_id, 'com.tasotek.fnb');
    assert.equal(infoJson.size, 2 * 1024 * 1024);
    assert.equal(infoJson.install_url, 'itms-services://?action=download-manifest&url=https%3A%2F%2Fcafe.example.test%2Fdownload%2Fios%2Fmanifest.plist');

    const ipa = await get('/download/ios/app.ipa?v=abc');
    assert.equal(ipa.status, 200);
    assert.equal(ipa.headers.get('content-type'), 'application/octet-stream');
    assert.match(ipa.headers.get('content-disposition'), /^attachment; filename="?POS-Tasotek-1\.4\.0\.ipa"?$/);
    assert.equal(ipa.headers.get('x-checksum-sha256'), sha);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await ipa.arrayBuffer())).digest('hex'), sha);
    assert.equal((await fetch(`${fx.base}/download/ios/app.ipa`, { method: 'HEAD' })).status, 200);

    assert.match(await loginPage(), /iPhone \/ iPad · POS Tasotek <span[^>]*>v1\.4\.0 nội bộ</);

    // a TestFlight link on top: the page keeps direct install first and offers the link to unregistered devices
    const { c: admin } = await fx.login('boss');
    const token = await fx.csrfOf(admin, '/admin/settings');
    await admin.post('/admin/settings/ios-app', { _csrf: token, _back: '/admin/settings', url: TF });
    const both = await text('/download/ios');
    assert.match(both, /id="ios-install"/);
    assert.match(both, /Máy chưa đăng ký\?/);
    assert.match(both, new RegExp(`id="ios-link" href="${escapeRe(TF)}"`));
    assert.match(await loginPage(), /hoặc cài qua TestFlight/);
    await admin.post('/admin/settings/ios-app', { _csrf: token, _back: '/admin/settings', url: '' });

    } finally {
      // unpublished again, even after a failed assertion: later subtests expect no iOS build
      for (const f of fs.readdirSync(iosDir)) fs.rmSync(path.join(iosDir, f));
      fs.rmSync(work, { recursive: true, force: true });
      iosRelease.invalidate();
    }
    assert.equal((await get('/download/ios/manifest.plist')).status, 404);
    assert.equal((await get('/download/ios/manifest.json')).status, 404);
    assert.equal((await get('/download/ios/app.ipa')).status, 404);
    assert.match(await loginPage(), /sắp có/);
  });

  await t.test('the link is cached for a minute and a failing app_settings table does not break the login page', async () => {
    const { c: admin } = await fx.login('boss');
    const token = await fx.csrfOf(admin, '/admin/settings');
    await admin.post('/admin/settings/ios-app', { _csrf: token, _back: '/admin/settings', url: TF });
    const n0 = settingsModel.getByPrefix.mock.callCount();
    await loginPage(); await loginPage(); await text('/download/ios');
    assert.equal(settingsModel.getByPrefix.mock.callCount() - n0, 1, 'one query serves the next minute of login pages');

    const original = settingsModel.getByPrefix;
    settingsModel.getByPrefix = async () => { throw new Error('db down'); };
    try {
      assert.equal((await iosApp.get()).url, TF, 'the cached value survives an outage');
      iosApp.invalidate();
      assert.equal(await iosApp.get(), null, 'no cache, no env fallback: nothing to show, no crash');
      const login = await fx.client().get('/admin/login');
      assert.equal(login.status, 200);
      assert.match(await login.text(), /sắp có/);
    } finally {
      settingsModel.getByPrefix = original;
      iosApp.invalidate();
    }
  });
});
