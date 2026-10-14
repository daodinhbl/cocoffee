const logger = require('../utils/logger');
const { normalize } = require('../utils/text');

/**
 * The real CoCoffee printed menu (two A4 boards, "Open daily 6h30-17h"), prices in VND.
 * Applied once automatically at boot (ensureMenuSeed, called from app.js) and on demand by scripts/seed-menu.js.
 *
 * `keep` = SKU of a demo product from database/seed.sql that already exists: it is renamed/re-priced in place
 * so its recipe, order history and Zalo aliases survive. Everything else is inserted as a 'bom' product with no
 * recipe yet (the shop adds the BOM later; until then COGS is 0, same as any new product).
 * Every other item gets SKU MN-<slug of its name>. When you rename an entry here, add `sku: '<its old SKU>'`
 * so scripts/seed-menu.js updates that product instead of creating a second one.
 * Photos: public/menu/<slug>.jpg, assigned by config/menuPhotos.js.
 */
const CATEGORIES = [
  { code: 'coffee',      name: 'Coffee',          sort: 1 },
  { code: 'smoothie',    name: 'Sinh tố',         sort: 2 },
  { code: 'juice',       name: 'Nước ép',         sort: 3 },
  { code: 'tea',         name: 'Trà',             sort: 4 },
  { code: 'yogurt',      name: 'Yaourt',          sort: 5 },
  { code: 'soda',        name: 'Soda',            sort: 6 },
  { code: 'ice_blended', name: 'Đá xay',          sort: 7 },
  { code: 'other_drink', name: 'Đồ uống khác',    sort: 8 },
];

const MENU = [
  // COFFEE
  { cat: 'coffee', name: 'Cà Phê Sữa', price: 20000, keep: 'CF-SUA-DA' },
  { cat: 'coffee', name: 'Cà Phê Đen', price: 18000, keep: 'CF-DEN-DA' },
  { cat: 'coffee', name: 'Cà Phê Sữa Dừa', price: 24000 },
  { cat: 'coffee', name: 'Cà Phê Muối Kem Tươi', price: 24000 },
  { cat: 'coffee', name: 'Bạc Xỉu', price: 22000, keep: 'BAC-XIU' },
  { cat: 'coffee', name: 'Bạc Xỉu Đường Nâu', price: 24000 },
  { cat: 'coffee', name: 'Cacao', price: 22000 },
  { cat: 'coffee', name: 'Cacao Bạc Hà', price: 22000 },
  // SINH TỐ
  { cat: 'smoothie', name: 'Sinh Tố Sampoche', price: 25000 },
  { cat: 'smoothie', name: 'Sinh Tố Dâu', price: 25000 },
  { cat: 'smoothie', name: 'Sinh Tố Xoài', price: 25000 },
  { cat: 'smoothie', name: 'Sinh Tố Dừa', price: 25000 },
  { cat: 'smoothie', name: 'Sinh Tố Mãng Cầu', price: 25000 },
  { cat: 'smoothie', name: 'Sinh Tố Bơ', price: 25000 },
  // NƯỚC ÉP
  { cat: 'juice', name: 'Nước Ép Cam', price: 22000 },
  { cat: 'juice', name: 'Nước Ép Cam Cà Rốt', price: 25000 },
  { cat: 'juice', name: 'Nước Ép Cà Rốt', price: 25000 },
  { cat: 'juice', name: 'Nước Ép Táo', price: 25000 },
  { cat: 'juice', name: 'Nước Ép Thơm', price: 25000 },
  { cat: 'juice', name: 'Nước Ép Cóc', price: 25000 },
  { cat: 'juice', name: 'Nước Ép Mix', price: 25000 },
  // TRÀ
  { cat: 'tea', name: 'Trà Đào', price: 25000, keep: 'TRA-DAO' },
  { cat: 'tea', name: 'Trà Đào Cam Sả', price: 28000 },
  { cat: 'tea', name: 'Trà Vải', price: 22000 },
  { cat: 'tea', name: 'Trà Vải Xí Muội', price: 25000 },
  { cat: 'tea', name: 'Trà Chanh', price: 22000 },
  { cat: 'tea', name: 'Trà Tắc', price: 22000 },
  { cat: 'tea', name: 'Trà Táo', price: 22000 },
  { cat: 'tea', name: 'Trà Táo Bạc Hà', price: 25000 },
  { cat: 'tea', name: 'Trà Gừng (Nóng)', price: 20000 },
  { cat: 'tea', name: 'Trà Lipton', price: 22000 },
  // YAOURT
  { cat: 'yogurt', name: 'Yaourt Đá', price: 18000 },
  { cat: 'yogurt', name: 'Yaourt Xoài', price: 22000 },
  { cat: 'yogurt', name: 'Yaourt Dâu', price: 22000 },
  { cat: 'yogurt', name: 'Yaourt Kiwi', price: 22000 },
  { cat: 'yogurt', name: 'Yaourt Chanh Dây', price: 22000 },
  { cat: 'yogurt', name: 'Yaourt Nho', price: 22000 },
  { cat: 'yogurt', name: 'Yaourt Việt Quất', price: 22000 },
  { cat: 'yogurt', name: 'Yaourt Đào', price: 22000 },
  { cat: 'yogurt', name: 'Yaourt 3 Tầng', price: 27000 },
  // SODA
  { cat: 'soda', name: 'Soda Việt Quất', price: 22000 },
  { cat: 'soda', name: 'Soda Dâu', price: 22000 },
  { cat: 'soda', name: 'Soda Đào', price: 22000 },
  { cat: 'soda', name: 'Soda Bạc Hà', price: 22000 },
  { cat: 'soda', name: 'Soda Blue', price: 22000 },
  { cat: 'soda', name: 'Soda Chanh', price: 22000 },
  // ĐÁ XAY
  { cat: 'ice_blended', name: 'Matcha Đá Xay', price: 25000 },
  { cat: 'ice_blended', name: 'Cacao Đá Xay', price: 25000 },
  { cat: 'ice_blended', name: 'Oreo Đá Xay', price: 28000 },
  { cat: 'ice_blended', name: 'Tắc Đá Xay', price: 25000 },
  { cat: 'ice_blended', name: 'Việt Quất Đá Xay', price: 25000 },
  { cat: 'ice_blended', name: 'Chanh Tuyết', price: 22000 },
  // ĐỒ UỐNG KHÁC
  { cat: 'other_drink', name: 'Matcha Latte Dâu', price: 25000 },
  { cat: 'other_drink', name: 'Matcha Latte Xoài', price: 25000 },
  { cat: 'other_drink', name: 'Khoai Môn Sữa Gấu', price: 25000 },
  { cat: 'other_drink', name: 'Khoai Môn Kem Muối', price: 25000 },
  { cat: 'other_drink', name: 'Nước Chanh', price: 18000 },
  { cat: 'other_drink', name: 'Chanh Muối', price: 20000 },
  { cat: 'other_drink', name: 'Milo Dầm', price: 25000 },
  { cat: 'other_drink', name: 'Nước Ngọt Các Loại', price: 15000 },
];

