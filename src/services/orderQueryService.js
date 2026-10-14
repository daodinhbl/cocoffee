const orderModel = require('../models/orderModel');

/**
 * The order list behind Web Admin > Đơn hàng and GET /api/orders: one place turns the filters into the model's
 * WHERE, so the page and the app show the same rows, totals and per-status counts.
 */
const PAGE_SIZE = 25;
const STATUSES = ['draft', 'open', 'completed', 'cancelled'];
const SOURCES = ['pos', 'zalo'];
const PAYMENTS = ['unpaid', 'paid'];

/**
 * Normalized filter -> orderModel filter.
 * @param {{status?, source?, payment?, tableId?, from?, to?, q?, updatedAfter?}} f  from/to are DATETIME bounds
 */
function toWhere(f = {}) {
  return {
    status: f.status, source: f.source, paymentStatus: f.payment, tableId: f.tableId, q: f.q || undefined,
    // "Chưa thu" means money still to collect: cancelled orders and unconfirmed Zalo drafts never will be.
    excludeStatuses: f.payment === 'unpaid' && !f.status ? ['cancelled', 'draft'] : undefined,
    from: f.from, to: f.to, updatedAfter: f.updatedAfter,
  };
}

/**
 * One page of orders plus the totals. `page` is clamped to the last page (as the web list does).
 * counts = orderModel.breakdown: { all, draft, open, completed, cancelled, unpaid, revenue, unpaidAmount, openAmount }
 */
async function page(filter, { page: wanted = 1, pageSize = PAGE_SIZE } = {}) {
  const where = toWhere(filter);
  const [total, counts] = await Promise.all([orderModel.count(where), orderModel.breakdown(where)]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, wanted), pages);
  const orders = await orderModel.list({ ...where, limit: pageSize, offset: (current - 1) * pageSize });
  return { orders, total, page: current, pages, pageSize, counts };
}

module.exports = { toWhere, page, PAGE_SIZE, STATUSES, SOURCES, PAYMENTS };
