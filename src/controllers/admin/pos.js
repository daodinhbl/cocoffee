const env = require('../../config/env');
const printerSettings = require('../../services/printerSettings');
const orderService = require('../../services/orderService');
const orderModel = require('../../models/orderModel');
const shiftService = require('../../services/shiftService');
const shiftModel = require('../../models/shiftModel');
const { shopDay, parseDay, dayBounds } = require('../../utils/shopTime');
const posService = require('../../services/posService');
const tableModel = require('../../models/tableModel');
const QRCode = require('qrcode');
const vietQr = require('../../services/vietQr');
const chatbotInfo = require('../../services/zalo/chatbotInfo');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const logger = require('../../utils/logger');
const { zaloStatus, describeError } = require('./common');
const { versionOf } = require('../../middlewares/adminSecurity');

/**
 * POS front-office (tablet at the counter). One server-rendered page; the cart lives in the browser and
 * is sent once, at checkout. Pricing, stock deduction (BOM) and COGS stay in orderService — the client's
 * prices are display-only.
 */
async function page(req, res) {
  const [{ categories, products, tables, drafts, printer, temps }, zalo] = await Promise.all([posService.bootstrap(), zaloStatus()]);
  res.render('pos', {
    shopName: env.business.shopName,
    user: req.user,
    isAdmin: req.user.role === 'admin',
    zalo,
    posV: versionOf('pos/pos.js'),
    data: {
      categories: categories.map((c) => ({ id: c.id, code: c.code, name: c.name })),
      products: products.map((p) => ({ id: p.id, categoryId: p.category_id, name: p.name, price: Number(p.price), image: p.image_url || null })),
      tables: tables.map(posService.tableState),
      printer: { autoPrint: printer.autoPrint, vatRate: printer.showVat ? printer.vatRate : 0, paperMm: printer.paperMm },
      temps: temps.map((o) => ({ ...o, at: o.at })),
      drafts: drafts.map((d) => ({ code: d.order_code, total: Number(d.total || 0), chatType: d.chat_type, at: d.last_activity_at })),
    },
  });
}

/** Items of the open order sitting on a busy table, so the cashier can add to it and take payment. */
async function openOrder(req, res) {
  try {
    const orderId = v.id(req.params.id);
    const order = await orderService.getWithItems(orderId);
    if (order.status !== 'open') throw new AppError(409, 'ORDER_NOT_OPEN', 'Đơn này không còn mở.');
    const [prepaid, merged] = await Promise.all([orderModel.paidTotal(orderId), order.table_id ? tableModel.mergedInto(order.table_id) : []]);
    res.json({
      ok: true,
      order: {
        id: order.id, code: order.order_code, note: order.note, tableId: order.table_id || null, prepaid,
        merged: merged.map((m) => ({ id: m.id, name: m.name || m.code })),
        items: order.items.map((i) => ({ id: i.id, productId: i.product_id, name: i.product_name, price: Number(i.unit_price), qty: i.quantity, note: i.note || null })),
      },
    });
  } catch (err) {
    sendError(res, err);
  }
}

const { readCart } = posService;

/** Keep the order on its table (pay later). Needs a table. */
async function hold(req) {
  const { order } = await posService.hold(readCart(req.body), req.user.id, { allowTakeaway: true });
  return {
    message: order.table_id ? `Đã lưu đơn ${order.order_code} cho bàn.` : `Đã lưu đơn tạm ${order.order_code}.`,
    order: { id: order.id, code: order.order_code, total: Number(order.total) },
    temps: await posService.tempOrders(),
  };
}

/** Save + pay in one step. A just-created order whose payment fails is cancelled, so nothing is left half-done. */
async function checkout(req) {
  const cart = readCart(req.body);
  const payment = posService.readPayment(req.body);
  const result = await posService.checkout(cart, payment, req.user.id, req.user.role === 'admin');
  return {
    message: `Đã thanh toán ${result.order.order_code}.`,
    order: { id: result.order.id, code: result.order.order_code, total: Number(result.order.total) },
    change: result.change,
  };
}