const slugify = (s) => normalize(s).replace(/ /g, '-');

/** What a customer might type in Zalo: the name itself plus "cafe"/"cf" spellings for coffee items. */
function aliasesFor(name) {
  const out = [name];
  const m = /^cà phê (.+)$/i.exec(name);
  if (m) out.push(`cafe ${m[1]}`, `cf ${m[1]}`);
  return out;
}

/**
 * Upsert the menu on `conn` (one connection, inside the caller's transaction). Photos are not touched here
 * (config/menuPhotos.js assigns them). The owner's own data always wins over the printed menu:
 *   - a product is matched by SKU: `keep` (a demo row renamed in place), else `sku`, else MN-<slug of the name>;
 *   - a kept demo row the owner already turned into ANOTHER printed drink is left as that drink (no rename);
 *   - nothing is renamed onto, or inserted next to, an active product that already has the name, or whose
 *     own name equals one of the item's Zalo spellings (the in-memory name map follows every rename/insert);
 *   - an alias moves to the printed item ("trà đào cam sả" pointing at Trà Đào), except one that is another
 *     active product's own name.
 * @returns {Promise<{created:number, updated:number, skipped:number}>}
 */
async function applyMenu(conn) {
  const stats = { created: 0, updated: 0, skipped: 0 };

  const catId = {};
  for (const c of CATEGORIES) {
    await conn.query(
      `INSERT INTO categories (code, name, sort_order) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), sort_order = VALUES(sort_order), is_active = 1`,
      [c.code, c.name, c.sort]
    );
    const [[row]] = await conn.query('SELECT id FROM categories WHERE code = ?', [c.code]);
    catId[c.code] = row.id;
  }

  const [existing] = await conn.query('SELECT id, sku, name, is_active FROM products');
  const products = existing.map((p) => ({ id: p.id, sku: p.sku, norm: normalize(p.name), active: Boolean(p.is_active) }));
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const byId = new Map(products.map((p) => [p.id, p]));
  const activeByName = new Map(products.filter((p) => p.active).map((p) => [p.norm, p.id]));
  const [aliasRows] = await conn.query('SELECT alias_norm, product_id FROM product_aliases');
  const aliasOwner = new Map(aliasRows.map((a) => [a.alias_norm, a.product_id]));
  const menuNames = new Set(MENU.map((m) => normalize(m.name)));
  const ownSku = (item) => item.sku || `MN-${slugify(item.name).toUpperCase()}`;

  for (const item of MENU) {
    const norm = normalize(item.name);
    const aliases = aliasesFor(item.name);
    let product = item.keep ? bySku.get(item.keep) : undefined;
    if (product && product.norm !== norm && menuNames.has(product.norm)) product = undefined;   // already another printed drink
    if (!product) product = bySku.get(ownSku(item));

    if (product) {
      const holder = activeByName.get(norm);
      if (holder !== undefined && holder !== product.id) { stats.skipped += 1; continue; }   // the owner has this drink already
      await conn.query(
        'UPDATE products SET category_id = ?, name = ?, price = ?, is_active = 1 WHERE id = ?',
        [catId[item.cat], item.name, item.price, product.id]
      );
      if (activeByName.get(product.norm) === product.id) activeByName.delete(product.norm);
      product.norm = norm;
      product.active = true;
      stats.updated += 1;
    } else {
      if (aliases.some((a) => activeByName.has(normalize(a)))) { stats.skipped += 1; continue; }
      const sku = ownSku(item);
      const [res] = await conn.query(
        `INSERT INTO products (category_id, sku, name, price, stock_mode, is_active)
         VALUES (?, ?, ?, ?, 'bom', 1)`,
        [catId[item.cat], sku, item.name, item.price]
      );
      product = { id: res.insertId, sku, norm, active: true };
      bySku.set(sku, product);
      byId.set(product.id, product);
      stats.created += 1;
    }
    activeByName.set(norm, product.id);

    for (const alias of aliases) {
      const aliasNorm = normalize(alias);
      const owner = byId.get(aliasOwner.get(aliasNorm));
      if (owner && owner.id !== product.id && owner.active && owner.norm === aliasNorm) continue;
      await conn.query(
        `INSERT INTO product_aliases (product_id, alias, alias_norm) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE product_id = VALUES(product_id), alias = VALUES(alias)`,
        [product.id, alias, aliasNorm]
      );
      aliasOwner.set(aliasNorm, product.id);
    }
  }

  // Trà đá (demo, not on the printed menu) belongs with the teas; the old catch-all category is retired when empty.
  await conn.query("UPDATE products SET category_id = ? WHERE sku = 'TRA-DA'", [catId.tea]);
  await conn.query(
    `UPDATE categories SET is_active = 0
      WHERE code = 'mixed_drink' AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = categories.id AND p.is_active = 1)`
  );
  return stats;
}

