const { withTransaction } = require('../../config/db');
const inventoryModel = require('../../models/inventoryModel');
const inventoryService = require('../../services/inventoryService');
const adminModel = require('../../models/adminModel');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render, formFlag, optional } = require('./common');

async function page(req, res) {
  const items = await inventoryModel.listAll();
  await render(res, 'inventory', {
    title: 'Nguyên liệu', activeMenu: 'inventory', breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Nguyên liệu' }],
  }, {
    items,
    onlyLow: req.query.low === '1',
    stockValue: items.filter((i) => i.is_active).reduce((s, i) => s + Number(i.stock_value || 0), 0),
  });
}

async function detail(req, res) {
  const id = v.id(req.params.id);
  const item = await inventoryModel.getById(id);
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nguyên liệu.');
  await render(res, 'inventory_detail', {
    title: item.name, activeMenu: 'inventory',
    breadcrumbs: [{ label: 'Nguyên liệu', href: '/admin/inventory' }, { label: item.name }],
  }, { item, movements: await inventoryModel.movements(id, 200) });
}

async function create(req) {
  const b = req.body;
  const quantity = v.num(optional(b.quantity_on_hand), 'Tồn đầu kỳ', { required: false }) || 0;
  const cost = v.num(optional(b.avg_cost), 'Giá vốn', { required: false }) || 0;
  const name = v.str(b.name, 'Tên', { max: 150 });
  // Opening stock at cost 0 would zero the COGS of every drink using it and drag down later average cost.
  if (quantity > 0 && !(cost > 0)) throw new AppError(400, 'VALIDATION', 'Nhập giá vốn (đ/đơn vị) cho tồn đầu kỳ.');
  await withTransaction(async (conn) => {
    const id = await inventoryModel.create({
      sku: v.str(b.sku, 'Mã SKU', { max: 40 }),
      name,
      unit: v.str(b.unit, 'Đơn vị', { max: 20 }),
      quantity_on_hand: 0,
      avg_cost: 0,
      min_stock: v.num(optional(b.min_stock), 'Tồn tối thiểu', { required: false }),
      is_active: formFlag(b.is_active),
    }, conn);
    if (quantity > 0) await inventoryService.receive(conn, id, quantity, cost, { userId: req.user.id, note: 'Tồn đầu kỳ' });
  });
  return { message: `Đã thêm nguyên liệu ${name}.` };
}

async function update(req) {
  const id = v.id(req.params.id);
  if (!(await inventoryModel.getById(id))) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nguyên liệu.');
  await inventoryModel.update(id, {
    name: v.str(optional(req.body.name), 'Tên', { max: 150, required: false }),
    unit: v.str(optional(req.body.unit), 'Đơn vị', { max: 20, required: false }),
    min_stock: v.num(optional(req.body.min_stock), 'Tồn tối thiểu', { required: false }),
    is_active: formFlag(req.body.is_active),
  });
  return { message: 'Đã cập nhật nguyên liệu.' };
}

/** Stocktake (set the counted quantity) or waste. */
async function adjust(req) {
  const id = v.id(req.params.id);
  const result = await withTransaction((conn) => inventoryService.adjust(conn, id, v.num(req.body.new_quantity, 'Số lượng thực tế', { min: 0 }), {
    type: v.oneOf(optional(req.body.type), 'Loại', ['adjustment', 'waste'], { required: false }) || 'adjustment',
    userId: req.user.id,
    note: v.str(optional(req.body.note), 'Ghi chú', { max: 255, required: false }),
  }));
  return { message: result.delta === 0 ? 'Số lượng không đổi.' : `Đã điều chỉnh tồn kho (${result.delta > 0 ? '+' : ''}${result.delta}).` };
}

// ------------------------------------------------------------------ receiving
async function receivingPage(req, res) {
  const [items, recent] = await Promise.all([inventoryModel.list(), adminModel.recentPurchases(30)]);
  const preselect = Number(req.query.item) || 0;
  await render(res, 'receiving', {
    title: 'Nhập kho', activeMenu: 'receiving', breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Nhập kho' }],
  }, { items, recent, preselect: items.some((i) => i.id === preselect) ? preselect : 0 });
}

async function receive(req) {
  const id = v.id(req.body.inventory_item_id, 'Nguyên liệu');
  const quantity = v.num(req.body.quantity, 'Số lượng', { min: 0.001 });
  const result = await withTransaction((conn) => inventoryService.receive(conn, id, quantity, v.num(req.body.unit_cost, 'Đơn giá nhập', { min: 0 }), {
    userId: req.user.id,
    note: v.str(optional(req.body.note), 'Ghi chú', { max: 255, required: false }),
  }));
  return { message: `Đã nhập kho. Tồn mới: ${result.quantity_on_hand}, giá vốn bình quân: ${Math.round(result.avg_cost)}đ.` };
}

module.exports = { page, detail, create, update, adjust, receivingPage, receive };
