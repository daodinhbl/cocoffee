const customerModel = require('../../models/customerModel');
const customerService = require('../../services/customerService');
const customerQuery = require('../../services/customerQueryService');
const printerSettings = require('../../services/printerSettings');
const debtNotifications = require('../../services/zalo/debtNotificationService');
const paymentNotification = require('../../services/zalo/paymentNotificationService');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');

/** /api/admin/customers: customers, their debt ledger, collections, adjustments, reconciliation (admin only). */

const n = (x) => Number(x) || 0;

/** errno 1062 on customers -> 409 DUPLICATE with the field that collided. */
function duplicateError(err) {
  if (!err || err.errno !== 1062) return err;
  const text = String(err.sqlMessage || '');
  const field = text.includes('uq_customers_phone') ? 'phone' : text.includes('uq_customers_zalo') ? 'zalo_user_id' : null;
  const message = field === 'phone' ? 'Số điện thoại này đã được dùng cho khách hàng khác.'
    : field === 'zalo_user_id' ? 'Zalo ID này đã được liên kết với khách hàng khác.'
      : 'Thông tin bị trùng (số điện thoại hoặc Zalo ID đã tồn tại).';
  return new AppError(409, 'DUPLICATE', message, field ? { field } : undefined);
}

async function getOr404(id) {
  const customer = await customerModel.getById(id);
  if (!customer) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy khách hàng.');
  return customer;
}

/** GET /api/admin/customers?q=&debt=1&zalo=1&page= */
async function list(req, res) {
  const r = await customerQuery.listPage(customerQuery.readFilters(req.query));
  res.json({
    customers: r.customers.map((c) => ({ ...c, balance: n(c.balance), order_count: n(c.order_count) })),
    total: r.total, page: r.page, pages: r.pages, page_size: r.pageSize,
    stats: { total_customers: n(r.stats.total_customers), debt_customers: n(r.stats.debt_customers), total_debt: n(r.stats.total_debt) },
  });
}

/** GET /api/admin/customers/:id -> { customer, ledger (100 newest), orders (50 newest) } */
async function detail(req, res) {
  const id = v.id(req.params.id);
  const customer = await getOr404(id);
  const [ledger, orders] = await Promise.all([customerModel.ledgerHistory(id, 100), customerModel.orderHistory(id, 50)]);
  res.json({ customer, ledger, orders });
}

/** POST /api/admin/customers { name, phone?, zalo_user_id?, note? } -> 201 { customer } */
async function create(req, res) {
  const b = req.body;
  const name = v.str(b.name, 'name', { max: 120 });
  if (!name) v.fail('name is required');
  const fields = {
    name,
    phone: v.str(b.phone, 'phone', { max: 20, required: false }) || null,
    zalo_user_id: v.str(b.zalo_user_id, 'zalo_user_id', { max: 64, required: false }) || null,
    note: v.str(b.note, 'note', { max: 255, required: false }) || null,
  };
  let id;
  try {
    id = await customerModel.create(fields);
  } catch (err) {
    throw duplicateError(err);
  }
  res.status(201).json({ customer: await customerModel.getById(id) });
}

/** PUT /api/admin/customers/:id: only the fields sent change; null or '' clears phone / zalo_user_id / note. */
async function update(req, res) {
  const id = v.id(req.params.id);
  await getOr404(id);
  const b = req.body;
  const fields = {};
  if (b.name !== undefined && b.name !== null && b.name !== '') {
    fields.name = v.str(b.name, 'name', { max: 120 });
    if (!fields.name) v.fail('name is required');
  }
  for (const [key, max] of [['phone', 20], ['zalo_user_id', 64], ['note', 255]]) {
    if (!(key in b)) continue;
    fields[key] = b[key] === null || b[key] === '' ? null : (v.str(b[key], key, { max }) || null);
  }
  try {
    await customerModel.update(id, fields);
  } catch (err) {
    throw duplicateError(err);
  }
  res.json({ customer: await customerModel.getById(id) });
}

