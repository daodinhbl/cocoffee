const orderModel = require('../../models/orderModel');
const inventoryModel = require('../../models/inventoryModel');
const adminModel = require('../../models/adminModel');
const { shopDay, dayBounds } = require('../../utils/shopTime');
const { pct } = require('../../utils/viewHelpers');
const { render } = require('./common');

const rangeFor = (day) => dayBounds(day, day);

/** "+12,4% so với hôm qua" / "Hôm qua chưa có doanh thu" */
function revenueDelta(now, before) {
  if (!(before > 0)) return { delta: 'Hôm qua chưa có doanh thu', tone: 'neutral' };
  const change = ((now - before) / before) * 100;
  return { delta: `${change >= 0 ? '+' : '−'}${pct(Math.abs(change))} so với hôm qua`, tone: change >= 0 ? 'good' : 'warn' };
}

async function dashboard(req, res) {
  const today = shopDay();
  const t = rangeFor(today);
  const y = rangeFor(shopDay(new Date(), -1));
  const m = dayBounds(shopDay(new Date(), -29), today);              // last 30 days, today included
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

  const margin = cur.revenue > 0 ? (cur.gross_profit / cur.revenue) * 100 : 0;
  const kpis = [
    { key: 'revenue', icon: 'chart', label: 'Doanh thu hôm nay', value: cur.revenue, ...revenueDelta(cur.revenue, prev.revenue) },
    { key: 'cogs', icon: 'box', label: 'Giá vốn (COGS)', value: cur.cogs, delta: cur.revenue > 0 ? `${pct((cur.cogs / cur.revenue) * 100)} doanh thu` : 'Chưa có đơn hoàn tất', tone: 'neutral' },
    { key: 'profit', icon: 'check', label: 'Lãi gộp', value: cur.gross_profit, delta: cur.revenue > 0 ? `${pct(margin)} biên lợi nhuận` : '—', tone: cur.revenue > 0 && margin >= 55 ? 'good' : 'neutral' },
    { key: 'unpaid', icon: 'receipt', label: 'Đơn chờ thu', value: counts.unpaid, plain: true, delta: `${counts.drafts} đơn Zalo chờ khách xác nhận · ${counts.open_orders} đang phục vụ`, tone: counts.unpaid > 0 ? 'warn' : 'neutral' },
  ];

  await render(res, 'dashboard', {
    title: 'Tổng quan', activeMenu: 'dashboard', breadcrumbs: [{ label: 'Tổng quan' }],
  }, {
    kpis, ordersToday: cur.orders, recentOrders: recent, lowStock: low, counts, margin,
    // 06:00-22:00 opening hours, empty hours included so the chart keeps its shape
    hourly: Array.from({ length: 17 }, (_, i) => { const h = i + 6; const r = hours.find((x) => Number(x.hour) === h); return { hour: h, revenue: r ? Number(r.revenue) : 0, orders: r ? Number(r.orders) : 0 }; }),
    charts: {
      bestSellers: best.map((p) => ({ name: p.product_name, qty: Number(p.qty), revenue: Number(p.revenue) })),
      lowStock: low.map((i) => ({ id: i.id, name: i.name, unit: i.unit, qty: Number(i.quantity_on_hand), min: Number(i.min_stock), ratio: Number(i.min_stock) > 0 ? Number(i.quantity_on_hand) / Number(i.min_stock) : 0 }))
        .sort((a, b) => a.ratio - b.ratio).slice(0, 8),
      // Most capital tied up in stock (quantity x moving-average cost), active items only
      overstock: stock.filter((i) => i.is_active && Number(i.stock_value) > 0)
        .map((i) => ({ id: i.id, name: i.name, unit: i.unit, qty: Number(i.quantity_on_hand), value: Number(i.stock_value), cover: Number(i.min_stock) > 0 ? Number(i.quantity_on_hand) / Number(i.min_stock) : null }))
        .sort((a, b) => b.value - a.value).slice(0, 8),
      debtors: debtors.map((d) => ({ who: d.customer_name || `Khách Zalo …${String(d.zalo_user_id).slice(-4)}`, phone: d.customer_phone || null, orders: Number(d.orders), amount: Number(d.amount), oldest: d.oldest })),
    },
    greetingName: (req.user && (req.user.full_name || req.user.username)) || '',
  });
}

module.exports = { dashboard, revenueDelta };
