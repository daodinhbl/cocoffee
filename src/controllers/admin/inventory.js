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
const groups = require('../../services/inventoryGroups');
const skuGenerator = require('../../services/skuGenerator');
const supplierModel = require('../../models/supplierModel');
const purchaseModel = require('../../models/purchaseModel');
const purchaseService = require('../../services/purchaseService');

const PAGE_SIZE = 20;                       // rows per page on /admin/inventory
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

async function page(req, res) {
  const { items, stockValue } = await inventoryService.listWithValue();
  const onlyLow = req.query.low === '1';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';
  const term = fold(q);
  const groupOf = (i) => groups.groupOf(i);
  const group = groups.CODES.includes(req.query.group) ? req.query.group : '';
  const groupCounts = Object.fromEntries(groups.CODES.map((c) => [c, 0]));
  items.forEach((i) => { groupCounts[groupOf(i)] += 1; });
  const matching = items
    .filter((i) => !group || groupOf(i) === group)
    .filter((i) => !onlyLow || (i.is_active && i.is_low))
    .filter((i) => !term || fold(`${i.name} ${i.sku}`).includes(term));
  const total = matching.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageNo = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const pageUrl = (n) => {
    const p = new URLSearchParams();
    if (group) p.set('group', group);
    if (onlyLow) p.set('low', '1');
    if (q) p.set('q', q);
    if (n > 1) p.set('page', n);
    const s = p.toString();
    return `/admin/inventory${s ? `?${s}` : ''}`;
  };
  await render(res, 'inventory', {
    title: 'Nguyên liệu', activeMenu: 'inventory', breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Nguyên liệu' }],
  }, {
    items,                                                      // everything: the summary cards and tab counts
    shown: matching.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE),
    onlyLow, q, total, page: pageNo, pages, pageSize: PAGE_SIZE, pageUrl,
    group, groups: groups.GROUPS, groupCounts, groupOf,
    // link to another group tab / low-stock toggle, keeping the search
    tabUrl: (g, low = onlyLow) => {
      const p = new URLSearchParams();
      if (g) p.set('group', g);
      if (low) p.set('low', '1');
      if (q) p.set('q', q);
      const s = p.toString();
      return `/admin/inventory${s ? `?${s}` : ''}`;
    },
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
  }, { item, movements, usage, usedIn, type, MOVEMENT_TYPES, groups: groups.GROUPS });
}

/** No group chosen: guess from the name; an unrecognised item on the ingredients screen is a raw material. */
const guessedGroup = (name) => { const g = groups.groupOf({ name, sku: '' }); return g === 'other' ? 'raw' : g; };
const SKU_PREFIX = { raw: 'RM', packaging: 'PK', retail: 'GD', other: 'OT' };

/** "Quy cách nhập": pack_name (thùng, kg…) + pack_size (stock units in one pack); both or neither. */
function readPack(b) {
  const name = v.str(optional(b.pack_name), 'Đơn vị nhập', { max: 20, required: false }) || '';
  if (!name) return { pack_name: '', pack_size: null };
  return { pack_name: name, pack_size: v.num(b.pack_size, 'Số lượng trong một đơn vị nhập', { min: 0.001, max: 1000000 }) };
}

