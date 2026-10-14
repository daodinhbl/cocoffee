const { pool } = require('../config/db');

const db = (conn) => conn || pool;

async function list({ lowStockOnly = false } = {}, conn) {
  const [rows] = await db(conn).query(
    `SELECT id, sku, name, unit, quantity_on_hand, avg_cost, min_stock, is_active,
            (quantity_on_hand <= min_stock) AS is_low
       FROM inventory_items
      WHERE is_active = 1 ${lowStockOnly ? 'AND quantity_on_hand <= min_stock' : ''}
      ORDER BY name`
  );
  return rows;
}

/** Admin view: every item (inactive included) with the stock value at moving-average cost. */
async function listAll(conn) {
  const [rows] = await db(conn).query(
    `SELECT id, sku, name, unit, quantity_on_hand, avg_cost, min_stock, is_active,
            (quantity_on_hand <= min_stock) AS is_low, ROUND(quantity_on_hand * avg_cost, 2) AS stock_value, image_url
       FROM inventory_items ORDER BY is_active DESC, name`
  );
  return rows;
}

async function getById(id, conn, { forUpdate = false } = {}) {
  const [rows] = await db(conn).query(
    `SELECT * FROM inventory_items WHERE id = ? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id]
  );
  return rows[0] || null;
}

/** Lock rows in ascending id order (consistent order => no deadlocks between concurrent sales). */
async function lockByIds(ids, conn) {
  if (!ids.length) return new Map();
  const sorted = [...ids].sort((a, b) => a - b);
  const [rows] = await db(conn).query(
    'SELECT * FROM inventory_items WHERE id IN (?) ORDER BY id FOR UPDATE',
    [sorted]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function create({ sku, name, unit, quantity_on_hand, avg_cost, min_stock, is_active }, conn) {
  const [res] = await db(conn).query(
    `INSERT INTO inventory_items (sku, name, unit, quantity_on_hand, avg_cost, min_stock, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sku, name, unit, quantity_on_hand || 0, avg_cost || 0, min_stock || 0, is_active ?? 1]
  );
  return res.insertId;
}

async function update(id, { name, unit, min_stock, is_active }, conn) {
  await db(conn).query(
    `UPDATE inventory_items SET name = COALESCE(?, name), unit = COALESCE(?, unit),
            min_stock = COALESCE(?, min_stock), is_active = COALESCE(?, is_active) WHERE id = ?`,
    [name ?? null, unit ?? null, min_stock ?? null, is_active ?? null, id]
  );
}

async function setStock(id, quantity, avgCost, conn) {
  await db(conn).query(
    'UPDATE inventory_items SET quantity_on_hand = ?, avg_cost = ? WHERE id = ?',
    [quantity, avgCost, id]
  );
}

async function addMovement(
  { inventoryItemId, type, quantityChange, unitCost, balanceAfter, orderId = null, note = null, userId = null },
  conn
) {
  await db(conn).query(
    `INSERT INTO inventory_movements
       (inventory_item_id, movement_type, quantity_change, unit_cost, balance_after, order_id, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [inventoryItemId, type, quantityChange, unitCost, balanceAfter, orderId, note, userId]
  );
}

/** Ledger of one item, newest first. `type` optionally keeps one movement_type (purchase, sale, ...). */
async function movements(itemId, limit = 100, conn, { type } = {}) {
  const [rows] = await db(conn).query(
    `SELECT m.id, m.movement_type, m.quantity_change, m.unit_cost, m.balance_after, m.order_id, m.note, m.created_at,
            u.full_name AS created_by_name
       FROM inventory_movements m
       LEFT JOIN users u ON u.id = m.created_by
      WHERE m.inventory_item_id = ? ${type ? 'AND m.movement_type = ? ' : ''}ORDER BY m.id DESC LIMIT ?`,
    [itemId, ...(type ? [type] : []), Math.min(Number(limit) || 100, 500)]
  );
  return rows;
}

/**
 * What went through an item over the last `days` days: used = sold minus returned (positive number),
 * wasted = written off as waste, received = purchased; lastPurchase = the latest purchase ever.
 */
async function usage(itemId, days = 30, conn) {
  const [[sum]] = await db(conn).query(
    `SELECT COALESCE(-SUM(CASE WHEN movement_type IN ('sale', 'return') THEN quantity_change END), 0) AS used,
            COALESCE(-SUM(CASE WHEN movement_type = 'waste' AND quantity_change < 0 THEN quantity_change END), 0) AS wasted,
            COALESCE(SUM(CASE WHEN movement_type = 'purchase' THEN quantity_change END), 0) AS received
       FROM inventory_movements
      WHERE inventory_item_id = ? AND created_at >= NOW() - INTERVAL ? DAY`,
    [itemId, days]
  );
  const [[last]] = await db(conn).query(
    `SELECT quantity_change AS quantity, unit_cost, created_at FROM inventory_movements
      WHERE inventory_item_id = ? AND movement_type = 'purchase' ORDER BY id DESC LIMIT 1`,
    [itemId]
  );
  return { days, used: Math.max(0, Number(sum.used)), wasted: Number(sum.wasted), received: Number(sum.received), lastPurchase: last || null };
}

/** Products that consume the item: BOM lines (quantity per unit sold) and retail goods sold 1:1 from it. */
async function usedIn(itemId, conn) {
  const [rows] = await db(conn).query(
    `SELECT p.id, p.name, p.sku, p.price, p.is_active, p.image_url, p.stock_mode, r.quantity
       FROM recipes r JOIN products p ON p.id = r.product_id
      WHERE r.inventory_item_id = ?
     UNION ALL
     SELECT p.id, p.name, p.sku, p.price, p.is_active, p.image_url, p.stock_mode, 1 AS quantity
       FROM products p
      WHERE p.stock_mode = 'direct' AND p.inventory_item_id = ?
      ORDER BY is_active DESC, name`,
    [itemId, itemId]
  );
  return rows;
}

/** Photo of an ingredient: a URL, '' = removed by the admin, null = never set (menuPhotos may fill it). */
async function setImage(id, url, conn) {
  await db(conn).query('UPDATE inventory_items SET image_url = ? WHERE id = ?', [url, id]);
}

module.exports = {
  setImage, list, listAll, getById, lockByIds, create, update, setStock, addMovement, movements, usage, usedIn };
