const logger = require('../utils/logger');
const { normalize } = require('../utils/text');

/**
 * The real Cò Coffee menu board (photo of 2026-10-16: six groups, prices in VND; "Mang về không tẩy đá -2K" is a
 * takeaway discount the cashier applies by hand, not a product).
 * Applied once automatically at boot (ensureMenuSeed, called from app.js) and on demand by scripts/seed-menu.js,
 * which can also retire the drinks of the earlier, longer printed menu (--retire).
 *
 * `keep` = SKU of a demo product from database/seed.sql that already exists: it is renamed/re-priced in place
 * so its recipe, order history and Zalo aliases survive. Everything else is inserted as a 'bom' product with no
 * recipe yet (the shop adds the BOM later; until then COGS is 0, same as any new product).
 * Every other item gets SKU MN-<slug of its name>. When you rename an entry here, add `sku: '<its old SKU>'`
 * so scripts/seed-menu.js updates that product instead of creating a second one.
 * Photos: public/menu/<slug>.jpg, assigned by config/menuPhotos.js.
 */
const CATEGORIES = [
  { code: 'coffee',      name: 'Cà phê',           sort: 1 },
  { code: 'hot_drink',   name: 'Đồ nóng',          sort: 2 },
  { code: 'yogurt',      name: 'Yaourt',           sort: 3 },
  { code: 'juice',       name: 'Nước ép trái cây', sort: 4 },
  { code: 'ice_blended', name: 'Đá xay',           sort: 5 },
  { code: 'soft_drink',  name: 'Nước ngọt',        sort: 6 },
  { code: 'cigarette',   name: 'Thuốc lá',         sort: 8 },   // retail, sold at the counter (bottled water keeps sort 7)
];

const MENU = [
  // CÀ PHÊ
  { cat: 'coffee', name: 'Cà Phê Sữa Pha Máy', price: 17000, keep: 'CF-SUA-DA' },
  { cat: 'coffee', name: 'Cà Phê Đen Pha Máy', price: 15000, keep: 'CF-DEN-DA' },
  { cat: 'coffee', name: 'Cà Phê Sữa Pha Phin', price: 16000 },
  { cat: 'coffee', name: 'Cà Phê Đen Pha Phin', price: 14000 },
  { cat: 'coffee', name: 'Bạc Xỉu', price: 20000, keep: 'BAC-XIU' },            // đá hoặc nóng, cùng giá
  // ĐỒ NÓNG
  { cat: 'hot_drink', name: 'Trà Gừng Nóng', price: 18000, sku: 'MN-TRA-GUNG-NONG' },
  { cat: 'hot_drink', name: 'Trà Đào Nóng', price: 18000, keep: 'TRA-DAO' },
  { cat: 'hot_drink', name: 'Ca Cao Nóng', price: 20000, sku: 'MN-CACAO' },
  { cat: 'hot_drink', name: 'Sữa Nóng', price: 15000 },
  // YAOURT
  { cat: 'yogurt', name: 'Yaourt Hũ', price: 12000 },
  { cat: 'yogurt', name: 'Yaourt Đá', price: 20000 },
  { cat: 'yogurt', name: 'Yaourt Việt Quất', price: 25000 },
  { cat: 'yogurt', name: 'Yaourt Đào', price: 25000 },
  // NƯỚC ÉP TRÁI CÂY
  { cat: 'juice', name: 'Nước Ép Cam', price: 20000 },
  { cat: 'juice', name: 'Nước Sấu', price: 18000 },
  { cat: 'juice', name: 'Nước Mơ', price: 18000 },
  { cat: 'juice', name: 'Siro Atiso', price: 18000 },
  { cat: 'juice', name: 'Trà Tắc', price: 15000 },
  // ĐÁ XAY
  { cat: 'ice_blended', name: 'Ca Cao Đá Xay', price: 25000, sku: 'MN-CACAO-DA-XAY' },
  { cat: 'ice_blended', name: 'Việt Quất Đá Xay', price: 25000 },
  { cat: 'ice_blended', name: 'Cà Phê Đá Xay', price: 25000 },
  // NƯỚC NGỌT (lon / chai)
  { cat: 'soft_drink', name: 'Wake Up 24/7', price: 14000 },
  { cat: 'soft_drink', name: 'Number One', price: 14000 },
  { cat: 'soft_drink', name: 'Bò Cụng (RedBull)', price: 18000 },
  { cat: 'soft_drink', name: 'Sting', price: 14000 },
  // THUỐC LÁ (the owner's list of 2026-10-16; the demo packs 555 / Marlboro / Thăng Long stay as they are)
  { cat: 'cigarette', name: 'Thuốc Lá Seven', price: 18000 },
  { cat: 'cigarette', name: 'Thuốc Lá Sài Gòn Bạc', price: 20000 },
  { cat: 'cigarette', name: 'Thuốc Lá Mèo Đỏ', price: 25000 },
];

