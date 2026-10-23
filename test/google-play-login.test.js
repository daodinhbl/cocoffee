/** Google Play card on the login page: QR + link to the app's Play page, only ever to play.google.com. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');
const googlePlay = require('../src/services/googlePlay');

test('only https play.google.com addresses are accepted', () => {
  assert.equal(googlePlay.safeUrl('https://play.google.com/apps/testing/com.tasotek.fnb'), 'https://play.google.com/apps/testing/com.tasotek.fnb');
  for (const bad of ['http://play.google.com/x', 'https://play.google.com.evil.test/x', 'https://evil.test/play.google.com', 'https://u:p@play.google.com/x', 'javascript:alert(1)', '', null]) {
    assert.equal(googlePlay.safeUrl(bad), null, String(bad));
  }
  assert.equal(googlePlay.url(), 'https://play.google.com/store/apps/details?id=com.tasotek.fnb');
});

test('login page shows the Google Play card and its QR code is served', async (t) => {
  const fx = await start();
  t.after(() => fx.stop());
  const html = await (await fx.client().get('/admin/login')).text();
  assert.match(html, /href="https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.tasotek\.fnb"/);
  assert.match(html, /\/download\/play\/qr\.svg/);
  assert.match(html, /Google Play/);
  assert.match(html, /người thử nghiệm/);
  const qr = await fetch(`${fx.base}/download/play/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);
  // the APKPure QR still works after the shared handler
  assert.equal((await fetch(`${fx.base}/download/apkpure/qr.svg`)).status, 200);
});
