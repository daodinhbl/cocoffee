/** APKPure card on the login page: QR + link to the app's APKPure page, only ever to apkpure.com. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');
const apkpure = require('../src/services/apkpure');

test('only https apkpure.com addresses are accepted', () => {
  assert.equal(apkpure.safeUrl('https://apkpure.com/p/com.tasotek.fnb'), 'https://apkpure.com/p/com.tasotek.fnb');
  assert.equal(apkpure.safeUrl('https://www.apkpure.com/x'), 'https://www.apkpure.com/x');
  for (const bad of ['http://apkpure.com/x', 'https://apkpure.com.evil.test/x', 'https://evil.test/apkpure.com', 'https://u:p@apkpure.com/x', 'javascript:alert(1)', '', null]) {
    assert.equal(apkpure.safeUrl(bad), null, String(bad));
  }
  assert.equal(apkpure.url(), apkpure.DEFAULT_URL);
});

test('login page shows the APKPure card and its QR code is served', async (t) => {
  const fx = await start();
  t.after(() => fx.stop());
  const html = await (await fx.client().get('/admin/login')).text();
  assert.match(html, /href="https:\/\/apkpure\.com\/p\/com\.tasotek\.fnb"/);
  assert.match(html, /\/download\/apkpure\/qr\.svg/);
  assert.match(html, /\/brand\/app-icon\.png/);
  assert.match(html, /APKPure/);
  assert.match(html, /rel="noopener noreferrer"/);
  const qr = await fetch(`${fx.base}/download/apkpure/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);
  const icon = await fetch(`${fx.base}/brand/app-icon.png`);
  assert.equal(icon.status, 200);
});
