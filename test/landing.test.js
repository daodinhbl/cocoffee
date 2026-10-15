/** GET /gioi-thieu: public product introduction page, reached from the "Xem thêm" button on the login page. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');

test('introduction page is public and lists the main features', async (t) => {
  const fx = await start();
  t.after(() => fx.stop());
  const res = await fetch(`${fx.base}/gioi-thieu`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Tính năng nổi bật/);
  assert.match(html, /Chatbot đặt món qua Zalo/);
  assert.match(html, /href="\/admin\/login"/);
});

test('login page links to the introduction page with a "Xem thêm" button', async (t) => {
  const fx = await start();
  t.after(() => fx.stop());
  const res = await fetch(`${fx.base}/admin/login`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /href="\/gioi-thieu"/);
  assert.match(html, /Xem thêm/);
});