/** POST /api/admin/customers/:id/collect { amount, method, note? } -> { amount, balance, settled: [order_code], zalo_notify } (the customer is told on Zalo) */
async function collect(req, res) {
  const id = v.id(req.params.id);
  const r = await customerService.collect(id, {
    amount: v.num(req.body.amount, 'amount', { min: 1, max: 1e10 }),
    method: v.oneOf(req.body.method, 'method', customerService.METHODS),
    note: v.str(req.body.note, 'note', { max: 255, required: false }),
    userId: req.user.id,
  });
  const customer = await customerModel.getById(id).catch(() => null);
  const zaloNotify = await paymentNotification.notifyDebtCollected({ customer, amount: r.amount, balance: r.balance, settled: r.settled, method: req.body.method });
  res.json({ amount: r.amount, balance: r.balance, settled: r.settled, zalo_notify: zaloNotify });
}

/**
 * POST /api/admin/customers/:id/adjust { amount, direction: increase|decrease, note } -> { balance, amount (signed),
 * note, notify }. An increase notifies the customer and the owner over Zalo (notify), a decrease does not (null).
 */
async function adjust(req, res) {
  const id = v.id(req.params.id);
  const direction = v.oneOf(req.body.direction, 'direction', ['increase', 'decrease']);
  const r = await customerService.adjust(id, {
    amount: (direction === 'decrease' ? -1 : 1) * v.num(req.body.amount, 'amount', { min: 1, max: 1e9 }),
    note: v.str(req.body.note, 'note', { max: 255 }),
    userId: req.user.id,
  });
  const notify = r.amount > 0 ? await debtNotifications.notifyIncrease(r) : null;
  res.json({ balance: r.balance, amount: r.amount, note: r.note, notify });
}

/**
 * POST /api/admin/orders/:id/record-debt { customer_id } | { new_customer: { name, phone? } } [, link_zalo = true ]
 * "Ghi công nợ" for a Zalo order that is not on a customer's ledger -> { order_id, customer: { id, name, zalo_user_id },
 * amount, balance, note, linked_zalo, created_customer, notify }. The customer (and the owner) are told on Zalo.
 */
async function recordOrderDebt(req, res) {
  const b = req.body || {};
  const nc = b.new_customer && typeof b.new_customer === 'object' ? b.new_customer : null;
  const r = await customerService.recordOrderDebt(v.id(req.params.id), {
    customerId: b.customer_id ? v.id(b.customer_id, 'customer_id') : null,
    newCustomer: nc ? { name: v.str(nc.name, 'new_customer.name', { max: 120, required: false }), phone: v.str(nc.phone, 'new_customer.phone', { max: 20, required: false }) } : undefined,
    linkZalo: b.link_zalo !== false,
    userId: req.user.id,
  }).catch((err) => { throw duplicateError(err); });
  const notify = await debtNotifications.notifyIncrease({ customer: r.customer, amount: r.amount, balance: r.balance, note: r.note });
  res.status(201).json({
    order_id: r.order.id, customer: r.customer, amount: r.amount, balance: r.balance, note: r.note,
    linked_zalo: r.linkedZalo, created_customer: r.createdCustomer, notify,
  });
}

/** GET /api/admin/customers/reconciliation?from=&to=&q= (default: this month so far; a reversed range is swapped) */
async function reconciliation(req, res) {
  const r = await customerQuery.reconciliation(req.query);
  res.json({ period: { from: r.period.from, to: r.period.to }, rows: r.rows, totals: r.totals, presets: r.presets });
}

/** GET /api/admin/customers/:id/statement?from=&to= */
async function statement(req, res) {
  const id = v.id(req.params.id);
  const customer = await getOr404(id);
  const p = customerQuery.readPeriod(req.query);
  const [st, printer] = await Promise.all([customerModel.statement(id, p.bounds.from, p.bounds.to), printerSettings.get()]);
  res.json({
    customer, period: { from: p.from, to: p.to },
    opening: st.opening, entries: st.entries, increase: st.increase, decrease: st.decrease, closing: st.closing, printer,
  });
}

module.exports = { list, detail, create, update, collect, adjust, recordOrderDebt, reconciliation, statement, duplicateError };
