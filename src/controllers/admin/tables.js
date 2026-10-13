const tableModel = require('../../models/tableModel');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render, formFlag, optional } = require('./common');

async function page(_req, res) {
  await render(res, 'tables', {
    title: 'Bàn', activeMenu: 'tables', breadcrumbs: [{ label: 'Vận hành', href: '#' }, { label: 'Bàn' }],
  }, { tables: await tableModel.listAll() });
}

async function create(req) {
  const code = v.str(req.body.code, 'Mã bàn', { max: 20 });
  await tableModel.create({
    code,
    name: v.str(req.body.name, 'Tên bàn', { max: 60 }),
    capacity: v.num(optional(req.body.capacity), 'Sức chứa', { min: 1, max: 100, integer: true, required: false }),
  });
  return { message: `Đã thêm bàn ${code}.` };
}

async function update(req) {
  const id = v.id(req.params.id);
  const table = await tableModel.getById(id);
  if (!table) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy bàn.');
  const active = formFlag(req.body.is_active);
  if (active === 0 && table.status === 'serving') throw new AppError(409, 'CONFLICT', 'Bàn đang có đơn, hãy thanh toán hoặc hủy đơn trước khi ngừng sử dụng.');
  await tableModel.update(id, {
    code: v.str(optional(req.body.code), 'Mã bàn', { max: 20, required: false }),
    name: v.str(optional(req.body.name), 'Tên bàn', { max: 60, required: false }),
    capacity: v.num(optional(req.body.capacity), 'Sức chứa', { min: 1, max: 100, integer: true, required: false }),
    is_active: active,
  });
  return { message: 'Đã cập nhật bàn.' };
}

module.exports = { page, create, update };