/** Form value of the group select: a known code, or '' for automatic. */
function readGroup(value) {
  return v.oneOf(optional(value), 'Phân loại', groups.CODES, { required: false }) || '';
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
    // SKU left empty -> made from the group and the name (RM-DUONG-CAT)
    const group = readGroup(b.group_code);
    const typed = optional(b.sku);
    const sku = typed ? v.str(typed, 'Mã SKU', { max: 40 }) : await skuGenerator.generate({
      prefix: SKU_PREFIX[group || guessedGroup(name)], name, exists: (s) => inventoryModel.skuExists(s, conn),
    });
    id = await inventoryModel.create({
      sku,
      name,
      unit: v.str(b.unit, 'Đơn vị', { max: 20 }),
      quantity_on_hand: 0,
      avg_cost: 0,
      min_stock: v.num(optional(b.min_stock), 'Tồn tối thiểu', { required: false }),
      is_active: formFlag(b.is_active),
      group_code: readGroup(b.group_code) || null,
      ...readPack(b),
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
    group_code: req.body.group_code === undefined ? undefined : (readGroup(req.body.group_code) || null),
    ...(req.body.pack_name === undefined ? {} : readPack(req.body)),
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
  const [all, suppliers, recent] = await Promise.all([inventoryModel.listAll(), supplierModel.options(), purchaseModel.listReceipts({ limit: 10 })]);
  const items = all.filter((i) => i.is_active).map((i) => ({ ...i, group: groups.groupOf(i) }));
  const preselect = Number(req.query.item) || 0;
  const supplier = Number(req.query.supplier) || 0;
  await render(res, 'receiving', {
    title: 'Nhập kho', activeMenu: 'receiving', breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Nhập kho' }],
  }, {
    items, groups: groups.GROUPS, suppliers, recent,
    preselect: items.some((i) => i.id === preselect) ? preselect : 0,
    preSupplier: suppliers.some((s) => s.id === supplier) ? supplier : 0,
  });
}

const MAX_RECEIPT_LINES = 50;
const asList = (x) => (x === undefined ? [] : [].concat(x));

/**
 * One receiving slip with several lines, booked in ONE transaction (all lines or none). The form posts parallel arrays
 * item_id[] / quantity[] / unit_cost[] (+ factor[] and pack[] when bought by the box / kg); the older single-line fields
 * (inventory_item_id, quantity, unit_cost) still work. quantity and unit_cost are in the unit BOUGHT (thùng, kg):
 * purchaseService converts them to stock units (chai, g).
 */
function readReceiptLines(body) {
  const ids = asList(body.item_id !== undefined ? body.item_id : body.inventory_item_id);
  const qty = asList(body.quantity);
  const cost = asList(body.unit_cost);
  const factor = asList(body.factor);
  const pack = asList(body.pack);
  const lines = [];
  ids.forEach((raw, k) => {
    if (raw === '' || raw === undefined) return;                               // an empty row is ignored
    const f = factor[k] === undefined || factor[k] === '' ? 1 : v.num(factor[k], `Quy đổi (dòng ${k + 1})`, { min: 0.001, max: 1000000 });
    lines.push({
      itemId: v.id(raw, 'Nguyên liệu'),
      packQty: v.num(qty[k], `Số lượng (dòng ${k + 1})`, { min: 0.001 }),
      packFactor: f,
      packPrice: v.num(cost[k], `Đơn giá nhập (dòng ${k + 1})`, { min: 0 }),
      packLabel: f !== 1 ? v.str(optional(pack[k]), 'Đơn vị nhập', { max: 30, required: false }) : '',
    });
  });
  if (!lines.length) throw new AppError(400, 'VALIDATION', 'Chọn ít nhất một mặt hàng để nhập.');
  if (lines.length > MAX_RECEIPT_LINES) throw new AppError(400, 'VALIDATION', `Một phiếu nhập tối đa ${MAX_RECEIPT_LINES} dòng.`);
  return lines;
}

async function receive(req) {
  const b = req.body;
  const lines = readReceiptLines(b);
  const docNo = v.str(optional(b.doc_no), 'Số hóa đơn', { max: 40, required: false }) || null;
  const extra = v.str(optional(b.note), 'Ghi chú', { max: 255, required: false }) || null;
  const legacySupplier = v.str(optional(b.supplier), 'Nhà cung cấp', { max: 120, required: false });   // older form: free text
  let supplierId = optional(b.supplier_id) ? v.id(b.supplier_id, 'Nhà cung cấp') : null;
  const newName = v.str(optional(b.supplier_new), 'Nhà cung cấp mới', { max: 120, required: false }) || legacySupplier;
  if (!supplierId && newName) {
    const found = await supplierModel.findByName(newName);
    supplierId = found ? found.id : await supplierModel.create({ name: newName });
  }
  const mode = ['all', 'none', 'partial'].includes(b.pay_mode) ? b.pay_mode : 'all';
  const paid = mode === 'all' ? 'all' : mode === 'none' ? 0 : v.num(b.paid_amount, 'Số tiền đã trả', { min: 0 });
  const result = await purchaseService.createReceipt({
    supplierId, docNo, note: extra, userId: req.user.id, paid, method: v.oneOf(optional(b.pay_method), 'Hình thức', purchaseService.METHODS, { required: false }) || 'cash', lines,
  });
  const debt = result.total - result.paid;
  const money = (n) => `${Math.round(n).toLocaleString('vi-VN')}đ`;
  if (result.lines === 1 && !supplierId) {
    const item = await inventoryModel.getById(lines[0].itemId);
    return { message: `Đã nhập kho (${result.code}). Tồn mới: ${item ? item.quantity_on_hand : ''}, giá vốn bình quân: ${item ? Math.round(item.avg_cost) : ''}đ.` };
  }
  return { message: `Đã nhập kho ${result.lines} dòng hàng (${result.code}), tổng tiền ${money(result.total)}${debt > 0 ? `, còn nợ ${money(debt)}` : ''}.`, to: `/admin/receipts/${result.id}` };
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
