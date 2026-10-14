const customerModel = require('../../models/customerModel');
const customerService = require('../../services/customerService');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render, optional, describeError } = require('./common');
const env = require('../../config/env');
const printerSettings = require('../../services/printerSettings');
const debtNotifications = require('../../services/zalo/debtNotificationService');

const customerQuery = require('../../services/customerQueryService');

const { PAGE_SIZE } = customerQuery;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const { readFilters, readPeriod } = customerQuery;

/**
 * Override describeError to give a Vietnamese message for duplicate phone/zalo.
 * The generic 1062 text from common.js is fine for other modules but here we
 * want to be more specific.
 */
function friendlyDbError(err) {
  if (err && err.errno === 1062) {
    if (String(err.sqlMessage || '').includes('uq_customers_phone')) {
      return 'Số điện thoại này đã được dùng cho khách hàng khác.';
    }
    if (String(err.sqlMessage || '').includes('uq_customers_zalo')) {
      return 'Zalo ID này đã được liên kết với khách hàng khác.';
    }
    return 'Thông tin bị trùng (số điện thoại hoặc Zalo ID đã tồn tại).';
  }
  return describeError(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/customers
// ─────────────────────────────────────────────────────────────────────────────

async function list(req, res) {
  const f = readFilters(req.query);
  const { customers, stats, total, page, pages } = await customerQuery.listPage(f);

  // Build a page URL helper that keeps active filters.
  const params = new URLSearchParams();
  if (f.q)        params.set('q',    f.q);
  if (f.debtOnly) params.set('debt', '1');
  if (f.zaloOnly) params.set('zalo', '1');
  const pageUrl = (n) => {
    const p = new URLSearchParams(params);
    if (n > 1) p.set('page', n);
    const s = p.toString();
    return `/admin/customers${s ? `?${s}` : ''}`;
  };

  await render(res, 'customers', {
    title: 'Khách hàng', activeMenu: 'customers',
    breadcrumbs: [{ label: 'Vận hành', href: '#' }, { label: 'Khách hàng' }],
  }, {
    customers, filters: f, stats,
    total, page, pages, pageSize: PAGE_SIZE, pageUrl,
    hasFilter: !!(f.q || f.debtOnly || f.zaloOnly),
    from: (page - 1) * PAGE_SIZE + 1,
    to:   Math.min(total, page * PAGE_SIZE),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/customers/new  (render blank form)
// ─────────────────────────────────────────────────────────────────────────────

async function newForm(req, res) {
  await render(res, 'customer_form', {
    title: 'Thêm khách hàng', activeMenu: 'customers',
    breadcrumbs: [{ label: 'Khách hàng', href: '/admin/customers' }, { label: 'Thêm mới' }],
  }, { customer: null });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/customers/:id/edit  (render edit form)
// ─────────────────────────────────────────────────────────────────────────────

async function editForm(req, res) {
  const id = v.id(req.params.id);
  const customer = await customerModel.getById(id);
  if (!customer) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy khách hàng.');
  await render(res, 'customer_form', {
    title: `Sửa: ${customer.name}`, activeMenu: 'customers',
    breadcrumbs: [
      { label: 'Khách hàng', href: '/admin/customers' },
      { label: customer.name, href: `/admin/customers/${customer.id}` },
      { label: 'Sửa' },
    ],
  }, { customer });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/customers/:id  (detail)
// ─────────────────────────────────────────────────────────────────────────────

async function detail(req, res) {
  const id = v.id(req.params.id);
  const customer = await customerModel.getById(id);
  if (!customer) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy khách hàng.');

  const [ledger, orders] = await Promise.all([
    customerModel.ledgerHistory(id, 100),
    customerModel.orderHistory(id, 50),
  ]);

  await render(res, 'customer_detail', {
    title: customer.name, activeMenu: 'customers',
    breadcrumbs: [{ label: 'Khách hàng', href: '/admin/customers' }, { label: customer.name }],
  }, { customer, ledger, orders });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/customers  (create)  — called via act()
// ─────────────────────────────────────────────────────────────────────────────

async function create(req) {
  const b = req.body;
  const name  = v.str(b.name,  'Tên khách hàng', { max: 120 });
  const phone = v.str(optional(b.phone), 'Số điện thoại', { max: 20, required: false });
  const zaloId = v.str(optional(b.zalo_user_id), 'Zalo ID', { max: 64, required: false });
  const note   = v.str(optional(b.note), 'Ghi chú', { max: 255, required: false });

  let id;
  try {
    id = await customerModel.create({ name, phone, zalo_user_id: zaloId, note });
  } catch (err) {
    const msg = friendlyDbError(err);
    if (msg) throw Object.assign(new AppError(400, 'DUPLICATE', msg), { errno: err.errno, sqlMessage: err.sqlMessage });
    throw err;
  }
  return { message: `Đã thêm khách hàng "${name}".`, to: `/admin/customers/${id}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/customers/:id  (update)  — called via act()
// ─────────────────────────────────────────────────────────────────────────────

async function update(req) {
  const id = v.id(req.params.id);
  if (!(await customerModel.getById(id))) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy khách hàng.');

  const b = req.body;
  const name   = v.str(optional(b.name), 'Tên khách hàng', { max: 120, required: false });
  const phone  = v.str(optional(b.phone), 'Số điện thoại', { max: 20, required: false });
  const zaloId = v.str(optional(b.zalo_user_id), 'Zalo ID', { max: 64, required: false });
  const note   = v.str(optional(b.note), 'Ghi chú', { max: 255, required: false });

  // Allow explicitly clearing optional fields by passing an empty string.
  const fields = {};
  if (name   !== undefined) fields.name         = name;
  // Treat empty string as null (clear the field).
  if ('phone'        in b) fields.phone         = optional(b.phone)        || null;
  if ('zalo_user_id' in b) fields.zalo_user_id  = optional(b.zalo_user_id) || null;
  if ('note'         in b) fields.note          = optional(b.note)         || null;

  try {
    await customerModel.update(id, fields);
  } catch (err) {
    const msg = friendlyDbError(err);
    if (msg) throw Object.assign(new AppError(400, 'DUPLICATE', msg), { errno: err.errno, sqlMessage: err.sqlMessage });
    throw err;
  }
  return { message: 'Đã cập nhật thông tin khách hàng.', to: `/admin/customers/${id}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/customers/:id/collect  (thu nợ, partial allowed)  — act()
// POST /admin/customers/:id/adjust   (điều chỉnh công nợ)         — act()
// ─────────────────────────────────────────────────────────────────────────────

async function collect(req) {
  const id = v.id(req.params.id);
  const r = await customerService.collect(id, {
    amount: v.num(req.body.amount, 'Số tiền thu', { min: 1, max: 1e10 }),
    method: v.oneOf(req.body.method, 'Hình thức', customerService.METHODS),
    note: v.str(optional(req.body.note), 'Ghi chú', { max: 255, required: false }),
    userId: req.user.id,
  });
  const settled = r.settled.length ? ` Đã tất toán ${r.settled.length} đơn: ${r.settled.join(', ')}.` : '';
  return { message: `Đã thu ${r.amount.toLocaleString('vi-VN')}đ. Còn nợ ${r.balance.toLocaleString('vi-VN')}đ.${settled}`, to: `/admin/customers/${id}` };
}

async function adjust(req) {
  const id = v.id(req.params.id);
  const sign = req.body.direction === 'decrease' ? -1 : 1;
  const r = await customerService.adjust(id, {
    amount: sign * v.num(req.body.amount, 'Số tiền', { min: 1, max: 1e9 }),
    note: v.str(req.body.note, 'Lý do', { max: 255 }),
    userId: req.user.id,
  });
  let message = 'Đã điều chỉnh công nợ. Số dư mới ' + r.balance.toLocaleString('vi-VN') + 'đ.';
  if (r.amount > 0) {
    const sent = await debtNotifications.notifyIncrease(r);
    if (sent.customer === 'sent') message += ' Đã gửi Zalo cho khách.';
    else if (sent.customer === 'not_linked') message += ' Khách chưa liên kết Zalo nên chưa nhận được tin.';
    else if (sent.customer === 'failed') message += ' Gửi Zalo cho khách không thành công.';
    else if (sent.customer === 'push_not_supported') message += ' Chế độ Zalo hiện tại không hỗ trợ gửi tin chủ động cho khách.';
    if (sent.owner === 'sent') message += ' Đã báo chủ quán qua Zalo.';
    else if (sent.owner === 'not_configured') message += ' Chưa cấu hình Chat ID Zalo nhận công nợ của chủ quán.';
    else if (sent.owner === 'failed') message += ' Gửi Zalo cho chủ quán không thành công.';
    else if (sent.owner === 'push_not_supported') message += ' Chế độ Zalo hiện tại không hỗ trợ gửi tin chủ động cho chủ quán.';
  }
  return { message, to: '/admin/customers/' + id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Debt reconciliation (đối chiếu công nợ)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /admin/customers/reconciliation */
async function reconciliation(req, res) {
  const r = await customerQuery.reconciliation(req.query);
  await render(res, 'debt_reconciliation', {
    title: 'Đối chiếu công nợ', activeMenu: 'customers',
    breadcrumbs: [{ label: 'Khách hàng', href: '/admin/customers' }, { label: 'Đối chiếu công nợ' }],
  }, { rows: r.rows, totals: r.totals, period: r.period, q: r.q, presets: r.presets });
}

/** GET /admin/customers/:id/statement — printable A4 reconciliation sheet for one customer */
async function statementPage(req, res) {
  const id = v.id(req.params.id);
  const customer = await customerModel.getById(id);
  if (!customer) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy khách hàng.');
  const p = readPeriod(req.query);
  const [st, printer] = await Promise.all([customerModel.statement(id, p.bounds.from, p.bounds.to), printerSettings.get()]);
  res.render('customer_statement', {
    shopName: env.business.shopName, printer, customer, period: p, st,
    printedBy: req.user.full_name || req.user.username,
    autoPrint: req.query.print === '1',
  });
}

module.exports = { list, newForm, editForm, detail, create, update, collect, adjust, reconciliation, statementPage, readPeriod };
