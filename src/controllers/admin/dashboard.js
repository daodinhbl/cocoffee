const dashboardService = require('../../services/dashboardService');
const { pct } = require('../../utils/viewHelpers');
const { render } = require('./common');

/** "+12,4% so với hôm qua" / "Hôm qua chưa có doanh thu" */
function revenueDelta(now, before) {
  if (!(before > 0)) return { delta: 'Hôm qua chưa có doanh thu', tone: 'neutral' };
  const change = ((now - before) / before) * 100;
  return { delta: `${change >= 0 ? '+' : '−'}${pct(Math.abs(change))} so với hôm qua`, tone: change >= 0 ? 'good' : 'warn' };
}

async function dashboard(req, res) {
  const d = await dashboardService.build();
  const cur = d.today;
  const prev = d.yesterday;
  const { counts, margin } = d;
  const kpis = [
    { key: 'revenue', icon: 'chart', label: 'Doanh thu hôm nay', value: cur.revenue, ...revenueDelta(cur.revenue, prev.revenue) },
    { key: 'cogs', icon: 'box', label: 'Giá vốn (COGS)', value: cur.cogs, delta: cur.revenue > 0 ? `${pct((cur.cogs / cur.revenue) * 100)} doanh thu` : 'Chưa có đơn hoàn tất', tone: 'neutral' },
    { key: 'profit', icon: 'check', label: 'Lãi gộp', value: cur.gross_profit, delta: cur.revenue > 0 ? `${pct(margin)} biên lợi nhuận` : '—', tone: cur.revenue > 0 && margin >= 55 ? 'good' : 'neutral' },
    { key: 'unpaid', icon: 'receipt', label: 'Đơn chờ thu', value: counts.unpaid, plain: true, delta: `${counts.drafts} đơn Zalo chờ khách xác nhận · ${counts.open_orders} đang phục vụ`, tone: counts.unpaid > 0 ? 'warn' : 'neutral' },
  ];

  await render(res, 'dashboard', {
    title: 'Tổng quan', activeMenu: 'dashboard', breadcrumbs: [{ label: 'Tổng quan' }],
  }, {
    kpis, ordersToday: cur.orders, recentOrders: d.recentOrders, lowStock: d.low, counts, margin,
    hourly: d.hourly,
    charts: {
      bestSellers: d.bestSellers.map((p) => ({ name: p.product_name, qty: p.qty, revenue: p.revenue })),
      lowStock: d.lowStock.map((i) => ({ id: i.id, name: i.name, unit: i.unit, qty: i.quantity_on_hand, min: i.min_stock, ratio: i.ratio })),
      overstock: d.overstock,
      debtors: d.debtors.map((x) => ({ who: x.customer_name || `Khách Zalo …${String(x.zalo_user_id).slice(-4)}`, phone: x.customer_phone, orders: x.orders, amount: x.amount, oldest: x.oldest })),
    },
    greetingName: (req.user && (req.user.full_name || req.user.username)) || '',
  });
}

module.exports = { dashboard, revenueDelta };
