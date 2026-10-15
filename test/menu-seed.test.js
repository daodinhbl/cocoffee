/**
 * Menu data shipped with the app: illustration photos in public/menu assigned at boot (config/menuPhotos.js) and
 * the printed menu applied once (config/menuSeed.js: named lock, one transaction, never over the owner's data).
 * No MySQL: connections are faked.
 */
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';   // config/env requires them; nothing connects

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('shipped menu photos are assigned only where a photo is missing', async () => {
  const { assignMenuPhotos } = require('../src/config/menuPhotos');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-photos-'));
  fs.mkdirSync(path.join(dir, 'ingredients'));
  for (const f of ['ca-phe-sua.jpg', 'ca-phe-den.jpg', 'tra-vai.svg', 'thuoc-la-555.jpg', 'ingredients/sua-dac.jpg', 'notes.txt']) fs.writeFileSync(path.join(dir, f), 'x');

  const rows = {
    products: [
      { id: 1, sku: 'CF-SUA-DA', name: 'Cà Phê Sữa', image_url: null },                         // by SKU
      { id: 2, sku: 'MN-TRA-VAI', name: 'Trà Vải', image_url: null },                            // by name
      { id: 3, sku: 'MN-SODA-BLUE', name: 'Soda Blue', image_url: '/menu/soda-blue.jpg' },       // file gone -> cleared
      { id: 4, sku: 'X', name: 'Bạc Xỉu', image_url: '/media/4-bac-xiu.jpg' },                   // admin upload: kept
      { id: 5, sku: 'Y', name: 'Món lạ', image_url: null },                                      // nothing to give
      { id: 6, sku: '555', name: 'Thuốc lá 555', image_url: '/menu/thuoc-la-555.jpg' },          // already right
      { id: 7, sku: 'CF-DEN-DA', name: 'Cà Phê Đen', image_url: '' },                           // removed in the admin: stays empty
    ],
    inventory_items: [
      { id: 1, sku: 'RM-MILK-CON', name: 'Sữa đặc', image_url: null },                           // ingredients/ folder
      { id: 2, sku: 'GD-555', name: 'Thuốc lá 555', image_url: null },                           // falls back to the product photo
      { id: 3, sku: 'RM-ICE', name: 'Đá viên', image_url: '/uploads/ingredients/da-vien-3.jpg' },
    ],
  };
  const updates = [];
  const conn = {
    query: async (sql, params) => {
      if (/FROM products/.test(sql)) return [rows.products];
      if (/FROM inventory_items/.test(sql)) return [rows.inventory_items];
      const m = /^UPDATE (\w+) SET image_url = \? WHERE id = \?$/.exec(sql);
      if (m) { updates.push([m[1], ...params]); return [{}]; }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const changed = await assignMenuPhotos(conn, { dir });
  assert.deepEqual(updates, [
    ['products', '/menu/ca-phe-sua.jpg', 1],
    ['products', '/menu/tra-vai.svg', 2],
    ['products', null, 3],
    ['inventory_items', '/menu/ingredients/sua-dac.jpg', 1],
    ['inventory_items', '/menu/thuoc-la-555.jpg', 2],
  ]);
  assert.deepEqual(changed, { products: 3, ingredients: 2 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('menu seed: named lock, one transaction, once per database', async (t) => {
  const { runMenuSeed, MENU } = require('../src/config/menuSeed');
  // A fake mysql2 pool: answers are [regex, value | fn] tried in order; every call is logged.
  function fakePool(answers) {
    const log = [];
    const conn = {
      query: async (sql, params) => {
        log.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40));
        for (const [re, val] of answers) if (re.test(sql)) return typeof val === 'function' ? val(sql, params) : val;
        return [[]];
      },
      beginTransaction: async () => { log.push('BEGIN'); },
      commit: async () => { log.push('COMMIT'); },
      rollback: async () => { log.push('ROLLBACK'); },
      release: () => { log.push('RELEASE-CONN'); },
    };
    return { log, getConnection: async () => conn };
  }
  const LOCK_OK = [/GET_LOCK/, [[{ ok: 1 }]]];
  const has = (log, s) => log.some((l) => l.startsWith(s));

  await t.test('already applied: nothing written, lock and connection released', async () => {
    const pool = fakePool([LOCK_OK, [/FROM app_settings/, [[{ n: 1 }]]]]);
    assert.deepEqual(await runMenuSeed(pool, { once: true }), { state: 'done-before' });
    assert.ok(!pool.log.includes('BEGIN'));
    assert.ok(has(pool.log, 'SELECT RELEASE_LOCK'));
    assert.equal(pool.log.at(-1), 'RELEASE-CONN');
  });

  await t.test('a database without products is left to the owner', async () => {
    const pool = fakePool([LOCK_OK, [/FROM app_settings/, [[{ n: 0 }]]], [/COUNT\(\*\) AS n FROM products/, [[{ n: 0 }]]]]);
    assert.deepEqual(await runMenuSeed(pool, { once: true }), { state: 'skipped-empty' });
    assert.ok(!pool.log.includes('BEGIN'));
    assert.ok(has(pool.log, 'INSERT IGNORE INTO app_settings'), 'recorded, so a later boot never pushes the menu into the owner\x27s own');
  });

  await t.test('first boot: whole menu in one transaction, kept demo SKU updated in place, marker written', async () => {
    let insertId = 100;
    const pool = fakePool([
      LOCK_OK,
      [/FROM app_settings/, [[{ n: 0 }]]],
      [/COUNT\(\*\) AS n FROM products/, [[{ n: 10 }]]],
      [/SELECT id FROM categories/, [[{ id: 7 }]]],
      [/SELECT id, sku, name, is_active FROM products/, [[{ id: 2, sku: 'CF-SUA-DA', name: 'Cà phê sữa đá', is_active: 1 }]]],
      [/INSERT INTO products/, () => [{ insertId: insertId++ }]],
    ]);
    const r = await runMenuSeed(pool, { once: true });
    assert.equal(r.state, 'applied');
    assert.deepEqual(r.stats, { created: MENU.length - 1, updated: 1, skipped: 0 });
    const begin = pool.log.indexOf('BEGIN');
    const commit = pool.log.indexOf('COMMIT');
    assert.ok(begin > 0 && commit > begin);
    assert.ok(pool.log.slice(begin, commit).some((l) => l.startsWith('INSERT INTO app_settings')), 'marker inside the transaction');
    assert.ok(has(pool.log.slice(commit), 'SELECT RELEASE_LOCK'));
  });

  await t.test('a failure rolls everything back and still releases the lock', async () => {
    const pool = fakePool([
      LOCK_OK,
      [/FROM app_settings/, [[{ n: 0 }]]],
      [/COUNT\(\*\) AS n FROM products/, [[{ n: 10 }]]],
      [/SELECT id FROM categories/, [[{ id: 7 }]]],
      [/INSERT INTO products/, () => { throw new Error("Duplicate entry 'MN-X' for key 'uq_products_sku'"); }],
    ]);
    await assert.rejects(runMenuSeed(pool, { once: true }), /Duplicate entry/);
    assert.ok(pool.log.includes('ROLLBACK'));
    assert.ok(!pool.log.includes('COMMIT'));
    assert.ok(has(pool.log, 'SELECT RELEASE_LOCK'));
    assert.equal(pool.log.at(-1), 'RELEASE-CONN');
  });

  await t.test('another process holding the lock: give up without touching anything', async () => {
    const pool = fakePool([[/GET_LOCK/, [[{ ok: 0 }]]]]);
    await assert.rejects(runMenuSeed(pool, { once: true }), /lock timeout/);
    assert.ok(!has(pool.log, 'SELECT RELEASE_LOCK'));
    assert.equal(pool.log.at(-1), 'RELEASE-CONN');
  });
});

test('menu seed never renames, duplicates or steals from what the owner already has', async (t) => {
  const { applyMenu, MENU } = require('../src/config/menuSeed');
  const { normalize } = require('../src/utils/text');

  /** Just enough of MySQL for applyMenu: categories, products and product_aliases with their unique keys. */
  function memoryDb({ products, aliases }) {
    const cats = new Map();
    const prods = products.map((p) => ({ is_active: 1, ...p }));
    const al = new Map(aliases.map(([product_id, alias]) => [normalize(alias), { product_id, alias }]));
    let nextId = Math.max(...prods.map((p) => p.id)) + 1;
    const query = async (sql, params = []) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q.startsWith('INSERT INTO categories')) { if (!cats.has(params[0])) cats.set(params[0], cats.size + 1); return [{}]; }
      if (q.startsWith('SELECT id FROM categories')) return [[{ id: cats.get(params[0]) }]];
      if (q.startsWith('SELECT id, sku, name, is_active FROM products')) return [prods.map(({ id, sku, name, is_active }) => ({ id, sku, name, is_active }))];
      if (q.startsWith('SELECT alias_norm, product_id FROM product_aliases')) return [[...al].map(([alias_norm, a]) => ({ alias_norm, product_id: a.product_id }))];
      if (q.startsWith('INSERT INTO products')) {
        const [, sku, name, price] = params;
        if (prods.some((p) => p.sku === sku)) throw Object.assign(new Error(`Duplicate entry '${sku}'`), { errno: 1062 });
        prods.push({ id: nextId, sku, name, price, is_active: 1 });
        return [{ insertId: nextId++ }];
      }
      if (q.startsWith('UPDATE products SET category_id = ?, name = ?, price = ? , is_active = 1') || q.startsWith('UPDATE products SET category_id = ?, name = ?, price = ?, is_active = 1')) {
        const [, name, price, id] = params;
        Object.assign(prods.find((p) => p.id === id), { name, price, is_active: 1 });
        return [{}];
      }
      if (q.startsWith('INSERT INTO product_aliases')) { al.set(params[2], { product_id: params[0], alias: params[1] }); return [{}]; }
      if (q.startsWith('UPDATE products SET category_id = ? WHERE sku') || q.startsWith('UPDATE categories SET is_active = 0')) return [{}];
      throw new Error(`unexpected SQL: ${q}`);
    };
    const named = (n) => prods.filter((p) => p.is_active && normalize(p.name) === normalize(n));
    const ownerOf = (alias) => al.get(normalize(alias))?.product_id;
    return { query, prods, named, ownerOf };
  }
  // database/seed.sql, as shipped
  const DEMO = {
    products: [
      { id: 1, sku: 'CF-DEN-DA', name: 'Cà phê đen đá', price: 20000 }, { id: 2, sku: 'CF-SUA-DA', name: 'Cà phê sữa đá', price: 25000 },
      { id: 3, sku: 'BAC-XIU', name: 'Bạc xỉu', price: 29000 }, { id: 4, sku: 'TRA-DAO', name: 'Trà đào', price: 35000 },
      { id: 5, sku: 'TRA-DA', name: 'Trà đá', price: 8000 }, { id: 6, sku: '555', name: 'Thuốc lá 555', price: 45000 },
    ],
    aliases: [[1, 'Cà phê đen đá'], [1, 'cà phê đen'], [1, 'cafe đen'], [1, 'cf đen'], [2, 'Cà phê sữa đá'], [2, 'cà phê sữa'], [2, 'cafe sữa'],
      [2, 'cf sữa'], [3, 'Bạc xỉu'], [4, 'Trà đào'], [4, 'trà đào cam sả'], [5, 'Trà đá'], [6, 'Thuốc lá 555']],
  };
  const clone = (d) => JSON.parse(JSON.stringify(d));

  await t.test('demo database: the 4 kept drinks are renamed in place, the rest is added once', async () => {
    const db = memoryDb(clone(DEMO));
    assert.deepEqual(await applyMenu(db), { created: MENU.length - 4, updated: 4, skipped: 0 });
    assert.deepEqual(db.named('Cà Phê Sữa Pha Máy').map((p) => [p.id, p.price]), [[2, 17000]]);
    assert.deepEqual(db.named('Trà Đào Nóng').map((p) => [p.id, p.price]), [[4, 18000]], 'the demo peach tea becomes the hot one, recipe and all');
    assert.equal(db.ownerOf('tra dao cam sa'), 4, 'an old keyword stays with the renamed demo row');
    assert.equal(db.ownerOf('ca phe sua da'), 2, 'old spellings stay with the renamed product');
    for (const m of MENU) assert.equal(db.named(m.name).length, 1, m.name);
    assert.deepEqual(await applyMenu(db), { created: 0, updated: MENU.length, skipped: 0 }, 'a second run changes nothing in shape');
  });

  await t.test('a kept demo row the owner turned into another printed drink stays that drink', async () => {
    const data = clone(DEMO);
    Object.assign(data.products[3], { name: 'Sữa nóng', price: 16000 });   // TRA-DAO reused by the owner for another board item
    data.aliases.push([4, 'Sữa nóng']);
    const db = memoryDb(data);
    const stats = await applyMenu(db);
    assert.deepEqual(db.prods.find((p) => p.id === 4), { id: 4, sku: 'TRA-DAO', name: 'Sữa nóng', price: 16000, is_active: 1 });
    assert.equal(db.named('Sữa Nóng').length, 1, 'no second hot milk');
    assert.equal(db.named('Trà Đào Nóng')[0].sku, 'MN-TRA-DAO-NONG', 'the hot peach tea is added under its own SKU');
    assert.equal(db.ownerOf('sua nong'), 4, "the owner's own name is not taken away");
    assert.equal(stats.skipped, 1);
  });

  await t.test("an owner product named like one of the item's Zalo spellings blocks the item and keeps its alias", async () => {
    const data = clone(DEMO);
    data.products.push({ id: 50, sku: 'CFSPP', name: 'Cafe sữa pha phin', price: 30000 });
    data.aliases.push([50, 'Cafe sữa pha phin']);
    const db = memoryDb(data);
    await applyMenu(db);
    assert.equal(db.named('Cà Phê Sữa Pha Phin').length, 0, "not added next to the owner's drink");
    assert.equal(db.ownerOf('cafe sua pha phin'), 50);
    assert.equal(db.prods.find((p) => p.id === 50).price, 30000);
  });

  await t.test('a kept SKU is not renamed onto a name another active product already has', async () => {
    const data = clone(DEMO);
    data.products.push({ id: 51, sku: 'OWN-CFS', name: 'Cà phê sữa pha máy', price: 22000 });
    data.aliases.push([51, 'Cà phê sữa pha máy']);
    const db = memoryDb(data);
    await applyMenu(db);
    assert.equal(db.prods.find((p) => p.id === 2).name, 'Cà phê sữa đá', 'demo row left alone');
    assert.deepEqual(db.named('Cà Phê Sữa Pha Máy').map((p) => p.id), [51]);
  });
});

test('every drink on the board ships a photo named after it (public/menu/<slug>.jpg), so the boot step can attach it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { MENU } = require('../src/config/menuSeed');
  const { slugify } = require('../src/config/menuPhotos');
  const dir = path.join(__dirname, '..', 'public', 'menu');
  const noPhotoYet = new Set(['cigarette']);   // retail packs: the owner uploads their own pictures in Web Admin > Thực đơn
  for (const item of MENU.filter((m) => !noPhotoYet.has(m.cat))) {
    const file = path.join(dir, `${slugify(item.name)}.jpg`);
    assert.ok(fs.existsSync(file), `${item.name}: public/menu/${slugify(item.name)}.jpg is missing`);
    const head = fs.readFileSync(file).subarray(0, 2);
    assert.deepEqual([...head], [0xFF, 0xD8], `${item.name}: not a JPEG`);
    assert.ok(fs.statSync(file).size < 300 * 1024, `${item.name}: photo is larger than 300 KB (the POS loads these on every table)`);
  }
});
