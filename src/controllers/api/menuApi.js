const productModel = require('../../models/productModel');
const inventoryModel = require('../../models/inventoryModel');
const imageStore = require('../../services/imageStore');
const menuPage = require('../admin/menu');
const bomPage = require('../admin/bom');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');

/** Menu, BOM and photos for the admin screens of the app (same data as the Web Admin pages). */

/** GET /api/admin/menu -> { products (whole menu, aliases included), categories (inactive too), items (active stock) } */
async function menu(_req, res) {
  res.json(await menuPage.pageData());
}

/** GET /api/admin/bom -> { drinks, retail, stats: { total, missing, avgMargin }, categories, catalog } */
async function bom(_req, res) {
  const d = await bomPage.pageData();
  res.json({ drinks: d.drinks, retail: d.retail, stats: d.stats, categories: d.categories, catalog: d.catalog });
}

const TARGETS = {
  products: { model: productModel, folder: 'products', missing: 'Product not found' },
  inventory: { model: inventoryModel, folder: 'ingredients', missing: 'Inventory item not found' },
};

async function target(kind, req) {
  const t = TARGETS[kind];
  const id = v.id(req.params.id);
  const row = await t.model.getById(id);
  if (!row) throw new AppError(404, 'NOT_FOUND', t.missing);
  return { ...t, id, row };
}

/** PUT /api/admin/{products|inventory}/:id/image { image_data: 'data:image/jpeg|png|webp;base64,...' } -> { image_url } */
const setImage = (kind) => async (req, res) => {
  const { model, folder, id, row } = await target(kind, req);
  if (typeof req.body.image_data !== 'string' || !req.body.image_data) v.fail('image_data is required');
  imageStore.decode(req.body.image_data);                         // reject a bad picture before touching anything
  const url = await imageStore.applyFromForm({ image_data: req.body.image_data }, {
    dirKey: folder, id, name: row.name, currentUrl: row.image_url || null, setImage: model.setImage,
  });
  res.json({ image_url: url });
};

/**
 * DELETE /api/admin/{products|inventory}/:id/image -> { image_url: '' }. '' (not NULL) means "removed by the admin",
 * so the shipped illustration given to items without a photo is not put back at the next start.
 */
const removeImage = (kind) => async (req, res) => {
  const { model, folder, id, row } = await target(kind, req);
  if (row.image_url) {
    await imageStore.applyFromForm({ image_remove: '1' }, { dirKey: folder, id, name: row.name, currentUrl: row.image_url, setImage: model.setImage });
  } else if (row.image_url !== '') {
    await model.setImage(id, '');
  }
  res.json({ image_url: '' });
};

module.exports = { menu, bom, setImage, removeImage };
