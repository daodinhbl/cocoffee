const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start } = require('./helpers/adminFixture');

test('receipt logo: configured in Cài đặt, printed on the receipt', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const mediaModel = require('../src/models/mediaModel');
  const created = [];
  const removed = [];
  mock.method(mediaModel, 'create', async (m) => { created.push(m); return 5 + created.length - 1; });
  mock.method(mediaModel, 'remove', async (id) => { removed.push(id); });
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const form = { _csrf: token, _back: '/admin/settings', paperMm: '80', copies: '1', vatRate: '8', autoPrint: '1', showVat: '1', footer: '', logoSize: 'l' };

  await t.test('no logo by default: nothing printed', async () => {
    const html = await (await admin.get('/admin/pos/receipt/42')).text();
    assert.doesNotMatch(html, /class="logo"/);
  });

  await t.test('uploading a logo stores it and prints it above the shop name', async () => {
    await admin.post('/admin/settings/printer', { ...form, image_data: dataUrl });
    assert.equal(created.length, 1);
    assert.equal(created[0].folder, 'logo');
    const html = await (await admin.get('/admin/pos/receipt/42')).text();
    assert.match(html, /<img class="logo" src="\/media\/5-logo\.png"/);
    assert.match(html, /width: 44mm/, 'large size');
    assert.ok(html.indexOf('class="logo"') < html.indexOf('CÒ COFFEE'.toUpperCase()) || html.indexOf('class="logo"') < html.indexOf('class="shop"'), 'logo comes first');
    const page = await (await admin.get('/admin/settings')).text();
    assert.match(page, /Logo cửa hàng/);
    assert.match(page, /value="\/media\/5-logo\.png"/, 'the settings page shows the current logo');
  });

  await t.test('a new logo replaces the old one; keeping the form unchanged keeps it', async () => {
    await admin.post('/admin/settings/printer', form);                              // no image fields: unchanged
    assert.equal(removed.length, 0);
    await admin.post('/admin/settings/printer', { ...form, image_data: dataUrl });
    assert.deepEqual(removed, [5], 'the previous logo row is deleted');
    assert.match(await (await admin.get('/admin/pos/receipt/42')).text(), /\/media\/6-logo\.png/);
  });

  await t.test('WebP is refused, removal clears the logo', async () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(300, 1)]);
    await admin.post('/admin/settings/printer', { ...form, image_data: `data:image/webp;base64,${webp.toString('base64')}` });
    assert.equal(created.length, 2, 'nothing new was stored');
    await admin.post('/admin/settings/printer', { ...form, image_remove: '1' });
    assert.doesNotMatch(await (await admin.get('/admin/pos/receipt/42')).text(), /class="logo"/);
    assert.deepEqual(removed, [5, 6]);
  });

  await t.test('address, phone and Wi-Fi (name + password) are printed on the bill', async () => {
    await admin.post('/admin/settings/printer', { ...form, shopAddress: '12 Đường Cò, Phường 1', shopPhone: '0909 123 456', wifiName: 'CoCoffee', wifiPassword: 'cophe2026' });
    const html = await (await admin.get('/admin/pos/receipt/42')).text();
    assert.match(html, /12 Đường Cò, Phường 1/);
    assert.match(html, /ĐT: 0909 123 456/);
    assert.match(html, /Wi-Fi: <b>CoCoffee<\/b>/);
    assert.match(html, /Mật khẩu: <b>cophe2026<\/b>/);
    await admin.post('/admin/settings/printer', { ...form, shopAddress: '', shopPhone: '', wifiName: '', wifiPassword: 'x' });
    assert.doesNotMatch(await (await admin.get('/admin/pos/receipt/42')).text(), /Wi-Fi:/, 'no Wi-Fi name, nothing printed');
    const { c: settingsPage } = { c: admin };
    assert.match(await (await settingsPage.get('/admin/settings')).text(), /name="wifiPassword"/);
  });
});
