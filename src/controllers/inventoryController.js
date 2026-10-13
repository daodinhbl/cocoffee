const { withTransaction } = require('../config/db');
const inventoryModel = require('../models/inventoryModel');
const inventoryService = require('../services/inventoryService');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');

async function list(req, res) {
  res.json({ items: await inventoryModel.list({ lowStockOnly: req.query.low === '1' }) });
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

async function movements(req, res) {
  res.json({ movements: await inventoryModel.movements(v.id(req.params.id), req.query.limit) });
}

module.exports = { list, create, update, receive, adjust, movements };
