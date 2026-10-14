/**
 * Photos uploaded in the Web Admin: validated, stored in MySQL (media_files) and served from /media.
 * No MySQL: the models are faked (helpers/adminFixture.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./helpers/adminFixture');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
const dataUrl = (buf, type = 'jpeg') => `data:image/${type};base64,${buf.toString('base64')}`;

test('admin photo uploads', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const called = (name) => fx.calls.filter((c) => c.name === name);
  const reset = () => { fx.calls.length = 0; };
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);
  const imageStore = require('../src/services/imageStore');

  await t.test('a new ingredient photo is stored in the database, linked, and the replaced one is deleted', async () => {
    reset();
    const res = await admin.post('/admin/inventory/3', { _csrf: token, _back: '/admin/inventory', name: 'Ly nhựa + nắp', unit: 'pcs', min_stock: '50', is_active: '1', image_data: dataUrl(JPEG) });
    assert.equal(res.status, 303);
    const [create] = called('media.create');
    assert.equal(create.args[0].folder, 'ingredients');
    assert.equal(create.args[0].mime, 'image/jpeg');
    const [set] = called('inventory.setImage');
    assert.equal(set.args[0], 3);
    assert.match(set.args[1], /^\/media\/\d+-ly-nhua-nap\.jpg$/);
    assert.deepEqual(called('media.remove').map((c) => c.args[0]), [900], 'the previous /media photo of item 3');

    const img = await fx.client().get(set.args[1]);   // public, like any menu photo
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.match(img.headers.get('cache-control'), /max-age=31536000.*immutable/);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG);
  });

  await t.test('a new retail product gets its photo after the insert', async () => {
    reset();
    await admin.post('/admin/menu/products', { _csrf: token, _back: '/admin/menu', sku: 'NUOC', name: 'Nước suối', price: '10000', category_id: '2', inventory_item_id: '3', image_data: dataUrl(JPEG) });
    const [set] = called('product.setImage');
    assert.equal(set.args[0], 11, 'id returned by productModel.create');
    assert.match(set.args[1], /^\/media\/\d+-nuoc-suoi\.jpg$/);
    assert.equal(called('media.create')[0].args[0].folder, 'products');
  });

  await t.test('"Xóa ảnh" empties the link (an empty string, so no illustration comes back) and deletes the stored photo', async () => {
    reset();
    await admin.post('/admin/inventory/3', { _csrf: token, _back: '/admin/inventory', name: 'Ly nhựa + nắp', unit: 'pcs', min_stock: '50', is_active: '1', image_remove: '1' });
    assert.deepEqual(called('inventory.setImage').map((c) => c.args), [[3, '']]);
    assert.deepEqual(called('media.remove').map((c) => c.args[0]), [900]);
  });

  await t.test('a fake picture is refused before anything is written', async () => {
    reset();
    const notImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(200, ' '));
    for (const image_data of [dataUrl(notImage), dataUrl(notImage, 'svg+xml'), 'data:text/html;base64,PGI+', dataUrl(Buffer.alloc(620 * 1024, 0x41))]) {
      const res = await admin.post('/admin/inventory/3', { _csrf: token, _back: '/admin/inventory', name: 'X', image_data });
      assert.equal(res.status, 303);
    }
    assert.equal(called('inventory.update').length, 0);
    assert.equal(called('media.create').length, 0);
    assert.equal(called('inventory.setImage').length, 0);
  });

  await t.test('/media only answers for stored photos', async () => {
    for (const p of ['/media/999-x.jpg', '/media/abc', '/media/1-x.gif', '/media/1-X.jpg', '/media/1-a.jpg/..']) {
      assert.equal((await fx.client().get(p)).status, 404, p);
    }
  });

  await t.test('remove() never touches shipped illustrations or files outside public/uploads', async () => {
    reset();
    await imageStore.remove('/menu/ca-phe-sua.jpg');
    await imageStore.remove('/uploads/../../app.js');
    await imageStore.remove(null);
    assert.equal(called('media.remove').length, 0);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'app.js')));
  });

  await t.test('slugs and media ids', () => {
    assert.equal(imageStore.slugify('Cà Phê Sữa Đá'), 'ca-phe-sua-da');
    assert.equal(imageStore.mediaIdOf('/media/12-ca-phe.jpg'), 12);
    assert.equal(imageStore.mediaIdOf('/uploads/products/x.jpg'), null);
    assert.equal(imageStore.mediaIdOf('/media/12-ca-phe.jpg?x'), null);
  });
});
