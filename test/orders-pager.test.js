const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');

test('/admin/orders pages of 20', async (t) => {
  const fx = await start();               // the fixture reports 60 orders in total
  t.after(fx.stop);
  const { c: admin } = await fx.login();
  const text = async (url) => (await admin.get(url)).text();
  const flat = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  let html = flat(await text('/admin/orders'));
  assert.match(html, /Hiển thị 1–20 trong 60 đơn/);
  assert.match(html, /20 đơn\/trang/);
  assert.match(html, /Trang 1 \/ 3/);

  html = await text('/admin/orders?page=2');
  assert.match(flat(html), /Hiển thị 21–40 trong 60 đơn/);
  assert.match(flat(html), /Trang 2 \/ 3/);
  assert.match(html, /href="\/admin\/orders"[^>]*aria-label="Trang đầu"|aria-label="Trang đầu"/);
  assert.match(html, /href="\/admin\/orders\?page=3"[^>]*aria-label="Trang cuối"|aria-label="Trang cuối"/);

  html = flat(await text('/admin/orders?page=3'));
  assert.match(html, /Hiển thị 41–60 trong 60 đơn/);
  html = flat(await text('/admin/orders?page=99'));
  assert.match(html, /Trang 3 \/ 3/, 'a page past the end shows the last one');

  const filtered = await text('/admin/orders?status=completed&page=2');
  assert.match(filtered, /status=completed&amp;page=3|status=completed&page=3/, 'page links keep the filters');
});
