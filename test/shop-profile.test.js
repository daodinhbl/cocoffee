const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/adminFixture');

test('shop / household-business profile', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const env = require('../src/config/env');
  const before = { ...env.business };
  t.after(() => Object.assign(env.business, before));
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);
  const save = (body) => admin.post('/admin/settings/shop', { _csrf: token, _back: '/admin/settings', name: 'Cò Coffee', ...body });
  const flash = async () => (await (await admin.get('/admin/settings')).text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  await t.test('the settings page has the form, with the tax-code pattern intact', async () => {
    const html = await (await admin.get('/admin/settings')).text();
    assert.match(html, /Thông tin cửa hàng \/ hộ kinh doanh/);
    for (const f of ['name', 'legalName', 'ownerName', 'taxCode', 'regNo', 'address', 'phone', 'email', 'businessLine', 'declarationPeriod']) assert.match(html, new RegExp(`name="${f}"`), f);
    assert.ok(html.includes('pattern="\\d{10}(-\\d{3})?"'));
  });

  await t.test('saved fields reach env.business and the printed bill', async () => {
    await save({ legalName: 'Hộ kinh doanh Nguyễn Văn A', ownerName: 'Nguyễn Văn A', taxCode: '0123456789-001', regNo: '01A8001234', address: '12 Đường Cò, Phường 1', phone: '0909 123 456', email: 'quan@example.com', businessLine: 'Dịch vụ ăn uống', declarationPeriod: 'month' });
    assert.equal(env.business.shopName, 'Cò Coffee');
    assert.equal(env.business.taxCode, '0123456789-001');
    assert.equal(env.business.declarationPeriod, 'month');
    assert.equal(env.business.address, '12 Đường Cò, Phường 1');
    const bill = await (await admin.get('/admin/pos/receipt/42')).text();
    assert.match(bill, /Hộ kinh doanh Nguyễn Văn A/);
    assert.match(bill, /12 Đường Cò, Phường 1/);
    assert.match(bill, /ĐT: 0909 123 456/);
    assert.match(bill, /MST: 0123456789-001/);
    const page = await (await admin.get('/admin/settings')).text();
    assert.match(page, /value="Nguyễn Văn A"/);
    assert.match(page, /MST 0123456789-001/);
  });

  await t.test('a printer-specific address still wins, a blank one follows the profile', async () => {
    await admin.post('/admin/settings/printer', { _csrf: token, _back: '/admin/settings', paperMm: '80', copies: '1', vatRate: '8', autoPrint: '1', showVat: '1', footer: '', shopAddress: 'Kiosk sân bay', shopPhone: '' });
    const bill = await (await admin.get('/admin/pos/receipt/42')).text();
    assert.match(bill, /Kiosk sân bay/);
    assert.match(bill, /ĐT: 0909 123 456/, 'blank phone: the profile one');
  });

  await t.test('validation: tax code, e-mail, name, lengths', async () => {
    await save({ taxCode: '12345' });
    assert.match(await flash(), /Mã số thuế gồm 10 chữ số/);
    await save({ email: 'khong-hop-le' });
    assert.match(await flash(), /Email không hợp lệ/);
    await save({ name: '' });
    assert.match(await flash(), /Tên cửa hàng không được để trống/);
    await save({ address: 'x'.repeat(201) });
    assert.match(await flash(), /Địa chỉ kinh doanh tối đa 200/);
    assert.equal(env.business.taxCode, '0123456789-001', 'a refused save changes nothing');
    await save({ taxCode: '' });
    assert.equal(env.business.taxCode, '', 'clearing is allowed');
  });
});
