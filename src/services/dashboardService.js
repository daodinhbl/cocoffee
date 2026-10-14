const orderModel = require('../models/orderModel');
const inventoryModel = require('../models/inventoryModel');
const adminModel = require('../models/adminModel');
const { shopDay, dayBounds } = require('../utils/shopTime');

/**
 * Numbers of the "Tổng quan" screen, shared by the Web Admin dashboard and GET /api/admin/dashboard.
 * Raw numbers and dates only; each client formats them.
 */
const ratioOf = (qty, min) => (Number(min) > 0 ? Number(qty) / Number(min) : 0);
const ratioOrNull = (qty, min) => (Number(min) > 0 ? Number(qty) / Number(min) : null);

async function build(now = new Date()) {
  const today = shopDay(now);
  const t = dayBounds(today, today);
  const yesterday = shopDay(now, -1);
  const y = dayBounds(yesterday, yesterday);
  const m = dayBounds(shopDay(now, -29), today);                    // last 30 days, today included
  const [cur, prev, counts, recent, low, hours, best, stock, debtors] = await Promise.all([
    orderModel.summary(t.from, t.to),
    orderModel.summary(y.from, y.to),
    adminModel.queueCounts(),
    orderModel.list({ limit: 5 }),
    inventoryModel.list({ lowStockOnly: true }),
    adminModel.salesByHour(t.from, t.to),
    adminModel.topProducts(m.from, m.to, 8),
    inventoryModel.listAll(),
    adminModel.topDebtors(6),
  ]);

  return {
    day: today,
    today: cur,
    yesterday: prev,
    margin: cur.revenue > 0 ? (cur.gross_profit / cur.revenue) * 100 : 0,
    counts,
    recentOrders: recent,
    low,                                                             // every active item at or below its minimum
    lowStock: low.map((i) => ({ id: i.id, name: i.name, unit: i.unit, quantity_on_hand: Number(i.quantity_on_hand), min_stock: Number(i.min_stock), ratio: ratioOf(i.quantity_on_hand, i.min_stock) }))
      .sort((a, b) => a.ratio - b.ratio).slice(0, 8),
    // 06:00-22:00 opening hours, empty hours included so the chart keeps its shape
    hourly: Array.from({ length: 17 }, (_, i) => { const h = i + 6; const r = hours.find((x) => Number(x.hour) === h); return { hour: h, revenue: r ? Number(r.revenue) : 0, orders: r ? Number(r.orders) : 0 }; }),
    bestSellers: best.map((p) => ({ product_id: p.product_id, product_name: p.product_name, qty: Number(p.qty), revenue: Number(p.revenue) })),
    // Most capital tied up in stock (quantity x moving-average cost), active items only
    overstock: stock.filter((i) => i.is_active && Number(i.stock_value) > 0)
      .map((i) => ({ id: i.id, name: i.name, unit: i.unit, qty: Number(i.quantity_on_hand), value: Number(i.stock_value), cover: ratioOrNull(i.quantity_on_hand, i.min_stock) }))
      .sort((a, b) => b.value - a.value).slice(0, 8),
    debtors: debtors.map((d) => ({
      customer_id: d.customer_id ?? null, customer_name: d.customer_name ?? null, customer_phone: d.customer_phone || null,
      zalo_user_id: d.zalo_user_id ?? null, orders: Number(d.orders), amount: Number(d.amount), oldest: d.oldest ?? null,
    })),
  };
}

module.exports = { build };