// Demo rows from database/seed.sql that the board does not list; retired together with the MN-* leftovers.
const RETIRED_DEMO_SKUS = ['TRA-DA'];
// Groups of the earlier printed menu: switched off once nothing active is left in them.
const RETIRED_CATEGORIES = ['mixed_drink', 'smoothie', 'tea', 'soda', 'other_drink'];

const slugify = (s) => normalize(s).replace(/ /g, '-');
/** SKU an item is matched/inserted under when it has no `keep`: its explicit `sku`, else MN-<slug>. */
const ownSku = (item) => item.sku || `MN-${slugify(item.name).toUpperCase()}`;

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
 *   - an alias moves to the printed item, except one that is another active product's own name.
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

  // The old demo catch-all category is retired when empty.
  await conn.query(
    `UPDATE categories SET is_active = 0
      WHERE code = 'mixed_drink' AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = categories.id AND p.is_active = 1)`
  );
  return stats;
}

/**
 * Switch off what the board no longer lists: drinks an earlier seed added (SKU MN-*) and the retired demo rows,
 * never the owner's own products (any other SKU); then the empty groups of the earlier menu. Bottled water moves
 * behind the drink groups. Reversible from Web Admin > Thực đơn.
 * @returns {Promise<string[]>} names of the products switched off
 */
async function retireUnlisted(conn) {
  const listed = new Set(MENU.map((m) => m.keep || ownSku(m)));
  const [rows] = await conn.query("SELECT id, sku, name FROM products WHERE is_active = 1 AND (sku LIKE 'MN-%' OR sku IN (?))", [RETIRED_DEMO_SKUS]);
  const retire = rows.filter((p) => !listed.has(p.sku));
  if (retire.length) await conn.query('UPDATE products SET is_active = 0 WHERE id IN (?)', [retire.map((p) => p.id)]);
  await conn.query(
    `UPDATE categories SET is_active = 0
      WHERE code IN (?) AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = categories.id AND p.is_active = 1)`,
    [RETIRED_CATEGORIES]
  );
  await conn.query("UPDATE categories SET sort_order = 7 WHERE code = 'bottled_water'");
  return retire.map((p) => p.name);
}

const SETTING_KEY = 'seed.menu_v1';
const LOCK = 'cocoffee_menu_seed';

/**
 * Apply the menu in one transaction, serialised across processes with a MySQL named lock (two app workers
 * booting together, or the script racing a dev server restart, would otherwise both insert the same SKUs).
 *   once: true  -> skip when seed.menu_v1 is already recorded (boot), and skip an empty database
 *   once: false -> always apply (scripts/seed-menu.js after editing MENU)
 *   aliases     -> also add EXTRA_ALIASES (scripts/seed-menu.js)
 *   retire      -> also retireUnlisted() (scripts/seed-menu.js --retire)
 *   dryRun      -> roll back instead of committing, still reporting what would change
 * @returns {Promise<{state:'applied'|'done-before'|'skipped-empty', stats?:object, aliases?:number, retired?:string[]}>}
 */
