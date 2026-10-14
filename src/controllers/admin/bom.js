const { withTransaction } = require('../../config/db');
const productModel = require('../../models/productModel');
const categoryModel = require('../../models/categoryModel');
const inventoryModel = require('../../models/inventoryModel');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render } = require('./common');
const imageStore = require('../../services/imageStore');
const menuRules = require('../../services/menuRules');

/** BOM screen data, shared with GET /api/admin/bom. */
async function pageData() {
  const [products, categories, items] = await Promise.all([
    productModel.listWithCost(), categoryModel.list(), inventoryModel.listAll(),
  ]);
  return {
    drinks: products.filter((p) => p.stock_mode === 'bom'),
    retail: products.filter((p) => p.stock_mode === 'direct'),
    categories,
    stats: {
      total: products.length,
      missing: products.filter((p) => !p.ingredients.length).length,
      avgMargin: products.length ? products.reduce((s, p) => s + p.margin, 0) / products.length : 0,
    },
    // what the dialog offers: raw materials with their current moving-average cost per base unit. Inactive
    // items are included so an existing recipe line that uses one still shows (and survives a save).
    catalog: items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, unitCost: i.avg_cost, active: Boolean(i.is_active) })),
  };
}

async function page(_req, res) {
  const { drinks, retail, categories, stats, catalog } = await pageData();

  await render(res, 'bom_recipes', {
    title: 'Quản lý định mức (BOM)', activeMenu: 'bom',
    breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Công thức (BOM)' }],
  }, {
    drinks, retail, categories, stats,
    catalog: { drink: catalog },
  });
}

/** body.recipe = JSON '[{"inventory_item_id":1,"quantity":18}]' -> validated lines, duplicates merged. */
function readRecipe(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  return menuRules.mergeRecipe(parsed);
}

async function create(req) {
  const b = req.body;
  const recipe = readRecipe(b.recipe);
  const name = v.str(b.name, 'Tên món', { max: 150 });
  if (b.image_data) imageStore.decode(b.image_data);              // reject a bad picture before writing anything
  let id;
  await withTransaction(async (conn) => {
    id = await productModel.create({
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
  await imageStore.applyFromForm(b, { dirKey: 'products', id, name, currentUrl: null, setImage: productModel.setImage });
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
  if (b.image_data) imageStore.decode(b.image_data);

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
  await imageStore.applyFromForm(b, { dirKey: 'products', id, name, currentUrl: current.image_url, setImage: productModel.setImage });
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

module.exports = { page, pageData, create, update, remove, readRecipe };
