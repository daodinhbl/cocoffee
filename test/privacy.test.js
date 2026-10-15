/** GET /privacy: public privacy policy page (store listings ask for its URL). Real Express app, data layer faked. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');

test('privacy policy is public, in Vietnamese and covers the data the app handles', async (t) => {
  const fx = await start();
  t.after(() => fx.stop());
  const res = await fetch(`${fx.base}/privacy`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Chính sách quyền riêng tư/);
  assert.match(html, /Thông báo/);
  assert.match(html, /SHA-256/);
  assert.match(html, /số điện thoại/);
});
