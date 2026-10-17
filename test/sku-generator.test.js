const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const sku = require('../src/services/skuGenerator');
const { start } = require('./helpers/adminFixture');

test('SKU generator', async (t) => {
  await t.test('slug: capitals, no accents, word-boundary cut', () => {
    assert.equal(sku.slug('Đường cát trắng'), 'DUONG-CAT-TRANG');
    assert.equal(sku.slug('  Cà phê (rang xay) 500g!! '), 'CA-PHE-RANG-XAY-500G');
    assert.equal(sku.slug('***'), '');
    const long = sku.slug('Nước ép trái cây nguyên chất không đường loại đặc biệt');
    assert.ok(long.length <= 22 && !long.endsWith('-'), long);
  });

  await t.test('generate: first free code, -2, -3, then a random suffix', async () => {
    const taken = new Set();
    const exists = async (s) => taken.has(s);
    assert.equal(await sku.generate({ prefix: 'RM', name: 'Đường cát', exists }), 'RM-DUONG-CAT');
    taken.add('RM-DUONG-CAT');
    assert.equal(await sku.generate({ prefix: 'RM', name: 'Đường cát', exists }), 'RM-DUONG-CAT-2');
    taken.add('RM-DUONG-CAT-2');
    assert.equal(await sku.generate({ prefix: 'RM', name: 'Đường cát', exists }), 'RM-DUONG-CAT-3');
    assert.equal(await sku.generate({ prefix: 'GD', name: '???', exists }), 'GD-MOI', 'a name with no usable letters');
    const all = async () => true;
    assert.match(await sku.generate({ prefix: 'RM', name: 'Muối', exists: all }), /^RM-MUOI-[0-9A-F]{4}$/);
    assert.ok((await sku.generate({ prefix: 'RM', name: 'x'.repeat(60), exists })).length <= 40);
  });

  await t.test('forms: an empty SKU box is filled in on create, a typed one is kept', async (t2) => {
    const fx = await start();
    t2.after(fx.stop);
    const inventoryModel = require('../src/models/inventoryModel');
    const productModel = require('../src/models/productModel');
    const taken = new Set(['RM-DUONG-CAT']);
    mock.method(inventoryModel, 'skuExists', async (s) => taken.has(s));
    mock.method(productModel, 'skuExists', async () => false);
    const { c: admin } = await fx.login();
    const token = await fx.csrfOf(admin);
    const called = (n) => fx.calls.filter((c) => c.name === n);
    const post = (url, body) => admin.post(url, { _csrf: token, _back: '/admin/inventory', ...body });

    await post('/admin/inventory', { name: 'Đường cát', sku: '', unit: 'g', quantity_on_hand: '0' });
    assert.equal(called('inventory.create').at(-1).args[0].sku, 'RM-DUONG-CAT-2', 'RM- by default, -2 because RM-DUONG-CAT exists');
    await post('/admin/inventory', { name: 'Ống hút lớn', sku: '', unit: 'pcs', quantity_on_hand: '0' });
    assert.equal(called('inventory.create').at(-1).args[0].sku, 'PK-ONG-HUT-LON', 'packaging is recognised from the name');
    await post('/admin/inventory', { name: 'Nước Lavie', sku: '', unit: 'bottle', group_code: 'retail', quantity_on_hand: '0' });
    assert.equal(called('inventory.create').at(-1).args[0].sku, 'GD-NUOC-LAVIE', 'the chosen group sets the prefix');
    await post('/admin/inventory', { name: 'Đường cát', sku: 'DUONG', unit: 'g', quantity_on_hand: '0' });
    assert.equal(called('inventory.create').at(-1).args[0].sku, 'DUONG', 'a typed SKU is kept as typed');

    await admin.post('/admin/menu/products', { _csrf: token, _back: '/admin/menu', name: 'Thuốc lá Jet', sku: '', price: '30000', category_id: '2', inventory_item_id: '1' });
    assert.equal(called('product.create').at(-1).args[0].sku, 'GD-THUOC-LA-JET');
  });
});