async function runMenuSeed(pool, { once, aliases = false, retire = false, dryRun = false }) {
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
      const added = aliases ? await applyExtraAliases(conn) : 0;
      const retired = retire ? await retireUnlisted(conn) : [];
      await conn.query(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [SETTING_KEY, JSON.stringify(stats)]
      );
      if (dryRun) { await conn.rollback(); } else { await conn.commit(); }
      require('../models/productModel').invalidateCatalog();
      return { state: 'applied', stats, aliases: added, retired };
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

// ---------------------------------------------------------------------------------------------- extra aliases
/**
 * How customers really order ("1 đen đá", "cf sữa phin", "ép cam", "bò cụng"...). Added once per database at boot
 * and by scripts/seed-menu.js, to the products that carry these names; an alias that already exists (on any
 * product) or equals a product's own name is left alone, so the owner's edits always win.
 */
const EXTRA_ALIASES = {
  'Cà Phê Đen Pha Máy': ['cà phê đen', 'cf đen', 'cafe đen', 'đen đá', 'đen nóng', 'cà phê đen đá', 'cà phê đen nóng', 'cà phê đen máy', 'đen máy', 'cf đen đá', 'cafe đen đá'],
  'Cà Phê Sữa Pha Máy': ['cà phê sữa', 'cf sữa', 'cafe sữa', 'cà phê sữa đá', 'cà phê sữa nóng', 'cà phê sữa máy', 'sữa máy', 'cf nâu', 'cà phê nâu', 'nâu đá', 'nâu nóng'],
  'Cà Phê Sữa Pha Phin': ['cà phê sữa phin', 'cf sữa phin', 'cafe sữa phin', 'sữa phin', 'phin sữa', 'nâu phin'],
  'Cà Phê Đen Pha Phin': ['cà phê đen phin', 'cf đen phin', 'cafe đen phin', 'đen phin', 'phin đen'],
  'Bạc Xỉu': ['bạc xỉu đá', 'bạc xỉu nóng', 'bạc sỉu', 'bạc sửu'],
  'Trà Gừng Nóng': ['trà gừng'],
  'Trà Đào Nóng': ['trà đào'],
  'Ca Cao Nóng': ['cacao nóng', 'ca cao', 'cacao', 'cacao sữa nóng', 'ca cao sữa'],
  'Sữa Nóng': ['sữa tươi nóng', 'sữa tươi'],
  'Yaourt Hũ': ['sữa chua hũ', 'yaourt hộp', 'sữa chua hộp', 'yaourt hũ nhỏ'],
  'Yaourt Đá': ['yaourt đánh đá', 'sữa chua đánh đá'],
  'Yaourt Việt Quất': ['sữa chua việt quất', 'yaourt việt quất đá'],
  'Yaourt Đào': ['sữa chua đào', 'yaourt đào đá'],
  'Nước Ép Cam': ['ép cam', 'cam ép', 'cam vắt', 'nước cam', 'nước cam ép'],
  'Nước Sấu': ['nước sấu đá', 'sấu đá', 'nước sấu ngâm'],
  'Nước Mơ': ['nước mơ đá', 'mơ đá', 'nước mơ ngâm'],
  'Siro Atiso': ['atiso', 'siro atisô', 'nước atiso', 'atiso đá'],
  'Trà Tắc': ['trà quất', 'trà tắc đá', 'tắc đá'],
  'Ca Cao Đá Xay': ['cacao đá xay', 'socola đá xay', 'sô cô la đá xay', 'chocolate đá xay', 'cacao xay'],
  'Việt Quất Đá Xay': ['việt quất xay', 'đá xay việt quất'],
  'Cà Phê Đá Xay': ['cf đá xay', 'cafe đá xay', 'cà phê xay', 'đá xay cà phê'],
  'Wake Up 24/7': ['wake up', 'wakeup', 'wake up 247', 'wake up 24 7', 'cà phê lon wake up'],
  'Number One': ['number 1', 'numberone', 'nước tăng lực number one'],
  'Bò Cụng (RedBull)': ['bò cụng', 'redbull', 'red bull', 'bò húc'],
  'Sting': ['sting dâu', 'sting đỏ', 'sting vàng'],
  'Thuốc Lá Seven': ['seven', 'thuốc seven', 'gói seven'],
  'Thuốc Lá Sài Gòn Bạc': ['sài gòn bạc', 'thuốc sài gòn bạc', 'sg bạc', 'saigon bạc'],
  'Thuốc Lá Mèo Đỏ': ['mèo đỏ', 'thuốc mèo đỏ', 'craven', 'craven a', 'con mèo'],
};
// Deliberately NOT aliases: bare "đen", "nâu", "sữa", "sấu", "mơ", "tắc", "nước ngọt", "sữa đá", "sữa chua đá", "nước suối".
// A bare common word turns ordinary chat into an order, and an alias that is a prefix/part of other products' names
// ("sữa đá" in "cacao sữa đá") wins the matcher over the right product. Ambiguous names are asked about, with suggestions.
const ALIAS_KEY = 'seed.aliases_v3';
const ALIAS_LOCK = 'cocoffee_menu_aliases';

/** @returns {Promise<number>} aliases inserted */
async function applyExtraAliases(conn) {
  const [products] = await conn.query('SELECT id, name FROM products WHERE is_active = 1');
  const byName = new Map(products.map((p) => [normalize(p.name), p.id]));
  const [existing] = await conn.query('SELECT alias_norm FROM product_aliases');
  const taken = new Set(existing.map((r) => r.alias_norm));
  let added = 0;
  for (const [name, aliases] of Object.entries(EXTRA_ALIASES)) {
    const id = byName.get(normalize(name));
    if (!id) continue;
    for (const alias of aliases) {
      const n = normalize(alias);
      if (!n || taken.has(n) || byName.has(n)) continue;
      await conn.query('INSERT INTO product_aliases (product_id, alias, alias_norm) VALUES (?, ?, ?)', [id, alias, n]);
      taken.add(n);
      added += 1;
    }
  }
  return added;
}

/**
 * One-shot at boot, after ensureMenuSeed: adds EXTRA_ALIASES to a database that got the printed menu, once. Skipped on
 * a database that started empty (it belongs to the owner). Never throws.
 */
async function ensureMenuAliases() {
  const { pool } = require('./db');
  let conn;
  let locked = false;
  try {
    conn = await pool.getConnection();
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 30) AS ok', [ALIAS_LOCK]);
    if (Number(lock.ok) !== 1) return 'lock-timeout';
    locked = true;
    const [rows] = await conn.query('SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?, ?)', [ALIAS_KEY, SETTING_KEY]);
    const done = rows.find((r) => r.setting_key === ALIAS_KEY);
    const menu = rows.find((r) => r.setting_key === SETTING_KEY);
    if (done) return 'done-before';
    if (!menu || /skipped-empty/.test(String(menu.setting_value))) return 'no-printed-menu';
    await conn.beginTransaction();
    try {
      const added = await applyExtraAliases(conn);
      await conn.query('INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)', [ALIAS_KEY, JSON.stringify({ added })]);
      await conn.commit();
      require('../models/productModel').invalidateCatalog();
      logger.info(`Menu aliases applied: ${added} added`);
      return 'applied';
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    }
  } catch (err) {
    logger.error('Menu aliases failed', err);
    return 'failed';
  } finally {
    if (conn) {
      if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [ALIAS_LOCK]).catch(() => {});
      conn.release();
    }
  }
}

module.exports = { CATEGORIES, MENU, EXTRA_ALIASES, RETIRED_DEMO_SKUS, RETIRED_CATEGORIES, ownSku, aliasesFor, applyMenu, applyExtraAliases, retireUnlisted, runMenuSeed, ensureMenuSeed, ensureMenuAliases };
