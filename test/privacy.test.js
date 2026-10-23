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
  // Google Play: the policy names the Play build and every permission / third party the app uses
  assert.match(html, /POS Tasotek/);
  assert.match(html, /OpenAI/);
  assert.match(html, /Bluetooth/);
  assert.match(html, /sinh trắc học/i);
  assert.match(html, /chỉ có ở bản Tasotek FnB tải trực tiếp/);
  assert.match(html, /href="mailto:[^"@]+@[^"]+"/);
});

test('GET /private: POS Tasotek privacy policy page is public with a contact email', async (t) => {
  const fx = await start();
  t.after(() => fx.stop());
  const res = await fetch(`${fx.base}/private`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Chính sách quyền riêng tư POS Tasotek/);
  assert.match(html, /com\.tasotek\.fnb/);
  assert.match(html, /Yêu cầu xóa dữ liệu POS Tasotek/);
  assert.match(html, /href="mailto:[^"@]+@[^"]+"/);
  assert.doesNotMatch(html, /điền email/);
  // Matches what the Play build really does: every third party and permission, the deletion page, nothing it doesn't do
  for (const word of [/OpenAI/, /Zalo/, /Micro/, /Sinh trắc học/, /Thông báo/, /Bluetooth/, /chứng từ/, /href="\/xoa-tai-khoan"/]) assert.match(html, word);
  assert.doesNotMatch(html, /mã vạch|Lưu trữ tệp|nhà cung cấp công cụ theo dõi lỗi/);
});
