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

test('introduction page shows screenshots and the contact block only when contact details are configured', async (t) => {
  const env = require('../src/config/env');
  const saved = { ...env.contact };
  t.after(() => Object.assign(env.contact, saved));
  const fx = await start();
  t.after(() => fx.stop());

  Object.assign(env.contact, { name: '', phone: '', email: '', zalo: '', address: '', hours: '' });
  let html = await (await fetch(`${fx.base}/gioi-thieu`)).text();
  assert.match(html, /Hình ảnh hệ thống/);
  assert.match(html, /src="\/landing\/pos\.jpg"/);
  assert.doesNotMatch(html, /id="lien-he"/);

  Object.assign(env.contact, { phone: '0901 234 567', email: 'hello@example.com', zalo: '0901234567' });
  html = await (await fetch(`${fx.base}/gioi-thieu`)).text();
  assert.match(html, /id="lien-he"/);
  assert.match(html, /href="tel:0901234567"/);
  assert.match(html, /href="mailto:hello@example\.com"/);
});
