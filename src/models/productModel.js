const { pool } = require('../config/db');
const { normalize } = require('../utils/text');

const db = (conn) => conn || pool;

// ---- catalog cache used by the Zalo parser (hit on every chat message) -----------------
const CACHE_TTL_MS = 60 * 1000;
let catalogCache = { at: 0, rows: null };
const invalidateCatalog = () => { catalogCache = { at: 0, rows: null }; };

async function list({ categoryId, activeOnly = true } = {}, conn) {
  const where = [];
  const params = [];
  if (activeOnly) where.push('p.is_active = 1');
  if (categoryId) { where.push('p.category_id = ?'); params.push(categoryId); }
  const [rows] = await db(conn).query(
    `SELECT p.id, p.category_id, c.name AS category_name, p.sku, p.name, p.price,
            p.stock_mode, p.inventory_item_id, p.is_active, p.image_url, p.tax_category_id
       FROM products p JOIN categories c ON c.id = p.category_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.sort_order, p.name`,
    params
  );
  return rows;
}

/** Tax group of a product (NULL = automatic: retail goods vs prepared drinks). Applies to sales from now on. */
async function setTaxCategory(id, taxCategoryId, conn) {
  await db(conn).query('UPDATE products SET tax_category_id = ? WHERE id = ?', [taxCategoryId || null, id]);
}

async function getById(id, conn) {
  const [rows] = await db(conn).query('SELECT * FROM products WHERE id = ? LIMIT 1', [id]);
  if (!rows[0]) return null;
  const [recipe] = await db(conn).query(
    `SELECT r.inventory_item_id, i.name AS inventory_item_name, i.unit, r.quantity
       FROM recipes r JOIN inventory_items i ON i.id = r.inventory_item_id
      WHERE r.product_id = ? ORDER BY r.id`,
    [id]
  );
  const [aliases] = await db(conn).query('SELECT alias FROM product_aliases WHERE product_id = ? ORDER BY id', [id]);
  return { ...rows[0], recipe, aliases: aliases.map((a) => a.alias) };
}

async function getManyByIds(ids, conn) {
  if (!ids.length) return [];
  const [rows] = await db(conn).query('SELECT * FROM products WHERE id IN (?)', [ids]);
  return rows;
}

/** Is this SKU taken (case-insensitive, like the UNIQUE key)? */
async function skuExists(sku, conn) {
  const [rows] = await db(conn).query('SELECT 1 FROM products WHERE sku = ? LIMIT 1', [sku]);
  return rows.length > 0;
}

