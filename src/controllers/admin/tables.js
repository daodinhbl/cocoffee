const tableModel = require('../../models/tableModel');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render, formFlag, optional } = require('./common');

async function page(_req, res) {
  await render(res, 'tables', {
    title: 'Bàn', activeMenu: 'tables', breadcrumbs: [{ label: 'Vận hành', href: '#' }, { label: 'Bàn' }],
  }, { tables: await tableModel.listAll() });
}

const SHAPES = ['square', 'round', 'long'];

/** Sơ đồ bàn 2.5D: the shop's floor as a tilted plan; tap a table to open it in the POS, "Sửa bố cục" to drag them. */
async function mapPage(_req, res) {
  const all = await tableModel.listAll();
  const tables = all.filter((t) => t.is_active);
  // Tables nobody placed yet sit on an automatic grid (the same one the editor starts from).
  const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
  const items = tables.map((t, i) => ({
    id: t.id, code: t.code, name: t.name, capacity: t.capacity, shape: t.map_shape || 'square',
    x: t.map_x != null ? t.map_x : Math.round(80 + (i % cols) * (840 / cols)),
    y: t.map_y != null ? t.map_y : Math.round(80 + Math.floor(i / cols) * (840 / Math.max(1, Math.ceil(tables.length / cols)))),
    placed: t.map_x != null,
    state: t.merged_into ? 'merged' : (t.status === 'serving' ? 'busy' : 'free'),
    order: t.current_order_code || null, total: t.current_order_total != null ? Number(t.current_order_total) : null, mergedInto: t.merged_into_name || null,
  }));
  await render(res, 'tables_map', {
    title: 'Sơ đồ bàn', activeMenu: 'tables', breadcrumbs: [{ label: 'Vận hành', href: '#' }, { label: 'Bàn', href: '/admin/tables' }, { label: 'Sơ đồ' }],
  }, { items, counts: { free: items.filter((i) => i.state === 'free').length, busy: items.filter((i) => i.state === 'busy').length, merged: items.filter((i) => i.state === 'merged').length } });
}

/** POST /admin/tables/layout (JSON { tables: [{ id, x, y, shape }] }, CSRF in a header). */
async function saveLayout(req, res) {
  const list = Array.isArray(req.body && req.body.tables) ? req.body.tables : null;
  if (!list || !list.length || list.length > 200) return res.status(400).json({ ok: false, error: 'Danh sách bàn không hợp lệ.' });
  const items = [];
  for (const t of list) {
    const id = Number(t.id), x = Math.round(Number(t.x)), y = Math.round(Number(t.y));
    if (!Number.isInteger(id) || id < 1 || !(x >= 0 && x <= 1000) || !(y >= 0 && y <= 1000) || !SHAPES.includes(t.shape)) {
      return res.status(400).json({ ok: false, error: 'Vị trí hoặc hình dạng bàn không hợp lệ.' });
    }
    items.push({ id, x, y, shape: t.shape });
  }
  await tableModel.saveLayout(items);
  return res.json({ ok: true, saved: items.length });
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

module.exports = { page, mapPage, saveLayout, create, update };
