const tableModel = require('../models/tableModel');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');

/** GET /tables: active tables (POS). ?all=1 (admin): inactive ones too, with is_active. */
async function list(req, res) {
  if (req.query.all === '1') {
    if (req.user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
    return res.json({ tables: await tableModel.listAll() });
  }
  return res.json({ tables: await tableModel.list() });
}

async function create(req, res) {
  const id = await tableModel.create({
    code: v.str(req.body.code, 'code', { max: 20 }),
    name: v.str(req.body.name, 'name', { max: 60 }),
    capacity: v.num(req.body.capacity, 'capacity', { min: 1, max: 100, integer: true, required: false }),
  });
  res.status(201).json({ table: await tableModel.getById(id) });
}

async function update(req, res) {
  const id = v.id(req.params.id);
  const table = await tableModel.getById(id);
  if (!table) throw new AppError(404, 'NOT_FOUND', 'Table not found');
  const isActive = v.flag(req.body.is_active);
  // Same rule as the Web Admin: a table with an open order cannot be taken out of service.
  if (isActive === 0 && table.status === 'serving') {
    throw new AppError(409, 'CONFLICT', 'Table has an open order: pay or cancel it before deactivating the table', { current_order_id: table.current_order_id ?? null });
  }
  await tableModel.update(id, {
    code: v.str(req.body.code, 'code', { max: 20, required: false }),
    name: v.str(req.body.name, 'name', { max: 60, required: false }),
    capacity: v.num(req.body.capacity, 'capacity', { min: 1, max: 100, integer: true, required: false }),
    is_active: isActive,
  });
  res.json({ table: await tableModel.getById(id) });
}

module.exports = { list, create, update };
