const orderModel = require('../../models/orderModel');
const adminModel = require('../../models/adminModel');
const { shopDay, parseDay, addDays, dayBounds } = require('../../utils/shopTime');
const { render } = require('./common');

const MAX_DAYS = 366;

/** Quick ranges shown as chips above the report. */
function presets(today = shopDay()) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  return [
    { key: 'today', label: 'Hôm nay', from: today, to: today },
    { key: 'yesterday', label: 'Hôm qua', from: addDays(today, -1), to: addDays(today, -1) },
    { key: '7d', label: '7 ngày', from: addDays(today, -6), to: today },
    { key: 'month', label: 'Tháng này', from: monthStart, to: today },
    { key: 'last_month', label: 'Tháng trước', from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd },
  ];
}

/** ?from=&to= (inclusive days). Invalid / reversed / oversized ranges fall back to the last 7 days. */
function readRange(query, today = shopDay()) {
  const def = presets(today).find((p) => p.key === '7d');
  let from = parseDay(query.from);
  let to = parseDay(query.to);
  if (!from && !to) return { from: def.from, to: def.to };
  from = from || to;
  to = to || from;
  if (from > to) [from, to] = [to, from];
  if (addDays(from, MAX_DAYS - 1) < to) return { from: def.from, to: def.to, clamped: true };
  return { from, to };
}

async function page(req, res) {
  const today = shopDay();
  const range = readRange(req.query, today);
  const b = dayBounds(range.from, range.to);
  const [summary, byDay, byHour, bySource, byPayment, top] = await Promise.all([
    orderModel.summary(b.from, b.to),
    adminModel.salesByDay(b.from, b.to),
    adminModel.salesByHour(b.from, b.to),
    adminModel.salesBySource(b.from, b.to),
    adminModel.salesByPayment(b.from, b.to),
    adminModel.topProducts(b.from, b.to, 10),
  ]);

  // fill empty days so the bars show gaps instead of hiding them
  const dayMap = new Map(byDay.map((d) => [d.day, d]));
  const days = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    days.push(dayMap.get(d) || { day: d, orders: 0, revenue: 0, cogs: 0 });
  }
  const hourMap = new Map(byHour.map((h) => [h.hour, h]));
  const hours = Array.from({ length: 24 }, (_, hour) => hourMap.get(hour) || { hour, orders: 0, revenue: 0 });

  await render(res, 'reports', {
    title: 'Báo cáo', activeMenu: 'reports', breadcrumbs: [{ label: 'Phân tích', href: '#' }, { label: 'Báo cáo' }],
  }, {
    range, clamped: Boolean(range.clamped), presets: presets(today),
    summary, days, hours, bySource, byPayment, top,
    avgTicket: summary.orders ? summary.revenue / summary.orders : 0,
    margin: summary.revenue > 0 ? (summary.gross_profit / summary.revenue) * 100 : 0,
  });
}

module.exports = { page, readRange, presets, MAX_DAYS };
