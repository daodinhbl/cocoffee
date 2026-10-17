/** /ky-thuat: public QR landing page + lead capture. Real Express app, data layer faked. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start } = require('./helpers/adminFixture');

test('GET /ky-thuat is public and shows the request form; the sign and QR render', async (t) => {
  const fx = await start();
  t.after(() => fx.stop());
  const page = await fetch(`${fx.base}/ky-thuat?src=ban-3`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Kiểm tra điện nước miễn phí/);
  assert.match(html, /name="src" value="ban-3"/);
  const qr = await fetch(`${fx.base}/ky-thuat/qr.svg?src=ban-3`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  const sign = await fetch(`${fx.base}/ky-thuat/bang-ban?src=ban-3`);
  assert.equal(sign.status, 200);
  assert.match(await sign.text(), /Bàn tư vấn/);
});

test('POST /ky-thuat/lead validates, saves once per phone and rejects bots quietly', async (t) => {
  const fx = await start();
  t.after(() => fx.stop());
  const leadModel = require('../src/models/leadModel');
  const created = [];
  mock.method(leadModel, 'recentByPhone', async (p) => (created.some((c) => c.phone === p) ? { id: 1 } : null));
  mock.method(leadModel, 'create', async (row) => { created.push(row); return created.length; });
  const post = (body) => fetch(`${fx.base}/ky-thuat/lead`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
  });

  const bad = await post({ name: 'An', phone: '123' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /số điện thoại hợp lệ/);
  assert.equal(created.length, 0);

  const ok = await post({ name: 'Nguyễn An', phone: '+84 912 345 678', need: 'camera', src: 'ban-3', note: 'Lắp 4 mắt' });
  assert.equal(ok.status, 303);
  assert.deepEqual(created[0], { name: 'Nguyễn An', phone: '0912345678', need: 'Camera an ninh', source: 'ban-3', note: 'Lắp 4 mắt' });

  await post({ name: 'Nguyễn An', phone: '0912345678', need: 'camera' });          // double tap
  assert.equal(created.length, 1);

  const bot = await post({ name: 'x', phone: '0912345679', website: 'http://spam' });
  assert.equal(bot.status, 303);
  assert.equal(created.length, 1);

  const evil = await post({ name: 'B', phone: '0912345670', src: '"><b>' });   // bad source falls back to "qr"
  assert.equal(evil.status, 303);
  assert.equal(created[1].source, 'qr');
});
