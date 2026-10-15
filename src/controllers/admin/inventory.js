const { withTransaction } = require('../../config/db');
const inventoryModel = require('../../models/inventoryModel');
const inventoryService = require('../../services/inventoryService');
const adminModel = require('../../models/adminModel');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render, formFlag, optional } = require('./common');
const imageStore = require('../../services/imageStore');
const inventoryExcel = require('../../services/inventoryExcel');
const logger = require('../../utils/logger');

async function page(req, res) {
  const { items, stockValue } = await inventoryService.listWithValue();
  await render(res, 'inventory', {
    title: 'Nguyên liệu', activeMenu: 'inventory', breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Nguyên liệu' }],
  }, {
    items,
    onlyLow: req.query.low === '1',
    stockValue,
  });
}

const MOVEMENT_TYPES = ['purchase', 'sale', 'adjustment', 'waste', 'return'];
const USAGE_DAYS = 30;

/** Item page: stock and cost, a chart of the balance after each movement, usage, the drinks using it, the ledger. */
async function detail(req, res) {
  const id = v.id(req.params.id);
  const item = await inventoryModel.getById(id);
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nguyên liệu.');
  const [movements, usage, usedIn] = await Promise.all([
    inventoryModel.movements(id, 200),
    inventoryModel.usage(id, USAGE_DAYS),
    inventoryModel.usedIn(id),
  ]);
  const type = MOVEMENT_TYPES.includes(req.query.type) ? req.query.type : '';
  await render(res, 'inventory_detail', {
    title: item.name, activeMenu: 'inventory',
    breadcrumbs: [{ label: 'Nguyên liệu', href: '/admin/inventory' }, { label: item.name }],
  }, { item, movements, usage, usedIn, type, MOVEMENT_TYPES });
}

async function create(req) {
  const b = req.body;
  const quantity = v.num(optional(b.quantity_on_hand), 'Tồn đầu kỳ', { required: false }) || 0;
  const cost = v.num(optional(b.avg_cost), 'Giá vốn', { required: false }) || 0;
  const name = v.str(b.name, 'Tên', { max: 150 });
  // Opening stock at cost 0 would zero the COGS of every drink using it and drag down later average cost.
  if (quantity > 0 && !(cost > 0)) throw new AppError(400, 'VALIDATION', 'Nhập giá vốn (đ/đơn vị) cho tồn đầu kỳ.');
  if (b.image_data) imageStore.decode(b.image_data);
  let id;
  await withTransaction(async (conn) => {
    id = await inventoryModel.create({
      sku: v.str(b.sku, 'Mã SKU', { max: 40 }),
      name,
      unit: v.str(b.unit, 'Đơn vị', { max: 20 }),
      quantity_on_hand: 0,
      avg_cost: 0,
      min_stock: v.num(optional(b.min_stock), 'Tồn tối thiểu', { required: false }),
      is_active: formFlag(b.is_active),
    }, conn);
    if (quantity > 0) await inventoryService.receive(conn, id, quantity, cost, { userId: req.user.id, note: 'Tồn đầu kỳ' });
  });
  await imageStore.applyFromForm(b, { dirKey: 'ingredients', id, name, currentUrl: null, setImage: inventoryModel.setImage });
  return { message: `Đã thêm nguyên liệu ${name}.` };
}

async function update(req) {
  const id = v.id(req.params.id);
  const current = await inventoryModel.getById(id);
  if (!current) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nguyên liệu.');
  if (req.body.image_data) imageStore.decode(req.body.image_data);
  await inventoryModel.update(id, {
    name: v.str(optional(req.body.name), 'Tên', { max: 150, required: false }),
    unit: v.str(optional(req.body.unit), 'Đơn vị', { max: 20, required: false }),
    min_stock: v.num(optional(req.body.min_stock), 'Tồn tối thiểu', { required: false }),
    is_active: formFlag(req.body.is_active),
  });
  await imageStore.applyFromForm(req.body, { dirKey: 'ingredients', id, name: optional(req.body.name) || current.name, currentUrl: current.image_url, setImage: inventoryModel.setImage });
  return { message: 'Đã cập nhật nguyên liệu.' };
}

/** Stocktake (set the counted quantity) or waste. */
async function adjust(req) {
  const id = v.id(req.params.id);
  const result = await withTransaction((conn) => inventoryService.adjust(conn, id, v.num(req.body.new_quantity, 'Số lượng thực tế', { min: 0 }), {
    type: v.oneOf(optional(req.body.type), 'Loại', ['adjustment', 'waste'], { required: false }) || 'adjustment',
    userId: req.user.id,
    note: v.str(optional(req.body.note), 'Ghi chú', { max: 255, required: false }),
  }));
  return { message: result.delta === 0 ? 'Số lượng không đổi.' : `Đã điều chỉnh tồn kho (${result.delta > 0 ? '+' : ''}${result.delta}).` };
}

