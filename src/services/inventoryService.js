const env = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');
const inventoryModel = require('../models/inventoryModel');
const productModel = require('../models/productModel');

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Inventory deduction + COGS for a finalized order. MUST run inside the caller's transaction:
 * if anything throws (e.g. INSUFFICIENT_STOCK) the caller rolls back and no stock moves.
 *
 *  - stock_mode 'bom'    -> every recipe line, quantity * ordered qty
 *  - stock_mode 'direct' -> inventory_item_id, 1:1 with ordered qty
 *  - COGS per unit       -> sum(qty_per_unit * avg_cost) read AFTER the row lock, so concurrent
 *                           sales/receipts can't skew it.
 *
 * @param conn   transaction connection
 * @param order  orders row
 * @param items  order_items rows
 * @returns {Promise<{ cogsTotal:number, lines:Array<{itemId,unitCogs,lineCogs}> }>}
 */
async function consumeForOrder(conn, order, items) {
  const specs = await productModel.getStockSpecs([...new Set(items.map((i) => i.product_id))], conn);

  // 1. per order line: which inventory rows, how much per ONE unit sold
  const plan = items.map((item) => {
    const spec = specs.get(item.product_id);
    let parts = [];
    if (!spec) {
      logger.warn(`consumeForOrder: product ${item.product_id} no longer exists (order ${order.id})`);
    } else if (spec.stock_mode === 'direct') {
      if (spec.inventory_item_id) parts = [{ inventory_item_id: spec.inventory_item_id, quantity: 1 }];
    } else {
      parts = spec.recipe;
    }
    if (!parts.length) logger.warn(`consumeForOrder: product ${item.product_id} has no recipe/inventory link; COGS=0`);
    return { item, parts };
  });

  // 2. total requirement per inventory row
  const required = new Map();
  for (const { item, parts } of plan) {
    for (const p of parts) {
      required.set(p.inventory_item_id, (required.get(p.inventory_item_id) || 0) + p.quantity * item.quantity);
    }
  }

  // 3. lock (ascending id) and verify
  const stock = await inventoryModel.lockByIds([...required.keys()], conn);
  if (!env.business.allowNegativeStock) {
    const short = [];
    for (const [id, need] of required) {
      const row = stock.get(id);
      if (!row || row.quantity_on_hand < need) {
        short.push({ inventory_item_id: id, name: row ? row.name : `#${id}`, needed: round(need, 3), available: row ? row.quantity_on_hand : 0, unit: row?.unit });
      }
    }
    if (short.length) {
      const shortIds = new Set(short.map((s) => s.inventory_item_id));
      const products = plan.filter(({ parts }) => parts.some((p) => shortIds.has(p.inventory_item_id))).map(({ item }) => item.product_name);
      throw new AppError(409, 'INSUFFICIENT_STOCK',
        `Insufficient stock: ${short.map((s) => s.name).join(', ')}`, { short, products: [...new Set(products)] });
    }
  }

  // 4. COGS at current moving-average cost, then deduct + write ledger
  const lines = plan.map(({ item, parts }) => {
    const unitCogs = parts.reduce((sum, p) => sum + p.quantity * (stock.get(p.inventory_item_id)?.avg_cost || 0), 0);
    return { itemId: item.id, unitCogs: round(unitCogs, 4), lineCogs: round(unitCogs * item.quantity, 2) };
  });

  for (const [id, need] of required) {
    const row = stock.get(id);
    if (!row) continue; // dangling link; nothing to deduct
    const balance = round(row.quantity_on_hand - need, 3);
    await inventoryModel.setStock(id, balance, row.avg_cost, conn);
    await inventoryModel.addMovement({
      inventoryItemId: id, type: 'sale', quantityChange: -round(need, 3), unitCost: row.avg_cost,
      balanceAfter: balance, orderId: order.id, note: order.order_code,
    }, conn);
  }

  return { cogsTotal: round(lines.reduce((s, l) => s + l.lineCogs, 0), 2), lines };
}

/** Stock-in with moving weighted-average cost. Runs inside the caller's transaction. */
async function receive(conn, itemId, quantity, unitCost, { userId = null, note = null } = {}) {
  const row = (await inventoryModel.lockByIds([itemId], conn)).get(itemId);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Inventory item not found');
  const base = Math.max(row.quantity_on_hand, 0);
  const balance = round(row.quantity_on_hand + quantity, 3);
  const avg = base + quantity > 0 ? round((base * row.avg_cost + quantity * unitCost) / (base + quantity), 4) : unitCost;
  await inventoryModel.setStock(itemId, balance, avg, conn);
  await inventoryModel.addMovement({
    inventoryItemId: itemId, type: 'purchase', quantityChange: quantity, unitCost,
    balanceAfter: balance, note, userId,
  }, conn);
  return { quantity_on_hand: balance, avg_cost: avg };
}

/** Stocktake / waste: set the counted quantity (type 'adjustment') or remove waste. */
/**
 * Stock count. `expectedQuantity` is the figure the count was made against (the app sends what it showed); when the
 * stock has moved since — an offline count replayed later, another device selling meanwhile — the difference the
 * count found is applied to the current stock instead of overwriting it, so those movements are kept.
 */
async function adjust(conn, itemId, newQuantity, { type = 'adjustment', userId = null, note = null, expectedQuantity } = {}) {
  const row = (await inventoryModel.lockByIds([itemId], conn)).get(itemId);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Inventory item not found');
  const current = Number(row.quantity_on_hand);
  let target = newQuantity;
  let reconciled = false;
  if (expectedQuantity !== undefined && expectedQuantity !== null && round(Number(expectedQuantity) - current, 3) !== 0) {
    target = Math.max(0, round(current + (newQuantity - Number(expectedQuantity)), 3));
    reconciled = true;
    note = `${note ? `${note} ` : ''}(đếm ${newQuantity} khi máy ghi ${expectedQuantity}, hệ thống ${current})`.slice(0, 255);
  }
  const delta = round(target - current, 3);
  await inventoryModel.setStock(itemId, target, row.avg_cost, conn);
  await inventoryModel.addMovement({
    inventoryItemId: itemId, type, quantityChange: delta, unitCost: row.avg_cost,
    balanceAfter: target, note, userId,
  }, conn);
  return { quantity_on_hand: target, delta, ...(reconciled ? { reconciled: true, counted: newQuantity, expected_quantity: Number(expectedQuantity) } : {}) };
}

/**
 * Admin stock list (Web Admin > Nguyên liệu and GET /api/inventory?all=1): every item, inactive included, and the
 * total value of the ACTIVE items at moving-average cost.
 */
async function listWithValue() {
  const items = await inventoryModel.listAll();
  return { items, stockValue: items.filter((i) => i.is_active).reduce((sum, i) => sum + Number(i.stock_value || 0), 0) };
}

module.exports = { consumeForOrder, receive, adjust, listWithValue };