async function create({ category_id, sku, name, price, stock_mode, inventory_item_id, is_active }, conn) {
  const [res] = await db(conn).query(
    `INSERT INTO products (category_id, sku, name, price, stock_mode, inventory_item_id, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [category_id, sku, name, price, stock_mode, inventory_item_id ?? null, is_active ?? 1]
  );
  invalidateCatalog();
  return res.insertId;
}

async function update(id, { category_id, name, price, stock_mode, inventory_item_id, is_active }, conn) {
  await db(conn).query(
    `UPDATE products
        SET category_id = COALESCE(?, category_id), name = COALESCE(?, name), price = COALESCE(?, price),
            stock_mode = COALESCE(?, stock_mode), inventory_item_id = ?, is_active = COALESCE(?, is_active)
      WHERE id = ?`,
    [category_id ?? null, name ?? null, price ?? null, stock_mode ?? null, inventory_item_id ?? null, is_active ?? null, id]
  );
  invalidateCatalog();
}

async function setActive(id, active, conn) {
  await db(conn).query('UPDATE products SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
  invalidateCatalog();
}

/** Admin view of the whole menu (inactive included) with the stock link name and chat keywords. */
async function listForAdmin(conn) {
  const [rows] = await db(conn).query(
    `SELECT p.id, p.category_id, c.name AS category_name, p.sku, p.name, p.price, p.stock_mode,
            p.inventory_item_id, i.name AS inventory_item_name, p.is_active, p.image_url
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN inventory_items i ON i.id = p.inventory_item_id
      ORDER BY p.is_active DESC, c.sort_order, p.name`
  );
  const [aliases] = await db(conn).query('SELECT product_id, alias FROM product_aliases ORDER BY id');
  const byProduct = new Map();
  for (const a of aliases) {
    if (!byProduct.has(a.product_id)) byProduct.set(a.product_id, []);
    byProduct.get(a.product_id).push(a.alias);
  }
  return rows.map((r) => ({ ...r, aliases: byProduct.get(r.id) || [] }));
}

/**
 * BOM screen data. Every ACTIVE product with its cost lines at the current moving-average cost:
 * 'bom' products -> one line per recipe row; 'direct' products -> the single linked inventory item (qty 1).
 */
async function listWithCost(conn) {
  const [products] = await db(conn).query(
    `SELECT p.id, p.category_id, c.name AS category_name, p.sku, p.name, p.price, p.stock_mode, p.inventory_item_id, p.image_url
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = 1 ORDER BY c.sort_order, p.name`
  );
  const [lines] = await db(conn).query(
    `SELECT r.product_id, r.inventory_item_id, i.name, i.unit, i.avg_cost, r.quantity
       FROM recipes r JOIN inventory_items i ON i.id = r.inventory_item_id
       JOIN products p ON p.id = r.product_id AND p.is_active = 1
      ORDER BY r.id`
  );
  const [direct] = await db(conn).query(
    `SELECT p.id AS product_id, i.id AS inventory_item_id, i.name, i.unit, i.avg_cost
       FROM products p JOIN inventory_items i ON i.id = p.inventory_item_id
      WHERE p.is_active = 1 AND p.stock_mode = 'direct'`
  );
  const byProduct = new Map(products.map((p) => [p.id, []]));
  for (const l of lines) byProduct.get(l.product_id)?.push(l);
  for (const d of direct) byProduct.get(d.product_id)?.push({ ...d, quantity: 1 });
  return products.map((p) => {
    const ingredients = (byProduct.get(p.id) || []).map((l) => ({
      ref: l.inventory_item_id, name: l.name, unit: l.unit, qty: l.quantity, cost: l.quantity * l.avg_cost,
    }));
    const cogs = ingredients.reduce((s, g) => s + g.cost, 0);
    return { ...p, ingredients, cogs, margin: p.price > 0 ? ((p.price - cogs) / p.price) * 100 : 0 };
  });
}

/** Replace the BOM of a product. lines: [{ inventory_item_id, quantity }] */
async function setRecipe(productId, lines, conn) {
  await db(conn).query('DELETE FROM recipes WHERE product_id = ?', [productId]);
  if (lines.length) {
    await db(conn).query(
      'INSERT INTO recipes (product_id, inventory_item_id, quantity) VALUES ?',
      [lines.map((l) => [productId, l.inventory_item_id, l.quantity])]
    );
  }
}

/** Replace chat keywords. The product name is always included. */
async function setAliases(productId, name, aliases, conn) {
  const unique = new Map();
  for (const a of [name, ...(aliases || [])]) {
    const norm = normalize(a);
    if (norm && !unique.has(norm)) unique.set(norm, String(a).trim());
  }
  // a keyword can belong to one product only: say which one holds it, before anything is deleted
  const [taken] = await db(conn).query(
    `SELECT a.alias, p.name FROM product_aliases a JOIN products p ON p.id = a.product_id WHERE a.alias_norm IN (?) AND a.product_id <> ? LIMIT 1`,
    [[...unique.keys()], productId]
  );
  if (taken && taken[0]) {
    const { AppError } = require('../utils/httpError');
    throw new AppError(409, 'DUPLICATE', `Từ khóa "${taken[0].alias}" đang thuộc món "${taken[0].name}". Bỏ từ khóa đó ở món kia trước, hoặc dùng từ khóa khác.`);
  }
  await db(conn).query('DELETE FROM product_aliases WHERE product_id = ?', [productId]);
  await db(conn).query(
    'INSERT INTO product_aliases (product_id, alias, alias_norm) VALUES ?',
    [[...unique].map(([norm, alias]) => [productId, alias, norm])]
  );
  invalidateCatalog();
}

/**
 * Stock behaviour for a set of products, with locking-free reads (callers lock inventory rows).
 * @returns {Map<number,{stock_mode,inventory_item_id,recipe:Array<{inventory_item_id,quantity}>}>}
 */
async function getStockSpecs(productIds, conn) {
  const specs = new Map();
  if (!productIds.length) return specs;
  const [products] = await db(conn).query(
    'SELECT id, stock_mode, inventory_item_id FROM products WHERE id IN (?)', [productIds]);
  for (const p of products) specs.set(p.id, { stock_mode: p.stock_mode, inventory_item_id: p.inventory_item_id, recipe: [] });
  const [lines] = await db(conn).query(
    'SELECT product_id, inventory_item_id, quantity FROM recipes WHERE product_id IN (?)', [productIds]);
  for (const l of lines) specs.get(l.product_id)?.recipe.push({ inventory_item_id: l.inventory_item_id, quantity: l.quantity });
  return specs;
}

/** Active products + normalized keywords for the chatbot matcher (cached 60s). */
async function listForMatching(conn) {
  if (catalogCache.rows && Date.now() - catalogCache.at < CACHE_TTL_MS) return catalogCache.rows;
  const [rows] = await db(conn).query(
    `SELECT p.id, p.name, p.price, c.name AS category_name, c.sort_order,
            GROUP_CONCAT(a.alias_norm SEPARATOR '\n') AS keywords
       FROM products p
       JOIN categories c ON c.id = p.category_id AND c.is_active = 1
       LEFT JOIN product_aliases a ON a.product_id = p.id
      WHERE p.is_active = 1
      GROUP BY p.id, p.name, p.price, c.name, c.sort_order
      ORDER BY c.sort_order, p.name`
  );
  const catalog = rows.map((r) => ({
    id: r.id, name: r.name, price: r.price, category_name: r.category_name,
    keywords: new Set([normalize(r.name), ...(r.keywords ? r.keywords.split('\n') : [])]),
  }));
  catalogCache = { at: Date.now(), rows: catalog };
  return catalog;
}

/** Photo shown on the POS card and in the admin: a URL, '' = removed by the admin, null = never set. */
async function setImage(id, url, conn) {
  await db(conn).query('UPDATE products SET image_url = ? WHERE id = ?', [url, id]);
  invalidateCatalog();
}

module.exports = {
  skuExists, setTaxCategory,
  setImage,
  list, listForAdmin, listWithCost, getById, getManyByIds, create, update, setActive, setRecipe, setAliases,
  getStockSpecs, listForMatching, invalidateCatalog,
};
