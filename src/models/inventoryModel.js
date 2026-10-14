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

async function movements(itemId, limit = 100, conn) {
  const [rows] = await db(conn).query(
    `SELECT id, movement_type, quantity_change, unit_cost, balance_after, order_id, note, created_at
       FROM inventory_movements WHERE inventory_item_id = ? ORDER BY id DESC LIMIT ?`,
    [itemId, Math.min(Number(limit) || 100, 500)]
  );
  return rows;
}

/** Photo of an ingredient (null clears it). */
async function setImage(id, url, conn) {
  await db(conn).query('UPDATE inventory_items SET image_url = ? WHERE id = ?', [url, id]);
}

module.exports = {
  setImage, list, listAll, getById, lockByIds, create, update, setStock, addMovement, movements };
