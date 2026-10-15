const posService = require('../../services/posService');
const printerSettings = require('../../services/printerSettings');
const { zaloStatus } = require('../../services/zalo/zaloStatus');

/** POS screen of the app (cashier and admin): same data and rules as the Web Admin POS (services/posService). */

const printerForPos = (p) => ({ autoPrint: p.autoPrint, vatRate: p.showVat ? p.vatRate : 0, paperMm: p.paperMm });

/** GET /api/pos/bootstrap */
async function bootstrap(_req, res) {
  const [{ categories, products, tables, drafts, printer }, zalo] = await Promise.all([posService.bootstrap(), zaloStatus()]);
  res.json({
    categories: categories.map((c) => ({ id: c.id, code: c.code, name: c.name })),
    products: products.map((p) => ({ id: p.id, category_id: p.category_id, name: p.name, price: Number(p.price), image_url: p.image_url ?? null })),
    tables: tables.map((t) => ({
      id: t.id, code: t.code, name: t.name, status: t.status,
      current_order_id: t.current_order_id ?? null, current_order_total: t.current_order_total == null ? null : Number(t.current_order_total),
    })),
    drafts,
    zalo,
    printer: printerForPos(printer),
  });
}

/**
 * POST /api/pos/checkout { table_id?, order_id?, items: [{ product_id, quantity, note? }], note?, discount?,
 * method: cash|transfer|card, tendered? } -> { order, change }. A just-created order whose payment fails is cancelled.
 */
async function checkout(req, res) {
  const cart = posService.readCart(req.body);
  const payment = posService.readPayment(req.body);
  res.json(await posService.checkout(cart, payment, req.user.id, req.user.role === 'admin'));
}

/** POST /api/pos/hold: same cart, no payment; needs table_id or order_id -> { order } */
async function hold(req, res) {
  const { order } = await posService.hold(posService.readCart(req.body), req.user.id);
  res.json({ order });
}

/** GET /api/settings/printer (any staff): receipt printer settings for printing from the tablet. */
async function printer(_req, res) {
  res.json({ printer: await printerSettings.get() });
}

module.exports = { bootstrap, checkout, hold, printer };