const SETTING_KEY = 'seed.menu_v1';
const LOCK = 'cocoffee_menu_seed';

/**
 * Apply the menu in one transaction, serialised across processes with a MySQL named lock (two app workers
 * booting together, or the script racing a dev server restart, would otherwise both insert the same SKUs).
 *   once: true  -> skip when seed.menu_v1 is already recorded (boot), and skip an empty database
 *   once: false -> always apply (scripts/seed-menu.js after editing MENU)
 * @returns {Promise<{state:'applied'|'done-before'|'skipped-empty', stats?:object}>}
 */
async function runMenuSeed(pool, { once }) {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 30) AS ok', [LOCK]);
    if (Number(lock.ok) !== 1) throw new Error('menu seed lock timeout');
    locked = true;
    if (once) {
      const [[done]] = await conn.query('SELECT COUNT(*) AS n FROM app_settings WHERE setting_key = ?', [SETTING_KEY]);
      if (Number(done.n)) return { state: 'done-before' };
      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM products');
      if (!Number(n)) {
        // A database that started empty belongs to the owner: record it, so the menu is never pushed in later
        // (on a restart after they built their own). scripts/seed-menu.js still applies it on request.
        await conn.query('INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)', [SETTING_KEY, '"skipped-empty"']);
        return { state: 'skipped-empty' };
      }
    }
    await conn.beginTransaction();
    try {
      const stats = await applyMenu(conn);
      await conn.query(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [SETTING_KEY, JSON.stringify(stats)]
      );
      await conn.commit();
      require('../models/productModel').invalidateCatalog();
      return { state: 'applied', stats };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    }
  } finally {
    if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [LOCK]).catch(() => {});
    conn.release();
  }
}

/** One-shot at boot: applies the menu the first time only, so later edits in the admin are never overwritten. Never throws. */
async function ensureMenuSeed() {
  const { pool } = require('./db');
  try {
    const r = await runMenuSeed(pool, { once: true });
    if (r.state === 'applied') logger.info(`Menu seed applied: ${r.stats.created} created, ${r.stats.updated} updated, ${r.stats.skipped} skipped`);
    return r.state;
  } catch (err) {
    logger.error('Menu seed failed', err);
    return 'failed';
  }
}

module.exports = { CATEGORIES, MENU, applyMenu, runMenuSeed, ensureMenuSeed, slugify };
