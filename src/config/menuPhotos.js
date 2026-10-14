const fs = require('fs');
const path = require('path');
const env = require('./env');
const logger = require('../utils/logger');
const { normalize } = require('../utils/text');

/**
 * Illustration photos shipped with the app in public/menu/ (tracked in git, so a redeploy keeps them, unlike
 * public/uploads). File names are the slug of the item name: "Cà Phê Sữa Dừa" -> public/menu/ca-phe-sua-dua.jpg,
 * ingredients in public/menu/ingredients/. Assigned at every boot to products and ingredients that have no photo
 * yet; a photo chosen in the admin (/media/..., /uploads/...) is never replaced.
 */
const PHOTO_DIR = path.join(env.rootDir, 'public', 'menu');
const EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.svg'];

const slugify = (s) => normalize(s).replace(/ /g, '-');

/** Products whose SKU says more than the name (demo SKUs renamed by the menu seed, retail goods). */
const PRODUCT_BY_SKU = {
  'CF-SUA-DA': 'ca-phe-sua', 'CF-DEN-DA': 'ca-phe-den', 'BAC-XIU': 'bac-xiu', 'TRA-DAO': 'tra-dao', 'TRA-DA': 'tra-da',
  555: 'thuoc-la-555', MARLBORO: 'thuoc-la-marlboro', THANGLONG: 'thuoc-la-thang-long',
  AQUAFINA: 'nuoc-aquafina-500ml', LAVIE: 'nuoc-lavie-500ml',
};

/** slug (with "ingredients/" prefix for that folder) -> public URL, for the files that really exist. */
function listPhotos(dir = PHOTO_DIR) {
  const out = new Map();
  for (const sub of ['', 'ingredients']) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const file of names) {
      const ext = path.extname(file).toLowerCase();
      if (!EXTS.includes(ext)) continue;
      const key = (sub ? `${sub}/` : '') + file.slice(0, -ext.length);
      if (!out.has(key)) out.set(key, `/menu/${sub ? `${sub}/` : ''}${file}`);
    }
  }
  return out;
}

const productPhoto = (photos, p) => photos.get(PRODUCT_BY_SKU[p.sku]) || photos.get(slugify(p.name)) || null;
// Retail goods are both an ingredient and a product: fall back to the product photo of the same name.
const ingredientPhoto = (photos, i) => photos.get(`ingredients/${slugify(i.name)}`) || photos.get(slugify(i.name)) || null;

/**
 * Needs a photo: never had one (NULL), or a shipped /menu/ photo whose file is gone. '' means the admin removed
 * the photo on purpose and stays empty; admin uploads (/media/, /uploads/) are left alone.
 */
const wants = (url, shipped) => url == null || (url.startsWith('/menu/') && !shipped.has(url));

/**
 * Give every product / ingredient without a photo the matching shipped illustration (and drop /menu/ links to
 * files that no longer exist, so the admin shows the initial instead of a broken image).
 * @returns {Promise<{products:number, ingredients:number}>} rows changed
 */
async function assignMenuPhotos(conn, { dir } = {}) {
  const photos = listPhotos(dir);
  const shipped = new Set(photos.values());
  const changed = { products: 0, ingredients: 0 };
  const tables = [
    ['products', 'SELECT id, sku, name, image_url FROM products', productPhoto],
    ['inventory_items', 'SELECT id, sku, name, image_url FROM inventory_items', ingredientPhoto],
  ];
  for (const [table, sql, pick] of tables) {
    const [rows] = await conn.query(sql);
    for (const row of rows) {
      if (!wants(row.image_url, shipped)) continue;
      const url = pick(photos, row);
      if ((url || null) === (row.image_url || null)) continue;
      await conn.query(`UPDATE ${table} SET image_url = ? WHERE id = ?`, [url, row.id]);
      changed[table === 'products' ? 'products' : 'ingredients'] += 1;
    }
  }
  return changed;
}

/** Boot step (cheap: two SELECTs when nothing changed); never throws. */
async function ensureMenuPhotos() {
  const { pool } = require('./db');
  try {
    const changed = await assignMenuPhotos(pool);
    if (changed.products) require('../models/productModel').invalidateCatalog();
    if (changed.products || changed.ingredients) {
      logger.info(`Menu photos: ${changed.products} product(s), ${changed.ingredients} ingredient(s) updated`);
    }
    return changed;
  } catch (err) {
    logger.error('Menu photos failed', err);
    return null;
  }
}

module.exports = { assignMenuPhotos, ensureMenuPhotos, listPhotos, slugify, PRODUCT_BY_SKU, PHOTO_DIR };
