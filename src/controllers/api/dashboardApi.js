const dashboardService = require('../../services/dashboardService');
const reportService = require('../../services/reportService');
const { shopDay } = require('../../utils/shopTime');

/** Admin analytics: "Tổng quan" and "Báo cáo", from the same services as the Web Admin pages. */

const summaryOf = (s) => ({
  orders: Number(s.orders) || 0, revenue: Number(s.revenue) || 0, cogs: Number(s.cogs) || 0,
  gross_profit: Number(s.gross_profit) || 0, unpaid: Number(s.unpaid) || 0,
});

/** GET /api/admin/dashboard */
async function dashboard(_req, res) {
  const d = await dashboardService.build();
  res.json({
    day: d.day,
    today: summaryOf(d.today),
    yesterday: summaryOf(d.yesterday),
    margin: d.margin,
    counts: { drafts: Number(d.counts.drafts) || 0, open_orders: Number(d.counts.open_orders) || 0, unpaid: Number(d.counts.unpaid) || 0 },
    recent_orders: d.recentOrders,
    low_stock: d.lowStock,
    low_stock_count: d.low.length,                     // low_stock is the 8 most urgent; the web badge counts them all
    hourly: d.hourly,
    best_sellers: d.bestSellers,
    overstock: d.overstock,
    debtors: d.debtors,
  });
}

/** GET /api/admin/reports?from=&to= (inclusive shop days; invalid / reversed / > 366 days -> last 7 days, clamped) */
async function reports(req, res) {
  const r = await reportService.build(req.query, shopDay());
  const n = (x) => Number(x) || 0;
  res.json({
    range: { from: r.range.from, to: r.range.to, clamped: r.clamped },
    presets: r.presets,
    summary: summaryOf(r.summary),
    avg_ticket: r.avgTicket,
    margin: r.margin,
    days: r.days.map((d) => ({ day: d.day, orders: n(d.orders), revenue: n(d.revenue), cogs: n(d.cogs) })),
    hours: r.hours.map((h) => ({ hour: n(h.hour), orders: n(h.orders), revenue: n(h.revenue) })),
    by_source: r.bySource.map((s) => ({ source: s.source, orders: n(s.orders), revenue: n(s.revenue), cogs: n(s.cogs) })),
    by_payment: r.byPayment.map((p) => ({ method: p.method, orders: n(p.orders), revenue: n(p.revenue) })),
    top_products: r.top.map((p) => ({ product_id: p.product_id, product_name: p.product_name, qty: n(p.qty), revenue: n(p.revenue), cogs: n(p.cogs) })),
  });
}

module.exports = { dashboard, reports };
