const customerModel = require('../models/customerModel');
const { shopDay, parseDay, dayBounds } = require('../utils/shopTime');

/**
 * Customer list, debt reconciliation and statement data, shared by the Web Admin pages and /api/admin/customers.
 */
const PAGE_SIZE = 25;

/** Parse and sanitise query-string filter params (anything invalid is ignored). */
function readFilters(query = {}) {
  return {
    q: typeof query.q === 'string' ? query.q.trim().slice(0, 60) : '',
    debtOnly: query.debt === '1',
    zaloOnly: query.zalo === '1',
    page: Math.max(1, Math.min(10000, parseInt(query.page, 10) || 1)),
  };
}

/** One page of customers (page clamped to the last one) + the header stats. */
async function listPage(f) {
  const filterOpts = { q: f.q || undefined, debtOnly: f.debtOnly, zaloOnly: f.zaloOnly };
  const [total, stats] = await Promise.all([customerModel.count(filterOpts), customerModel.summary()]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const customers = await customerModel.list({ ...filterOpts, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  return { customers, stats, total, page, pages, pageSize: PAGE_SIZE };
}

/** ?from=&to= (YYYY-MM-DD, shop days, inclusive). Default: this month so far; a reversed range is swapped. */
function readPeriod(query = {}) {
  const today = shopDay();
  let from = parseDay(query.from) || `${today.slice(0, 8)}01`;
  let to = parseDay(query.to) || today;
  if (from > to) [from, to] = [to, from];
  return { from, to, bounds: dayBounds(from, to) };
}

function presets() {
  const today = shopDay();
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = shopDay(new Date(`${monthStart}T12:00:00Z`), -1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 8)}01`;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  return [
    { key: 'month', label: 'Tháng này', from: monthStart, to: today },
    { key: 'last_month', label: 'Tháng trước', from: lastMonthStart, to: lastMonthEnd },
    { key: 'year', label: 'Năm nay', from: yearStart, to: today },
  ];
}

/** Opening / increase / decrease / closing per customer over the period, plus the column totals. */
async function reconciliation(query = {}) {
  const period = readPeriod(query);
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 60) : '';
  const rows = await customerModel.reconciliation(period.bounds.from, period.bounds.to, { q: q || undefined });
  const totals = rows.reduce((t, r) => ({ opening: t.opening + r.opening, increase: t.increase + r.increase, decrease: t.decrease + r.decrease, closing: t.closing + r.closing }),
    { opening: 0, increase: 0, decrease: 0, closing: 0 });
  return { period, q, rows, totals, presets: presets() };
}

module.exports = { readFilters, listPage, readPeriod, presets, reconciliation, PAGE_SIZE };
