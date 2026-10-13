const { withTransaction } = require('../../config/db');
const categoryModel = require('../../models/categoryModel');
const productModel = require('../../models/productModel');
const inventoryModel = require('../../models/inventoryModel');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render, formFlag, optional } = require('./common');

/** Textarea "a, b\nc" -> ['a','b','c'] (the model de-duplicates by normalized form). */
function parseAliases(raw) {
  if (typeof raw !== 'string') return [];
  const list = raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length > 30 || list.some((a) => a.length > 100)) throw new AppError(400, 'VALIDATION', 'Tối đa 30 từ khóa, mỗi từ khóa tối đa 100 ký tự.');
  return list;
}

async function page(_req, res) {
  const [products, categories, items] = await Promise.all([
    productModel.listForAdmin(), categoryModel.list({ activeOnly: false }), inventoryModel.listAll(),
  ]);
  await render(res, 'menu', {
    title: 'Thực đơn', activeMenu: 'menu', breadcrumbs: [{ label: 'Vận hành', href: '#' }, { label: 'Thực đơn' }],
  }, { products, categories, items: items.filter((i) => i.is_active) });
}

// ---------------------------------------------------------------- categories
async function createCategory(req) {
  const code = v.str(req.body.code, 'Mã nhóm', { max: 30 }).toLowerCase();
  if (!/^[a-z0-9_]+$/.test(code)) throw new AppError(400, 'VALIDATION', 'Mã nhóm chỉ gồm chữ thường, số và dấu gạch dưới.');
  await categoryModel.create({
    code,
    name: v.str(req.body.name, 'Tên nhóm', { max: 100 }),
    sort_order: v.num(optional(req.body.sort_order), 'Thứ tự', { min: -1000, max: 1000, integer: true, required: false }),
    is_active: formFlag(req.body.is_active),
  });
  productModel.invalidateCatalog();
  return { message: 'Đã thêm nhóm món.' };
}

async function updateCategory(req) {
  await categoryModel.update(v.id(req.params.id), {
    name: v.str(optional(req.body.name), 'Tên nhóm', { max: 100, required: false }),
    sort_order: v.num(optional(req.body.sort_order), 'Thứ tự', { min: -1000, max: 1000, integer: true, required: false }),
    is_active: formFlag(req.body.is_active),
  });
  productModel.invalidateCatalog();
  return { message: 'Đã cập nhật nhóm món.' };
}

// ------------------------------------------------------------------ products
/** Retail goods (cigarettes, bottled water): sold 1:1 from one inventory item. Drinks are created on the BOM page. */
async function createProduct(req) {
  const b = req.body;
  const name = v.str(b.name, 'Tên món', { max: 150 });
  const aliases = parseAliases(b.aliases);
  await withTransaction(async (conn) => {
    const id = await productModel.create({
      category_id: v.id(b.category_id, 'Nhóm'),
      sku: v.str(b.sku, 'Mã SKU', { max: 40 }),
      name,
      price: v.num(b.price, 'Giá bán', { min: 0 }),
      stock_mode: 'direct',
      inventory_item_id: v.id(b.inventory_item_id, 'Hàng tồn kho'),
      is_active: formFlag(b.is_active),
    }, conn);
    await productModel.setAliases(id, name, aliases, conn);
  });
  return { message: `Đã thêm ${name}.` };
}

async function updateProduct(req) {
  const id = v.id(req.params.id);
  const b = req.body;
  const current = await productModel.getById(id);
  if (!current) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy món.');
  const name = v.str(b.name, 'Tên món', { max: 150 });
  const direct = current.stock_mode === 'direct';
  const aliases = parseAliases(b.aliases);

  await withTransaction(async (conn) => {
    await productModel.update(id, {
      category_id: v.id(b.category_id, 'Nhóm'),
      name,
      price: v.num(b.price, 'Giá bán', { min: 0 }),
      stock_mode: current.stock_mode,
      inventory_item_id: direct ? v.id(optional(b.inventory_item_id) ?? current.inventory_item_id, 'Hàng tồn kho') : null,
      is_active: formFlag(b.is_active),
    }, conn);
    await productModel.setAliases(id, name, aliases, conn);
  });
  return { message: `Đã cập nhật ${name}.` };
}

module.exports = { page, createCategory, updateCategory, createProduct, updateProduct, parseAliases };
