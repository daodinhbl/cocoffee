const tableModel = require('../models/tableModel');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');

async function list(_req, res) {
  res.json({ tables: await tableModel.list() });
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
  if (!(await tableModel.getById(id))) throw new AppError(404, 'NOT_FOUND', 'Table not found');
  await tableModel.update(id, {
    code: v.str(req.body.code, 'code', { max: 20, required: false }),
    name: v.str(req.body.name, 'name', { max: 60, required: false }),
    capacity: v.num(req.body.capacity, 'capacity', { min: 1, max: 100, integer: true, required: false }),
    is_active: v.flag(req.body.is_active),
  });
  res.json({ table: await tableModel.getById(id) });
}

module.exports = { list, create, update };
