const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
const { BOTTLED, applyBottledDrinks, slugify } = require('../src/config/bottledDrinks');
const { MENU } = require('../src/config/menuSeed');

test('bottled drinks: the six items, with photos and valid SKUs', () => {
  assert.deepEqual(BOTTLED.map((d) => d.name), ['Sting', 'Number One', 'Bò Húc Thái (Redbull)', 'Wake Up 24/7', 'Trà Xanh Không Độ', 'C2']);
  assert.equal(BOTTLED.find((d) => d.name.startsWith('Bò Húc')).price, 20000);
  assert.equal(new Set(BOTTLED.map((d) => d.sku)).size, BOTTLED.length, 'unique SKUs');
  for (const d of BOTTLED) {
    assert.match(d.sku, /^GD-[A-Z0-9-]+$/);
    assert.ok(d.sku.length <= 40);
    const file = path.join(__dirname, '..', 'public', 'menu', `${slugify(d.name)}.jpg`);
    assert.ok(fs.existsSync(file), `${d.name}: ${path.basename(file)} is missing`);
    assert.ok(fs.statSync(file).size < 300 * 1024, `${d.name}: photo is larger than 300 KB`);
  }
  assert.equal(slugify('Bò Húc Thái (Redbull)'), 'bo-huc-thai-redbull');
});

test('the printed board keeps the same name for the Redbull, so a menu re-seed does not create a duplicate', () => {
  assert.ok(MENU.some((m) => m.name === 'Bò Húc Thái (Redbull)'));
  assert.ok(!MENU.some((m) => /Bò Cụng/.test(m.name)));
});

test('applyBottledDrinks: converts in place, creates the rest, deducts 1:1 from its own stock item', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM categories/.test(sql)) return [[{ id: 3 }]];
      if (/FROM inventory_items WHERE sku/.test(sql)) return [[undefined]];
      if (/FROM products WHERE sku = \?/.test(sql)) return [[params[0] === 'MN-STING' ? { id: 93, image_url: '/menu/sting.jpg' } : undefined]];
      if (/FROM products WHERE is_active/.test(sql)) return [[undefined]];
      if (/INSERT INTO inventory_items/.test(sql)) return [{ insertId: 50 + calls.length }];
      if (/INSERT INTO products/.test(sql)) return [{ insertId: 200 + calls.length }];
      return [{ affectedRows: 1 }];
    },
  };
  const r = await applyBottledDrinks(db);
  assert.equal(r.items, 6);
  assert.equal(r.converted, 1, 'only MN-STING exists in this fake');
  assert.equal(r.created, 5);
  const update = calls.find((c) => /UPDATE products SET/.test(c.sql));
  assert.match(update.sql, /stock_mode = 'direct'/);
  assert.equal(update.params[1], 'GD-STING');
  const insertItem = calls.find((c) => /INSERT INTO inventory_items/.test(c.sql));
  assert.match(insertItem.sql, /'retail'/);
  assert.deepEqual(insertItem.params.slice(0, 3), ['GD-STING', 'Sting', 'bottle']);
  assert.ok(calls.some((c) => /INSERT INTO product_aliases/.test(c.sql) && c.params[2] === 'bo huc'), 'Zalo keywords are set');
});