// ------------------------------------------------------------------ receiving
async function receivingPage(req, res) {
  const [items, recent] = await Promise.all([inventoryModel.list(), adminModel.recentPurchases(30)]);
  const preselect = Number(req.query.item) || 0;
  await render(res, 'receiving', {
    title: 'Nhập kho', activeMenu: 'receiving', breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Nhập kho' }],
  }, { items, recent, preselect: items.some((i) => i.id === preselect) ? preselect : 0 });
}

async function receive(req) {
  const id = v.id(req.body.inventory_item_id, 'Nguyên liệu');
  const quantity = v.num(req.body.quantity, 'Số lượng', { min: 0.001 });
  const result = await withTransaction((conn) => inventoryService.receive(conn, id, quantity, v.num(req.body.unit_cost, 'Đơn giá nhập', { min: 0 }), {
    userId: req.user.id,
    note: v.str(optional(req.body.note), 'Ghi chú', { max: 255, required: false }),
  }));
  return { message: `Đã nhập kho. Tồn mới: ${result.quantity_on_hand}, giá vốn bình quân: ${Math.round(result.avg_cost)}đ.` };
}

// ------------------------------------------------------------------ Excel import / export
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const stamp = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date()).replace(/-/g, '');

function sendXlsx(res, filename, buffer) {
  res.set({ 'Content-Type': XLSX_MIME, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(buffer);
}

async function exportXlsx(_req, res) {
  const items = await inventoryModel.listAll();
  sendXlsx(res, `ton-kho-${stamp()}.xlsx`, await inventoryExcel.exportWorkbook(items));
}

async function templateXlsx(_req, res) {
  sendXlsx(res, 'mau-nhap-nguyen-lieu.xlsx', await inventoryExcel.templateWorkbook());
}

const PREVIEW_LIMIT = 100;

/** POST raw .xlsx. ?dry=1 only reports what would change; without it the import is applied (and only when the file has no errors). */
async function importXlsx(req, res) {
  try {
    const rows = await inventoryExcel.parseSheet(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    const p = inventoryExcel.plan(rows, await inventoryModel.listAll());
    const dry = req.query.dry === '1';
    const preview = {
      summary: p.summary,
      creates: p.creates.slice(0, PREVIEW_LIMIT).map((x) => ({ row: x.row, sku: x.sku, name: x.name, unit: x.unit, quantity: x.quantity })),
      updates: p.updates.slice(0, PREVIEW_LIMIT).map((x) => ({ row: x.row, sku: x.sku, name: x.name, changes: x.changes })),
      counts: p.counts.slice(0, PREVIEW_LIMIT).map((x) => ({ row: x.row, sku: x.sku, name: x.name, from: x.from, to: x.to })),
      errors: p.errors.slice(0, PREVIEW_LIMIT),
    };
    if (dry) return res.json({ ok: true, dry: true, ...preview });
    if (p.errors.length) return res.status(400).json({ ok: false, error: `File còn ${p.errors.length} lỗi, chưa nhập gì. Hãy sửa rồi tải lại.`, ...preview });
    if (!p.creates.length && !p.updates.length && !p.counts.length) return res.json({ ok: true, applied: false, message: 'Không có thay đổi nào so với dữ liệu hiện tại.', ...preview });

    await withTransaction(async (conn) => {
      for (const x of p.creates) {
        const id = await inventoryModel.create({ sku: x.sku, name: x.name, unit: x.unit, quantity_on_hand: 0, avg_cost: 0, min_stock: x.min_stock, is_active: x.is_active }, conn);
        if (x.quantity > 0) await inventoryService.receive(conn, id, x.quantity, x.cost, { userId: req.user.id, note: 'Tồn đầu kỳ (nhập từ Excel)' });
      }
      for (const x of p.updates) await inventoryModel.update(x.id, x.patch, conn);
      for (const x of p.counts) await inventoryService.adjust(conn, x.id, x.to, { type: 'adjustment', userId: req.user.id, note: 'Kiểm kê (nhập từ Excel)' });
    });
    logger.info(`Inventory Excel import by user ${req.user.id}: +${p.creates.length} new, ${p.updates.length} edited, ${p.counts.length} counted`);
    return res.json({ ok: true, applied: true, message: `Đã nhập: thêm ${p.creates.length}, cập nhật ${p.updates.length}, kiểm kê ${p.counts.length}.`, ...preview });
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status || 400).json({ ok: false, error: err.message });
    logger.error('Inventory Excel import failed', err);
    return res.status(500).json({ ok: false, error: 'Không nhập được file. Vui lòng thử lại.' });
  }
}

module.exports = { page, detail, create, update, adjust, receivingPage, receive, exportXlsx, templateXlsx, importXlsx };
