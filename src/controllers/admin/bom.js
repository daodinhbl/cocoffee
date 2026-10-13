const { withTransaction } = require('../../config/db');
const productModel = require('../../models/productModel');
const categoryModel = require('../../models/categoryModel');
const inventoryModel = require('../../models/inventoryModel');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render } = require('./common');

async function page(_req, res) {
  const [products, categories, items] = await Promise.all([
    productModel.listWithCost(), categoryModel.list(), inventoryModel.listAll(),
  ]);
  const drinks = products.filter((p) => p.stock_mode === 'bom');
  const retail = products.filter((p) => p.stock_mode === 'direct');
  const avgMargin = products.length ? products.reduce((s, p) => s + p.margin, 0) / products.length : 0;

  await render(res, 'bom_recipes', {
    title: 'Quản lý định mức (BOM)', activeMenu: 'bom',
    breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Công thức (BOM)' }],
  }, {
    drinks, retail, categories,
    stats: { total: products.length, missing: products.filter((p) => !p.ingredients.length).length, avgMargin },
    // what the dialog offers: raw materials with their current moving-average cost per base unit. Inactive
    // items are included so an existing recipe line that uses one still shows (and survives a save).
    catalog: { drink: items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, unitCost: i.avg_cost, active: Boolean(i.is_active) })) },
  });
}

/** body.recipe = JSON '[{"inventory_item_id":1,"quantity":18}]' -> validated lines, duplicates merged. */
function readRecipe(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (!Array.isArray(parsed) || !parsed.length) throw new AppError(400, 'VALIDATION', 'Công thức cần ít nhất một nguyên liệu.');
  if (parsed.length > 50) throw new AppError(400, 'VALIDATION', 'Công thức tối đa 50 dòng.');
  const merged = new Map();
  for (const l of parsed) {
    const id = v.id(l?.inventory_item_id, 'Nguyên liệu');
    const qty = v.num(l?.quantity, 'Định lượng', { min: 0.0001, max: 1e7 });
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  return [...merged].map(([inventory_item_id, quantity]) => ({ inventory_item_id, quantity: Math.round(quantity * 1e4) / 1e4 }));
}

async function create(req) {
  const b = req.body;
  const recipe = readRecipe(b.recipe);
  const name = v.str(b.name, 'Tên món', { max: 150 });
  await withTransaction(async (conn) => {
    const id = await productModel.create({
      category_id: v.id(b.category_id, 'Nhóm'),
      sku: v.str(b.sku, 'Mã SKU', { max: 40 }),
      name,
      price: v.num(b.price, 'Giá bán', { min: 0 }),
      stock_mode: 'bom',
      inventory_item_id: null,
    }, conn);
    await productModel.setRecipe(id, recipe, conn);
    await productModel.setAliases(id, name, [], conn);
  });
  return { message: `Đã thêm công thức ${name}.` };
}

async function update(req) {
  const id = v.id(req.params.id);
  const b = req.body;
  const current = await productModel.getById(id);
  if (!current) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy món.');
  if (current.stock_mode !== 'bom') throw new AppError(409, 'CONFLICT', 'Hàng bán lẻ không có công thức, hãy sửa ở trang Thực đơn.');
  const recipe = readRecipe(b.recipe);
  const name = v.str(b.name, 'Tên món', { max: 150 });

  await withTransaction(async (conn) => {
    await productModel.update(id, {
      category_id: v.id(b.category_id, 'Nhóm'),
      name,
      price: v.num(b.price, 'Giá bán', { min: 0 }),
      stock_mode: 'bom',
      inventory_item_id: null,
      is_active: 1,
    }, conn);
    await productModel.setRecipe(id, recipe, conn);
    // renaming: the chat keyword for the old name goes away, the new name is always a keyword
    const kept = name === current.name ? current.aliases : current.aliases.filter((a) => a !== current.name);
    await productModel.setAliases(id, name, kept, conn);
  });
  return { message: `Đã lưu công thức ${name}.` };
}

/** "Delete" = take the dish off the menu. Past orders keep pointing at it, so the row itself stays. */
async function remove(req) {
  const id = v.id(req.params.id);
  const current = await productModel.getById(id);
  if (!current) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy món.');
  await productModel.setActive(id, false);
  return { message: `Đã ngừng bán ${current.name}. Bật lại ở trang Thực đơn.` };
}

module.exports = { page, create, update, remove, readRecipe };
