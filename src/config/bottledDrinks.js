const { normalize } = require('../utils/text');

/**
 * Bottled soft drinks sold from the fridge, tracked in stock like cigarettes and bottled water: each one is a
 * stock item (SKU GD-…, unit "bottle", group "Hàng bán lẻ") and a 'direct' product in the group "Nước đóng chai"
 * that deducts exactly one bottle per sale. Photos: public/menu/<slug of the name>.jpg.
 *
 * Applied by scripts/seed-bottled-drinks.js (idempotent). `old` = the SKU the item had as a plain menu drink
 * (group "Nước ngọt", no stock): that product is converted in place so its order history and Zalo keywords survive.
 * Stock starts at 0: receive the first delivery in Web Admin > Nhập kho (one slip can hold all six).
 */
const BOTTLED = [
  { sku: 'GD-STING', old: 'MN-STING', name: 'Sting', price: 14000, aliases: ['sting dâu', 'sting đỏ', 'sting vàng'] },
  { sku: 'GD-NUMBER-ONE', old: 'MN-NUMBER-ONE', name: 'Number One', price: 14000, aliases: ['number 1', 'numberone', 'nước tăng lực number one'] },
  { sku: 'GD-REDBULL', old: 'MN-BO-CUNG-REDBULL', name: 'Bò Húc Thái (Redbull)', price: 20000, aliases: ['bò húc', 'bò cụng', 'bò cúng', 'redbull', 'red bull', 'bò húc thái'] },
  { sku: 'GD-WAKE-UP-24-7', old: 'MN-WAKE-UP-24-7', name: 'Wake Up 24/7', price: 14000, aliases: ['wake up', 'wakeup', 'wake up 247', 'wake up 24 7', '24/7', '247', 'cà phê lon wake up'] },
  { sku: 'GD-TRA-XANH-KHONG-DO', name: 'Trà Xanh Không Độ', price: 15000, aliases: ['trà xanh', 'trà xanh 0 độ', 'không độ', 'trà xanh không độ'] },
  { sku: 'GD-C2', name: 'C2', price: 15000, aliases: ['c2', 'trà c2', 'trà chanh c2'] },
];
const CATEGORY_CODE = 'bottled_water';
const UNIT = 'bottle';
const MIN_STOCK = 12;                       // warning level on the stock list (one case of 24, half)

const slugify = (s) => normalize(s).replace(/ /g, '-');

/**
 * Create or convert the six items inside `conn`'s transaction.
 * @returns {Promise<{ items: number, created: number, converted: number, aliases: number }>}
 */
async function applyBottledDrinks(conn) {
  const out = { items: 0, created: 0, converted: 0, aliases: 0 };
  const [[cat]] = await conn.query('SELECT id FROM categories WHERE code = ?', [CATEGORY_CODE]);
  if (!cat) throw new Error(`category ${CATEGORY_CODE} not found`);
  await conn.query('UPDATE categories SET is_active = 1 WHERE id = ?', [cat.id]);

  for (const d of BOTTLED) {
    // 1. stock item
    let [[item]] = await conn.query('SELECT id FROM inventory_items WHERE sku = ?', [d.sku]);
    if (!item) {
      const [res] = await conn.query(
        `INSERT INTO inventory_items (sku, name, unit, quantity_on_hand, avg_cost, min_stock, is_active, group_code)
         VALUES (?, ?, ?, 0, 0, ?, 1, 'retail')`,
        [d.sku, d.name, UNIT, MIN_STOCK]
      );
      item = { id: res.insertId };
      out.items += 1;
    }

    // 2. product: already converted / the old menu drink / same name -> update in place, else create
    const photo = `/menu/${slugify(d.name)}.jpg`;
    const [[bySku]] = await conn.query('SELECT id, image_url FROM products WHERE sku = ?', [d.sku]);
    const [[byOld]] = d.old ? await conn.query('SELECT id, image_url FROM products WHERE sku = ?', [d.old]) : [[undefined]];
    const [[byName]] = await conn.query('SELECT id, image_url FROM products WHERE is_active = 1 AND LOWER(name) = LOWER(?) AND stock_mode = ? LIMIT 1', [d.name, 'direct']);
    const product = bySku || byOld || byName;
    let productId;
    if (product) {
      productId = product.id;
      const keepPhoto = product.image_url && !product.image_url.startsWith('/menu/');     // an admin upload wins
      await conn.query(
        `UPDATE products SET category_id = ?, sku = ?, name = ?, price = ?, stock_mode = 'direct', inventory_item_id = ?, is_active = 1,
                image_url = ? WHERE id = ?`,
        [cat.id, d.sku, d.name, d.price, item.id, keepPhoto ? product.image_url : photo, productId]
      );
      out.converted += 1;
    } else {
      const [res] = await conn.query(
        `INSERT INTO products (category_id, sku, name, price, stock_mode, inventory_item_id, is_active, image_url)
         VALUES (?, ?, ?, ?, 'direct', ?, 1, ?)`,
        [cat.id, d.sku, d.name, d.price, item.id, photo]
      );
      productId = res.insertId;
      out.created += 1;
    }
    await conn.query('UPDATE inventory_items SET image_url = COALESCE(image_url, ?) WHERE id = ?', [photo, item.id]);

    // 3. keywords for Zalo orders ("2 sting", "1 redbull"): ours move to this product
    for (const alias of [d.name, ...d.aliases]) {
      const norm = normalize(alias);
      if (!norm) continue;
      const [res] = await conn.query(
        `INSERT INTO product_aliases (product_id, alias, alias_norm) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE product_id = VALUES(product_id), alias = VALUES(alias)`,
        [productId, alias, norm]
      );
      if (res.affectedRows) out.aliases += 1;
    }
  }
  return out;
}

module.exports = { BOTTLED, CATEGORY_CODE, applyBottledDrinks, slugify };
