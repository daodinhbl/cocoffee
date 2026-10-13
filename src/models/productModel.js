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
            p.stock_mode, p.inventory_item_id, p.is_active
       FROM products p JOIN categories c ON c.id = p.category_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.sort_order, p.name`,
    params
  );
  return rows;
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

async function create({ category_id, sku, name, price, stock_mode, inventory_item_id }, conn) {
  const [res] = await db(conn).query(
    `INSERT INTO products (category_id, sku, name, price, stock_mode, inventory_item_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [category_id, sku, name, price, stock_mode, inventory_item_id ?? null]
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

module.exports = {
  list, getById, getManyByIds, create, update, setRecipe, setAliases,
  getStockSpecs, listForMatching, invalidateCatalog,
};
