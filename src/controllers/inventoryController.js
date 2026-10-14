const { withTransaction } = require('../config/db');
const inventoryModel = require('../models/inventoryModel');
const adminModel = require('../models/adminModel');
const inventoryService = require('../services/inventoryService');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');

const MOVEMENT_TYPES = ['purchase', 'sale', 'adjustment', 'waste', 'return'];
const USAGE_DAYS = 30;

/** GET /inventory: active items (?low=1: at or below minimum). ?all=1 (admin): every item + stock_value total. */
async function list(req, res) {
  if (req.query.all === '1') {
    if (req.user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
    const { items, stockValue } = await inventoryService.listWithValue();
    return res.json({ items, stock_value: stockValue });
  }
  return res.json({ items: await inventoryModel.list({ lowStockOnly: req.query.low === '1' }) });
}

/** GET /inventory/:id (admin): the item page: row, 30-day usage, the drinks using it, the latest 200 movements. */
async function get(req, res) {
  const id = v.id(req.params.id);
  const item = await inventoryModel.getById(id);
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Inventory item not found');
  const [usage, usedIn, movements] = await Promise.all([
    inventoryModel.usage(id, USAGE_DAYS), inventoryModel.usedIn(id), inventoryModel.movements(id, 200),
  ]);
  res.json({ item, usage, used_in: usedIn, movements });
}

/** GET /inventory/purchases (admin): latest stock receipts. ?limit= (default 30, capped at 200). */
async function purchases(req, res) {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 30));
  res.json({ purchases: await adminModel.recentPurchases(limit) });
}

async function create(req, res) {
  const b = req.body;
  const quantity = v.num(b.quantity_on_hand, 'quantity_on_hand', { required: false }) || 0;
  const cost = v.num(b.avg_cost, 'avg_cost', { required: false }) || 0;
  const id = await withTransaction(async (conn) => {
    const itemId = await inventoryModel.create({
      sku: v.str(b.sku, 'sku', { max: 40 }),
      name: v.str(b.name, 'name', { max: 150 }),
      unit: v.str(b.unit, 'unit', { max: 20 }),
      quantity_on_hand: 0,
      avg_cost: 0,
      min_stock: v.num(b.min_stock, 'min_stock', { required: false }),
    }, conn);
    if (quantity > 0) await inventoryService.receive(conn, itemId, quantity, cost, { userId: req.user.id, note: 'opening balance' });
    return itemId;
  });
  res.status(201).json({ item: await inventoryModel.getById(id) });
}

async function update(req, res) {
  const id = v.id(req.params.id);
  if (!(await inventoryModel.getById(id))) throw new AppError(404, 'NOT_FOUND', 'Inventory item not found');
  await inventoryModel.update(id, {
    name: v.str(req.body.name, 'name', { max: 150, required: false }),
    unit: v.str(req.body.unit, 'unit', { max: 20, required: false }),
    min_stock: v.num(req.body.min_stock, 'min_stock', { required: false }),
    is_active: v.flag(req.body.is_active),
  });
  res.json({ item: await inventoryModel.getById(id) });
}

/** Stock-in: updates quantity and the moving-average cost used for COGS. */
async function receive(req, res) {
  const id = v.id(req.params.id);
  const result = await withTransaction((conn) => inventoryService.receive(
    conn, id,
    v.num(req.body.quantity, 'quantity', { min: 0.001 }),
    v.num(req.body.unit_cost, 'unit_cost', { min: 0 }),
    { userId: req.user.id, note: v.str(req.body.note, 'note', { required: false }) }
  ));
  res.json(result);
}

/** Stocktake: set the counted quantity (or record waste with type=waste). */
async function adjust(req, res) {
  const id = v.id(req.params.id);
  const result = await withTransaction((conn) => inventoryService.adjust(
    conn, id,
    v.num(req.body.new_quantity, 'new_quantity', { min: 0 }),
    { type: v.oneOf(req.body.type, 'type', ['adjustment', 'waste'], { required: false }) || 'adjustment',
      userId: req.user.id, note: v.str(req.body.note, 'note', { required: false }) }
  ));
  res.json(result);
}

/** GET /inventory/:id/movements?limit=&type=purchase|sale|adjustment|waste|return */
async function movements(req, res) {
  const type = v.oneOf(req.query.type, 'type', MOVEMENT_TYPES, { required: false });
  res.json({ movements: await inventoryModel.movements(v.id(req.params.id), req.query.limit, undefined, { type }) });
}

module.exports = { list, get, purchases, create, update, receive, adjust, movements };