/** GET ?amount=&memo= -> { ok, svg, amount, memo, bankName, account, holder }: the transfer QR the pay dialog shows. */
async function transferQr(req, res) {
  try {
    const info = await chatbotInfo.get();
    if (!chatbotInfo.bankReady(info)) throw new AppError(409, 'BANK_NOT_SET', 'Chưa cài tài khoản nhận chuyển khoản.');
    const amount = Math.round(Number(req.query.amount));
    if (!(amount > 0) || amount > 1e11) throw new AppError(400, 'VALIDATION', 'Số tiền không hợp lệ.');
    const memo = vietQr.cleanNote(req.query.memo);
    const text = vietQr.payload({ bin: info.bankBin, account: info.bankAccount, amount, note: memo });
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 260, errorCorrectionLevel: 'M' });
    res.json({ ok: true, svg, amount, memo, bankName: info.bankName, account: info.bankAccount, holder: info.bankAccountName });
  } catch (err) {
    sendError(res, err);
  }
}

/** GET ?day=YYYY-MM-DD&q=&status= -> the day's orders (newest first), for the "Lịch sử" dialog. */
async function history(req, res) {
  try {
    const day = parseDay(String(req.query.day || '')) || shopDay();
    const { from, to } = dayBounds(day, day);
    const status = ['open', 'completed', 'cancelled'].includes(req.query.status) ? req.query.status : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 30) : '';
    const rows = await orderModel.list({ from, to, status, q: q || undefined, excludeStatuses: status ? undefined : ['draft'], limit: 150 });
    res.json({
      ok: true, day,
      orders: rows.map((o) => ({
        id: o.id, code: o.order_code, status: o.status, paid: o.payment_status === 'paid', method: o.payment_method || null,
        total: Number(o.total), count: Number(o.item_count || 0), table: o.table_code || null, source: o.source, at: o.created_at,
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
}

/** One order of the history: lines, payments (prepayments included) and who is allowed to reprint it. */
async function historyOrder(req, res) {
  try {
    const id = v.id(req.params.id);
    const order = await orderService.getWithItems(id);
    const payments = await orderModel.getPayments(id);
    res.json({
      ok: true,
      order: {
        id: order.id, code: order.order_code, status: order.status, paid: order.payment_status === 'paid', table: order.table_name || order.table_code || null,
        total: Number(order.total), subtotal: Number(order.subtotal), discount: Number(order.discount), note: order.note || '', at: order.created_at,
        printable: order.status === 'completed' || order.status === 'open' ? order.status === 'completed' : false,
        items: order.items.map((i) => ({ name: i.product_name, qty: i.quantity, price: Number(i.unit_price), total: Number(i.line_total), note: i.note || null })),
        payments: payments.map((p) => ({ method: p.method, label: METHOD_LABEL[p.method] || p.method, amount: Number(p.amount), reference: p.reference || '', at: p.paid_at })),
      },
    });
  } catch (err) {
    sendError(res, err);
  }
}

/** Chốt ca, step 1: the open period's totals. */
async function shiftPreview() {
  const p = await shiftService.preview();
  return { shift: p };
}

/** Chốt ca, step 2: store them with the till count. */
async function shiftClose(req) {
  const shift = await shiftService.close({ openingCash: req.body.opening_cash, countedCash: req.body.counted_cash, note: req.body.note, userId: req.user.id });
  return { message: 'Đã chốt ca.', shiftId: shift.id, difference: Number(shift.difference) };
}

/** Printable shift report (80 mm), like the receipt: ?print=1 prints on load. */
async function shiftPrint(req, res) {
  const shift = await shiftModel.getById(v.id(req.params.id));
  if (!shift) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy ca.');
  const csp = res.getHeader('Content-Security-Policy');
  if (csp) res.setHeader('Content-Security-Policy', String(csp).replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
  res.render('shift-report', { shopName: env.business.shopName, taxCode: env.business.taxCode || '', shift, autoPrint: req.query.print === '1', paper: (await printerSettings.get()).paperMm });
}

/** Drop a saved-for-later order (any open order; prepayments are refunded by orderService). */
async function cancelOrder(req) {
  await orderService.cancelOrder(v.id(req.body.order_id, 'Đơn'));
  return { message: 'Đã hủy đơn.', ...(await tablesState()), temps: await posService.tempOrders() };
}

/** Fresh table list: every table action answers with it so the floor plan redraws without a reload. */
async function tablesState() {
  return { tables: (await tableModel.list()).map(posService.tableState) };
}

/** Thanh toán trước: save the cart on its table and take money now. */
async function prepay(req) {
  const cart = readCart(req.body);
  const pay = posService.readPayment(req.body);
  const amount = v.num(req.body.amount, 'Số tiền trả trước', { min: 1 });
  const result = await posService.prepay(cart, { method: pay.method, amount, reference: pay.reference }, req.user.id);
  return {
    message: `Đã nhận ${Math.round(amount).toLocaleString('vi-VN')}đ trả trước cho ${result.order.order_code}.`,
    order: { id: result.order.id, code: result.order.order_code, total: Number(result.order.total) },
    prepaid: result.prepaid,
    ...(await tablesState()),
    temps: await posService.tempOrders(),
  };
}

/** Ghép bàn: other table joins the primary table's order. */
async function mergeTables(req) {
  const order = await orderService.mergeTables({ primaryTableId: v.id(req.body.primary_table_id, 'Bàn chính'), otherTableId: v.id(req.body.other_table_id, 'Bàn ghép') });
  return { message: `Đã ghép bàn vào đơn ${order.order_code}.`, orderId: order.id, ...(await tablesState()) };
}

/** Tách bàn: a merged table leaves its group. */
async function unmergeTable(req) {
  await orderService.unmergeTable(v.id(req.body.table_id, 'Bàn'));
  return { message: 'Đã tách bàn khỏi nhóm ghép.', ...(await tablesState()) };
}

/** Tách bàn: move some items of an open order to another table. */
async function splitOrder(req) {
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
  const r = await orderService.splitOrder({
    orderId: v.id(req.body.order_id, 'Đơn'), targetTableId: v.id(req.body.target_table_id, 'Bàn nhận món'), userId: req.user.id,
    items: items.map((i) => ({ item_id: v.id(i?.item_id, 'Món'), quantity: Number(i?.quantity) })),
  });
  return { message: `Đã tách món sang đơn ${r.target.order_code}.`, sourceOrderId: r.source.id, targetOrderId: r.target.id, ...(await tablesState()) };
}

const METHOD_LABEL = { cash: 'Tiền mặt', transfer: 'Chuyển khoản', card: 'Thẻ', other: 'Khác' };

/**
 * Printable receipt for a thermal printer (80mm by default, RECEIPT_PAPER_MM=58 for small printers).
 * ?print=1 prints on load (the POS loads it in a hidden iframe right after checkout); ?given= shows the
 * cash handed over and the change.
 */
function renderReceipt(req, res, { order, payments, printer, sample = false }) {
  const given = Number(req.query.given);
  const total = Number(order.total);
  // The POS prints from a same-origin iframe: allow framing by ourselves only (admin pages say 'none').
  const csp = res.getHeader('Content-Security-Policy');
  if (csp) res.setHeader('Content-Security-Policy', String(csp).replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
  res.render('receipt', {
    shopName: env.business.shopName,
    printer,
    paper: printer.paperMm,
    order,
    payments: payments.map((p) => ({ ...p, label: METHOD_LABEL[p.method] || p.method })),
    vat: posService.vatOf(total, printer),
    cash: Number.isFinite(given) && given >= total ? { given, change: given - total } : null,
    autoPrint: req.query.print === '1',
    printedBy: req.user.full_name || req.user.username,
    sample,
  });
}

async function receipt(req, res) {
  const { order, payments, printer } = await posService.receipt(v.id(req.params.id));
  renderReceipt(req, res, { order, payments, printer });
}

/** "In thử" from the settings page: a made-up order with the current printer settings. */
async function sampleReceipt(req, res) {
  const now = new Date();
  const items = [
    { product_name: 'Cà phê sữa đá', unit_price: 25000, quantity: 2, line_total: 50000, note: 'ít đá' },
    { product_name: 'Bạc xỉu', unit_price: 29000, quantity: 1, line_total: 29000, note: null },
  ];
  const order = {
    id: 0, order_code: 'IN-THU', source: 'pos', status: 'completed', table_name: 'Bàn mẫu', subtotal: 79000, discount: 4000, total: 75000,
    note: 'Hóa đơn in thử', created_at: now, completed_at: now, paid_at: now, items,
  };
  renderReceipt(req, res, { order, payments: [{ method: 'cash', received_by_name: req.user.full_name || req.user.username }], printer: await printerSettings.get(), sample: true });
}

// orderService speaks English to the API clients; the cashier gets Vietnamese.
const POS_MESSAGES = {
  TABLE_OCCUPIED: 'Bàn này đang có đơn mở. Tải lại trang để lấy đơn hiện tại của bàn.',
  PRODUCT_UNAVAILABLE: 'Có món vừa ngừng bán. Tải lại trang để cập nhật thực đơn.',
  INSUFFICIENT_PAYMENT: 'Tiền khách đưa chưa đủ.',
  ORDER_NOT_OPEN: 'Đơn không còn mở.',
  ORDER_NOT_PAYABLE: 'Đơn không còn ở trạng thái thanh toán được.',
  EMPTY_ORDER: 'Đơn chưa có món nào.',
  PREPAY_TOO_MUCH: 'Số tiền trả trước lớn hơn phần còn phải thanh toán.',
  BELOW_PREPAID: 'Tổng đơn không được thấp hơn số tiền khách đã trả trước.',
  PREPAID_EXCEEDS_TOTAL: 'Tiền trả trước lớn hơn tổng đơn (có thể do giảm giá). Hãy giảm mức giảm giá hoặc hoàn tiền thừa cho khách.',
  TABLE_HAS_NO_ORDER: 'Bàn này chưa có đơn.',
  TABLE_MERGED: 'Bàn đang được ghép. Hãy tách bàn ra khỏi nhóm ghép trước.',
  TABLE_HAS_MERGED: 'Bàn này đang là bàn chính của một nhóm ghép khác.',
  TABLE_NOT_MERGED: 'Bàn này không nằm trong nhóm ghép.',
  BANK_NOT_SET: 'Chưa cài tài khoản nhận chuyển khoản. Quản trị viên vào Zalo > Trả lời tự động & chuyển khoản để nhập.',
  SPLIT_ALL: 'Phải để lại ít nhất một món ở đơn gốc.',
};

function sendError(res, err) {
  const text = (err instanceof AppError && err.code !== 'INSUFFICIENT_STOCK' && POS_MESSAGES[err.code]) || describeError(err);
  if (!text) {
    logger.error('POS request failed', err);
    return res.status(500).json({ ok: false, message: 'Lỗi hệ thống, vui lòng thử lại.' });
  }
  return res.status(err.status && err.status < 500 ? err.status : 400).json({ ok: false, code: err.code, message: text });
}

/** JSON wrapper for POS actions: { ok:true, ...result } or { ok:false, message }. */
const json = (fn) => async (req, res) => {
  try {
    res.json({ ok: true, ...(await fn(req, res)) });
  } catch (err) {
    sendError(res, err);
  }
};

module.exports = { page, openOrder, history, historyOrder, shiftPreview, shiftClose, shiftPrint, transferQr, checkout, hold, cancelOrder, prepay, mergeTables, unmergeTable, splitOrder, receipt, sampleReceipt, json, readCart };
