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

const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');

const TF = 'https://testflight.apple.com/join/AbCd1234';
const STORE = 'https://apps.apple.com/vn/app/pos-tasotek/id123456789';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('iOS app download', async (t) => {
  const fx = await start();
  const iosApp = require('../src/services/iosApp');
  const settingsModel = require('../src/models/settingsModel');
  t.after(() => { fx.stop(); fs.rmSync(releaseDir, { recursive: true, force: true }); });
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
    assert.match(html, /đang được phát hành thử nghiệm qua TestFlight/);
    assert.doesNotMatch(html, /id="ios-link"/);
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
    assert.doesNotMatch(html, /đang được phát hành thử nghiệm/);

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
