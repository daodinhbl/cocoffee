const { withTransaction } = require('../config/db');
const categoryModel = require('../models/categoryModel');
const productModel = require('../models/productModel');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');
const menuRules = require('../services/menuRules');

// ------------------------------------------------------------------ categories
async function listCategories(req, res) {
  res.json({ categories: await categoryModel.list({ activeOnly: req.query.all !== '1' }) });
}

/** Same rules as the Web Admin: the code is lowercased (a-z, 0-9, _), and the chatbot catalog is refreshed. */
async function createCategory(req, res) {
  const id = await categoryModel.create({
    code: menuRules.categoryCode(req.body.code, 'code'),
    name: v.str(req.body.name, 'name', { max: 100 }),
    sort_order: v.num(req.body.sort_order, 'sort_order', { min: -1000, max: 1000, integer: true, required: false }),
  });
  productModel.invalidateCatalog();
  res.status(201).json({ id });
}

async function updateCategory(req, res) {
  await categoryModel.update(v.id(req.params.id), {
    name: v.str(req.body.name, 'name', { max: 100, required: false }),
    sort_order: v.num(req.body.sort_order, 'sort_order', { min: -1000, max: 1000, integer: true, required: false }),
    is_active: v.flag(req.body.is_active),
  });
  productModel.invalidateCatalog();
  res.json({ ok: true });
}

// ------------------------------------------------------------------ products
async function listProducts(req, res) {
  res.json({
    products: await productModel.list({
      categoryId: req.query.category_id ? v.id(req.query.category_id, 'category_id') : undefined,
      activeOnly: req.query.all !== '1',
    }),
  });
}

async function getProduct(req, res) {
  const product = await productModel.getById(v.id(req.params.id));
  if (!product) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  res.json({ product });
}

/** Recipe lines are only legal for 'bom'; 'direct' needs inventory_item_id (1:1 deduction). */
function readStockConfig(body, { stock_mode, inventory_item_id }) {
  const mode = v.oneOf(body.stock_mode ?? stock_mode, 'stock_mode', ['bom', 'direct']);
  let itemId = null;
  let recipe;
  if (mode === 'direct') {
    itemId = v.id(body.inventory_item_id ?? inventory_item_id, 'inventory_item_id');
  } else if (body.recipe !== undefined) {
    if (!Array.isArray(body.recipe) || !body.recipe.length) v.fail('recipe must be a non-empty array for stock_mode=bom');
    // like the BOM page: duplicate lines of one ingredient merged, 4 decimals, at most 50 lines
    recipe = menuRules.mergeRecipe(body.recipe, { item: 'recipe.inventory_item_id', qty: 'recipe.quantity' });
  }
  return { mode, itemId, recipe };
}

async function createProduct(req, res) {
  const b = req.body;
  const { mode, itemId, recipe } = readStockConfig(b, {});
  if (mode === 'bom' && !recipe) v.fail('recipe is required for stock_mode=bom');
  const name = v.str(b.name, 'name', { max: 150 });
  const aliases = b.aliases === undefined || b.aliases === null ? [] : menuRules.checkAliases(b.aliases);

  const id = await withTransaction(async (conn) => {
    const productId = await productModel.create({
      category_id: v.id(b.category_id, 'category_id'),
      sku: v.str(b.sku, 'sku', { max: 40 }),
      name,
      price: v.num(b.price, 'price', { min: 0 }),
      stock_mode: mode,
      inventory_item_id: itemId,
    }, conn);
    if (recipe) await productModel.setRecipe(productId, recipe, conn);
    await productModel.setAliases(productId, name, aliases, conn);
    return productId;
  });
  res.status(201).json({ product: await productModel.getById(id) });
}

async function updateProduct(req, res) {
  const id = v.id(req.params.id);
  const b = req.body;
  const current = await productModel.getById(id);
  if (!current) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  const { mode, itemId, recipe } = readStockConfig(b, current);
  if (mode === 'bom' && current.stock_mode === 'direct' && !recipe) v.fail('recipe is required when switching to stock_mode=bom');
  const aliases = b.aliases === undefined || b.aliases === null ? undefined : menuRules.checkAliases(b.aliases);

  await withTransaction(async (conn) => {
    await productModel.update(id, {
      category_id: v.num(b.category_id, 'category_id', { min: 1, integer: true, required: false }),
      name: v.str(b.name, 'name', { max: 150, required: false }),
      price: v.num(b.price, 'price', { min: 0, required: false }),
      stock_mode: mode,
      inventory_item_id: itemId,
      is_active: v.flag(b.is_active),
    }, conn);
    if (mode === 'direct') await productModel.setRecipe(id, [], conn);
    else if (recipe) await productModel.setRecipe(id, recipe, conn);
    if (aliases !== undefined || b.name !== undefined) {
      await productModel.setAliases(id, b.name ?? current.name, aliases ?? current.aliases, conn);
    }
  });
  res.json({ product: await productModel.getById(id) });
}

module.exports = { listCategories, createCategory, updateCategory, listProducts, getProduct, createProduct, updateProduct };
