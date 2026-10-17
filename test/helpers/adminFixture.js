/**
 * Test harness for the Web Admin without MySQL: the models (and the pool, for withTransaction) are replaced
 * with in-memory fakes via node:test mocks, then the real Express app, real EJS views and real middleware run
 * on an ephemeral port. `calls` records what the controllers asked the models to do.
 */
process.env.FNB_NO_LISTEN = '1';
process.env.RECEIPT_PDF_ENABLED = 'false';          // tests must not write receipt PDFs into the repo
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
process.env.ZALO_BOT_TOKEN = ''; process.env.BOT_WEBHOOK_SECRET = ''; process.env.ZALO_MODE = '';   // ignore a developer .env
process.env.PUBLIC_BASE_URL = 'https://cafe.example.test';   // a developer .env may enable it; tests opt in explicitly
process.env.ZALO_APP_ID = ''; process.env.ZALO_OA_SECRET_KEY = '';

const http = require('node:http');
const { mock } = require('node:test');
const bcrypt = require('bcryptjs');

const PASSWORD = 'Sup3r-secret-pw';
const NOW = new Date();

const USERS = [
  { id: 1, username: 'boss', full_name: 'Chủ Quán', role: 'admin', is_active: 1, password_hash: bcrypt.hashSync(PASSWORD, 4) },
  { id: 2, username: 'thungan', full_name: 'Thu Ngân', role: 'cashier', is_active: 1, password_hash: bcrypt.hashSync(PASSWORD, 4) },
  { id: 3, username: 'admin', full_name: 'Admin', role: 'admin', is_active: 1, password_hash: bcrypt.hashSync('admin', 4) },
];
// Like userModel.findById: no hash, but the same pw_stamp MySQL computes with LEFT(SHA2(password_hash, 256), 16).
const stampOf = (hash) => require('crypto').createHash('sha256').update(hash).digest('hex').slice(0, 16);
const publicUser = ({ password_hash, ...u }) => ({ ...u, pw_stamp: stampOf(password_hash) });

const ITEMS = [
  { id: 1, sku: 'CF', name: 'Cà phê rang xay', unit: 'g', quantity_on_hand: 5000, avg_cost: 280, min_stock: 1000, is_active: 1, is_low: 0, stock_value: 1400000 },
  { id: 2, sku: 'SUA', name: 'Sữa tươi', unit: 'ml', quantity_on_hand: 420, avg_cost: 30, min_stock: 500, is_active: 1, is_low: 1, stock_value: 12600 },
  { id: 3, sku: 'LY', name: 'Ly nhựa + nắp', unit: 'pcs', quantity_on_hand: 900, avg_cost: 900, min_stock: 50, is_active: 1, is_low: 0, stock_value: 810000, image_url: '/media/900-ly-nhua-nap.jpg' },
];
const CATEGORIES = [{ id: 1, code: 'mixed_drink', name: 'Đồ uống', sort_order: 1, is_active: 1 }, { id: 2, code: 'cigarette', name: 'Thuốc lá', sort_order: 2, is_active: 1 }];
const ORDER = {
  id: 42, order_code: 'CF261013-00042', source: 'zalo', status: 'completed', payment_status: 'unpaid', payment_method: null,
  subtotal: 79000, discount: 0, total: 79000, cogs_total: 21000, table_id: null, table_code: null, table_name: null,
  zalo_chat_type: 'user', zalo_user_id: 'z1', note: null, receipt_sent_at: null, receipt_error: 'Zalo 500', created_at: NOW, completed_at: NOW, paid_at: null,
  items: [{ id: 1, product_id: 1, product_name: 'Cà phê sữa đá', unit_price: 25000, quantity: 2, line_total: 50000, note: 'ít đá' },
    { id: 2, product_id: 2, product_name: 'Trà đào', unit_price: 29000, quantity: 1, line_total: 29000, note: null }],
};

/** Build the fakes, start the app, and return helpers. Call `stop()` in t.after. */
async function start() {
  const calls = [];
  const rec = (name, ret) => async (...args) => { calls.push({ name, args }); return typeof ret === 'function' ? ret(...args) : ret; };

  const userModel = require('../../src/models/userModel');
  const orderModel = require('../../src/models/orderModel');
  const orderService = require('../../src/services/orderService');
  const receiptService = require('../../src/services/receiptService');
  const tableModel = require('../../src/models/tableModel');
  const inventoryModel = require('../../src/models/inventoryModel');
  const inventoryService = require('../../src/services/inventoryService');
  const productModel = require('../../src/models/productModel');
  const categoryModel = require('../../src/models/categoryModel');
  const adminModel = require('../../src/models/adminModel');
  const { tokenModel } = require('../../src/models/zaloModel');
  const settingsModel = require('../../src/models/settingsModel');
  const customerModel = require('../../src/models/customerModel');
  const customerService = require('../../src/services/customerService');
  const mediaModel = require('../../src/models/mediaModel');
  const idempotencyModel = require('../../src/models/idempotencyModel');
  const { pool } = require('../../src/config/db');

  // Password changes are kept per app instance, so a changed password really invalidates older sessions.
  const hashes = new Map(USERS.map((u) => [u.id, u.password_hash]));
  const current = (u) => (u ? { ...u, password_hash: hashes.get(u.id) } : null);
  const byName = (u) => current(USERS.find((x) => x.username === u));
  mock.method(userModel, 'findByUsername', async (u) => byName(u));
  mock.method(userModel, 'findById', async (id) => { const u = current(USERS.find((x) => x.id === Number(id))); return u ? publicUser(u) : null; });
  mock.method(userModel, 'list', async () => USERS.map(publicUser));
  mock.method(userModel, 'create', rec('user.create', 99));
  mock.method(userModel, 'setPassword', rec('user.setPassword', (id, hash) => { hashes.set(Number(id), hash); }));
  mock.method(userModel, 'setActive', rec('user.setActive'));
  mock.method(userModel, 'countActiveAdmins', async () => 2);

  mock.method(orderModel, 'summary', async () => ({ orders: 3, revenue: 400000, cogs: 120000, gross_profit: 280000, unpaid: 79000 }));
  mock.method(orderModel, 'list', async () => [{ ...ORDER, items: undefined }]);
  mock.method(orderModel, 'count', async () => 60);
  mock.method(orderModel, 'breakdown', async () => ({ all: 60, draft: 2, open: 1, completed: 50, cancelled: 7, unpaid: 3, revenue: 4000000, unpaidAmount: 237000, openAmount: 79000 }));
  mock.method(orderModel, 'getItems', async () => ORDER.items);
  mock.method(orderModel, 'paidTotal', async () => 0);
  mock.method(orderModel, 'paidByMethod', async () => []);
  mock.method(orderModel, 'getPayments', async () => [{ id: 1, method: 'cash', amount: 79000, reference: null, paid_at: NOW, received_by_name: 'Thu Ngân' }]);
  mock.method(orderModel, 'getById', async () => ORDER);
  mock.method(orderModel, 'getFullByIds', async (ids) => ids.map(() => ORDER));
  mock.method(orderModel, 'getItemsByOrderIds', async (ids) => ids.flatMap((id) => ORDER.items.map((i) => ({ ...i, order_id: id }))));
  mock.method(orderModel, 'getPaymentsByOrderIds', async (ids) => ids.map((id) => ({ id: 1, order_id: id, method: 'cash', amount: 79000, reference: null, paid_at: NOW, received_by_name: 'Thu Ngân' })));
  mock.method(orderService, 'getWithItems', async (id) => { if (id === 404) { const { AppError } = require('../../src/utils/httpError'); throw new AppError(404, 'NOT_FOUND', 'Order not found'); } return ORDER; });
  mock.method(orderService, 'cancelOrder', rec('order.cancel', ORDER));
  mock.method(orderService, 'createPosOrder', rec('order.createPos', { ...ORDER, id: 77, order_code: 'CF-NEW', status: 'open' }));
  mock.method(orderService, 'replaceOpenOrderItems', rec('order.replaceItems', { ...ORDER, status: 'open' }));
  mock.method(orderService, 'payOrder', rec('order.pay', { order: ORDER, change: 0 }));
  mock.method(receiptService, 'sendReceipt', rec('receipt.send', { sent: true }));

  mock.method(tableModel, 'listAll', async () => [
    { id: 1, code: 'B01', name: 'Bàn 1', capacity: 4, status: 'serving', current_order_id: 42, current_order_code: ORDER.order_code, current_order_total: 79000, is_active: 1 },
    { id: 2, code: 'B02', name: 'Bàn 2', capacity: 2, status: 'available', current_order_id: null, is_active: 1 },
  ]);
  mock.method(tableModel, 'list', async () => [
    { id: 1, code: 'B01', name: 'Bàn 1', status: 'serving', current_order_id: 42 },
    { id: 2, code: 'B02', name: 'Bàn 2', status: 'available', current_order_id: null },
  ]);
  mock.method(tableModel, 'getById', async (id) => ({ id, status: id === 1 ? 'serving' : 'available', is_active: 1 }));
  mock.method(tableModel, 'mergedInto', async () => []);
  const supplierModel = require('../../src/models/supplierModel');
  const purchaseModel = require('../../src/models/purchaseModel');
  const SUPPLIER = { id: 1, name: 'NCC A', phone: '0909 111 222', address: 'Chợ đầu mối', tax_code: '', note: '', is_active: 1, receipts: 2, purchased: 1000000, paid: 600000, debt: 400000, last_at: NOW, created_at: NOW };
  const RECEIPT = { id: 5, receipt_code: 'PN261017-00005', supplier_id: 1, supplier_name: 'NCC A', doc_no: 'HD-1', note: null, total: 1000000, paid: 600000, debt: 400000, created_at: NOW, user_name: 'Chủ Quán', line_count: 2 };
  mock.method(supplierModel, 'list', async () => [SUPPLIER]);
  mock.method(supplierModel, 'count', async () => 1);
  mock.method(supplierModel, 'options', async () => [{ id: 1, name: 'NCC A' }]);
  mock.method(supplierModel, 'getById', async (id) => (id === 1 || id === 2 ? { ...SUPPLIER, id } : null));
  mock.method(supplierModel, 'findByName', async () => null);
  mock.method(supplierModel, 'create', rec('supplier.create', 2));
  mock.method(supplierModel, 'update', rec('supplier.update'));
  mock.method(supplierModel, 'totals', async () => ({ suppliers: 1, purchased: 1000000, paid: 600000, debt: 400000, inDebt: 1 }));
  mock.method(purchaseModel, 'insertReceipt', rec('receipt.insert', 5));
  mock.method(purchaseModel, 'getReceipt', async (id) => (id === 5 ? RECEIPT : null));
  mock.method(purchaseModel, 'insertLine', rec('receipt.line'));
  mock.method(purchaseModel, 'setTotals', rec('receipt.totals'));
  mock.method(purchaseModel, 'addPaid', rec('receipt.addPaid'));
  mock.method(purchaseModel, 'insertPayment', rec('receipt.payment', 1));
  mock.method(purchaseModel, 'listReceipts', async () => [RECEIPT]);
  mock.method(purchaseModel, 'countReceipts', async () => ({ n: 1, total: 1000000, paid: 600000 }));
  mock.method(purchaseModel, 'getLines', async () => [
    { id: 1, receipt_id: 5, inventory_item_id: 1, item_name: 'Cà phê rang xay', unit: 'g', pack_label: 'kg', pack_qty: 2, pack_factor: 1000, pack_price: 280000, quantity: 2000, unit_cost: 280, line_total: 560000 },
    { id: 2, receipt_id: 5, inventory_item_id: 3, item_name: 'Ly nhựa + nắp', unit: 'pcs', pack_label: null, pack_qty: 500, pack_factor: 1, pack_price: 880, quantity: 500, unit_cost: 880, line_total: 440000 },
  ]);
  mock.method(purchaseModel, 'receiptPayments', async () => [{ id: 1, amount: 600000, method: 'cash', note: 'Trả khi nhập hàng', paid_at: NOW, user_name: 'Chủ Quán' }]);
  mock.method(purchaseModel, 'supplierPayments', async () => [{ id: 1, amount: 600000, method: 'cash', note: 'Trả khi nhập hàng', paid_at: NOW, receipt_id: 5, receipt_code: 'PN261017-00005', user_name: 'Chủ Quán' }]);
  const expenseModel = require('../../src/models/expenseModel');
  const CATS = [
    { id: 1, code: 'nguyen-vat-lieu', name: 'Nguyên vật liệu & hàng hóa', tax_treatment: 'deductible', ledger_code: null, sort_order: 1, is_system: 1, is_active: 1, uses: 3 },
    { id: 2, code: 'thue-mat-bang', name: 'Thuê mặt bằng', tax_treatment: 'deductible', ledger_code: 'TMB', sort_order: 4, is_system: 1, is_active: 1, uses: 1 },
    { id: 3, code: 'thiet-bi', name: 'Mua thiết bị, dụng cụ', tax_treatment: 'capex', ledger_code: null, sort_order: 8, is_system: 1, is_active: 1, uses: 0 },
  ];
  const EXP = [
    { id: 21, expense_date: '2026-10-05', category_id: 2, category_name: 'Thuê mặt bằng', tax_treatment: 'deductible', amount: 8000000, vat_included: 0, payee: 'Chủ nhà', supplier_id: null, purchase_receipt_id: null, receipt_code: null, doc_no: 'PC-01', note: 'Tháng 10', receipt_media_id: 7, source: 'manual', status: 'posted', void_reason: null, created_at: NOW, user_name: 'Chủ Quán', receipt_sha256: 'ab' },
    { id: 22, expense_date: '2026-10-17', category_id: 1, category_name: 'Nguyên vật liệu & hàng hóa', tax_treatment: 'deductible', amount: 1000000, vat_included: 0, payee: 'NCC A', supplier_id: 1, purchase_receipt_id: 5, receipt_code: 'PN261017-00005', doc_no: 'HD-1', note: 'Phiếu nhập PN261017-00005', receipt_media_id: null, source: 'purchase', status: 'posted', void_reason: null, created_at: NOW, user_name: 'Chủ Quán', receipt_sha256: null },
  ];
  const taxModel = require('../../src/models/taxModel');
  const TAXCATS = [
    { id: 1, code: 'fnb_service', name: 'Dịch vụ ăn uống', sort_order: 1, is_active: 1 },
    { id: 2, code: 'goods_distribution', name: 'Bán hàng hóa nguyên trạng', sort_order: 2, is_active: 1 },
    { id: 3, code: 'none', name: 'Không chịu thuế', sort_order: 3, is_active: 1 },
  ];
  const EXPORT = { id: 11, kind: 'bundle', period_from: '2026-07-01', period_to: '2026-09-30', status: 'done', attempts: 1, file_name: '11-so-thue_2026-07-01_2026-09-30.xlsx', file_bytes: 20480, error: null, requested_by: 1, user_name: 'Chủ Quán', created_at: NOW, started_at: NOW, finished_at: NOW, expires_at: NOW };
  mock.method(taxModel, 'categories', async () => TAXCATS);
  mock.method(taxModel, 'rates', async () => [{ id: 1, category_id: 1, code: 'fnb_service', category_name: 'Dịch vụ ăn uống', effective_from: '2026-01-01', effective_to: null, vat_rate: 0.03, pit_rate: 0.015, legal_basis: 'Mặc định' }]);
  mock.method(taxModel, 'ratesOn', async () => new Map([[1, { vat: 0.03, pit: 0.015 }], [2, { vat: 0.01, pit: 0.005 }], [3, { vat: 0, pit: 0 }]]));
  mock.method(taxModel, 'addRate', rec('tax.addRate'));
  mock.method(taxModel, 'orderLines', async () => []);
  mock.method(taxModel, 'setLineTax', rec('tax.setLineTax'));
  mock.method(taxModel, 'bumpRevenue', rec('tax.bumpRevenue'));
  mock.method(taxModel, 'bumpExpense', rec('tax.bumpExpense'));
  mock.method(taxModel, 'lockedCovering', async () => null);
  mock.method(taxModel, 'revenueByCategory', async () => [
    { categoryId: 1, lines: 4000, gross: 405000000, discount: 5000000, net: 400000000, vat: 12000000, pit: 6000000 },
    { categoryId: 2, lines: 900, gross: 100000000, discount: 0, net: 100000000, vat: 1000000, pit: 500000 },
  ]);
  mock.method(taxModel, 'revenueTotal', async () => 300000000);
  mock.method(taxModel, 'expenseByTreatment', async () => ({ deductible: 80000000, non_deductible: 2000000, capex: 3500000 }));
  mock.method(taxModel, 'monthly', async () => [{ month: '2026-08', revenue: 150000000, expenses: 25000000 }, { month: '2026-09', revenue: 170000000, expenses: 28000000 }]);
  mock.method(taxModel, 'revenueRows', async () => [
    { day: '2026-09-01', categoryId: 1, lines: 40, gross: 1500000, discount: 20000, net: 1480000, vat: 44400, pit: 22200 },
    { day: '2026-09-01', categoryId: 2, lines: 5, gross: 100000, discount: 0, net: 100000, vat: 1000, pit: 500 },
  ]);
  mock.method(taxModel, 'getPeriod', async () => null);
  mock.method(taxModel, 'periods', async () => []);
  mock.method(taxModel, 'lockPeriod', rec('tax.lock'));
  mock.method(taxModel, 'unlockPeriod', rec('tax.unlock', 1));
  mock.method(taxModel, 'setFiled', rec('tax.filed'));
  mock.method(taxModel, 'insertExport', rec('export.insert', 11));
  mock.method(taxModel, 'getExport', async (id) => (id === 11 ? EXPORT : null));
  mock.method(taxModel, 'listExports', async () => [EXPORT]);
  mock.method(taxModel, 'findOpenExport', async () => null);
  mock.method(taxModel, 'claimNextExport', async () => null);
  mock.method(taxModel, 'finishExport', rec('export.finish'));
  mock.method(taxModel, 'failExport', rec('export.fail'));
  mock.method(taxModel, 'requeueStale', async () => 0);
  mock.method(taxModel, 'expiredExports', async () => []);
  mock.method(taxModel, 'clearExportFile', rec('export.clear'));
  mock.method(expenseModel, 'listCategories', async () => CATS);
  mock.method(expenseModel, 'getCategory', async (id) => CATS.find((c) => c.id === Number(id)) || null);
  mock.method(expenseModel, 'categoryByCode', async (code) => CATS.find((c) => c.code === code) || null);
  mock.method(expenseModel, 'createCategory', rec('expcat.create', 9));
  mock.method(expenseModel, 'updateCategory', rec('expcat.update'));
  mock.method(expenseModel, 'list', async () => EXP);
  mock.method(expenseModel, 'totals', async () => ({ n: 2, amount: 9000000, purchases: 1000000, manual: 8000000, deductible: 9000000 }));
  mock.method(expenseModel, 'byCategory', async () => [{ id: 2, name: 'Thuê mặt bằng', amount: 8000000, n: 1 }, { id: 1, name: 'Nguyên vật liệu & hàng hóa', amount: 1000000, n: 1 }]);
  mock.method(expenseModel, 'getById', async (id) => EXP.find((e) => e.id === Number(id)) || null);
  mock.method(expenseModel, 'insert', rec('expense.insert', 21));
  mock.method(expenseModel, 'update', rec('expense.update'));
  mock.method(expenseModel, 'setCategoryAndNote', rec('expense.setCat'));
  mock.method(expenseModel, 'setReceipt', rec('expense.setReceipt'));
  mock.method(expenseModel, 'voidExpense', rec('expense.void'));
  mock.method(expenseModel, 'findBySha', async () => null);
  mock.method(purchaseModel, 'unpaidReceipts', async () => [{ id: 5, receipt_code: 'PN261017-00005', total: 1000000, paid: 600000 }]);
  mock.method(tableModel, 'create', rec('table.create', 5));
  mock.method(tableModel, 'update', rec('table.update'));

  mock.method(inventoryModel, 'list', async ({ lowStockOnly } = {}) => ITEMS.filter((i) => !lowStockOnly || i.is_low));
  mock.method(inventoryModel, 'listAll', async () => ITEMS);
  mock.method(inventoryModel, 'getById', async (id) => ITEMS.find((i) => i.id === id) || null);
  mock.method(inventoryModel, 'movements', async () => [
    { id: 1, movement_type: 'purchase', quantity_change: 1000, unit_cost: 280, balance_after: 5000, order_id: null, note: 'NCC A', created_at: NOW },
    { id: 2, movement_type: 'sale', quantity_change: -36, unit_cost: 280, balance_after: 4000, order_id: 42, note: ORDER.order_code, created_at: NOW }]);
  mock.method(inventoryModel, 'create', rec('inventory.create', 7));
  mock.method(inventoryModel, 'usage', async (_id, days = 30) => ({ days, used: 1200, wasted: 40, received: 1000, lastPurchase: { quantity: 1000, unit_cost: 280, created_at: NOW } }));
  mock.method(inventoryModel, 'usedIn', async () => [
    { id: 1, name: 'Cà phê sữa đá', sku: 'CF-SUA-DA', price: 25000, is_active: 1, image_url: null, stock_mode: 'bom', quantity: 18 },
    { id: 2, name: 'Thuốc lá 555 <b>', sku: 'T555', price: 60000, is_active: 0, image_url: '/media/3-x.jpg', stock_mode: 'direct', quantity: 1 }]);
  mock.method(inventoryModel, 'update', rec('inventory.update'));
  mock.method(inventoryModel, 'setImage', rec('inventory.setImage'));
  mock.method(inventoryService, 'receive', rec('inventory.receive', { quantity_on_hand: 6000, avg_cost: 285.5 }));
  mock.method(inventoryService, 'adjust', rec('inventory.adjust', { quantity_on_hand: 100, delta: -20 }));

  mock.method(productModel, 'listForAdmin', async () => [
    { id: 1, category_id: 1, category_name: 'Đồ uống', sku: 'CF-SUA-DA', name: 'Cà phê sữa đá', price: 25000, stock_mode: 'bom', inventory_item_id: null, inventory_item_name: null, is_active: 1, aliases: ['Cà phê sữa đá', 'cf sữa'] },
    { id: 2, category_id: 2, category_name: 'Thuốc lá', sku: 'T555', name: 'Thuốc lá 555', price: 60000, stock_mode: 'direct', inventory_item_id: 3, inventory_item_name: 'Ly nhựa + nắp', is_active: 0, aliases: ['Thuốc lá 555'] },
  ]);
  mock.method(productModel, 'listWithCost', async () => [
    { id: 1, category_id: 1, category_name: 'Đồ uống', sku: 'CF-SUA-DA', name: 'Cà phê sữa đá', price: 25000, stock_mode: 'bom', inventory_item_id: null,
      ingredients: [{ ref: 1, name: 'Cà phê rang xay', unit: 'g', qty: 18, cost: 5040 }, { ref: 3, name: 'Ly nhựa + nắp', unit: 'pcs', qty: 1, cost: 900 }], cogs: 5940, margin: 76.24 },
    { id: 3, category_id: 1, category_name: 'Đồ uống', sku: 'EMPTY', name: 'Món chưa có công thức', price: 10000, stock_mode: 'bom', inventory_item_id: null, ingredients: [], cogs: 0, margin: 100 },
    { id: 2, category_id: 2, category_name: 'Thuốc lá', sku: 'T555', name: 'Thuốc lá 555', price: 60000, stock_mode: 'direct', inventory_item_id: 3,
      ingredients: [{ ref: 3, name: 'Ly nhựa + nắp', unit: 'pcs', qty: 1, cost: 900 }], cogs: 900, margin: 98.5 },
  ]);
  mock.method(productModel, 'getById', async (id) => (id === 1
    ? { id: 1, name: 'Cà phê sữa đá', sku: 'CF-SUA-DA', stock_mode: 'bom', inventory_item_id: null, aliases: ['Cà phê sữa đá', 'cf sữa'], recipe: [] }
    : id === 2 ? { id: 2, name: 'Thuốc lá 555', sku: 'T555', stock_mode: 'direct', inventory_item_id: 3, aliases: ['Thuốc lá 555'], recipe: [] } : null));
  mock.method(productModel, 'list', async () => [
    { id: 1, category_id: 1, category_name: 'Đồ uống', name: 'Cà phê sữa đá', price: 25000, is_active: 1 },
    { id: 4, category_id: 1, category_name: 'Đồ uống', name: 'Trà đào <b>', price: 35000, is_active: 1 },
  ]);
  mock.method(productModel, 'create', rec('product.create', 11));
  mock.method(productModel, 'update', rec('product.update'));
  mock.method(productModel, 'setActive', rec('product.setActive'));
  mock.method(productModel, 'setRecipe', rec('product.setRecipe'));
  mock.method(productModel, 'setAliases', rec('product.setAliases'));
  mock.method(productModel, 'setImage', rec('product.setImage'));
  mock.method(productModel, 'setTaxCategory', rec('product.setTax'));
  mock.method(categoryModel, 'list', async () => CATEGORIES);
  mock.method(categoryModel, 'create', rec('category.create', 3));
  mock.method(categoryModel, 'update', rec('category.update'));

  mock.method(adminModel, 'queueCounts', async () => ({ drafts: 2, open_orders: 1, unpaid: 3 }));
  mock.method(adminModel, 'receiptErrors', async () => [{ id: 42, order_code: ORDER.order_code, receipt_error: 'Zalo 500', completed_at: NOW }]);
  mock.method(adminModel, 'salesByDay', async () => [{ day: '2026-10-13', orders: 3, revenue: 400000, cogs: 120000 }]);
  mock.method(adminModel, 'salesByHour', async () => [{ hour: 9, orders: 2, revenue: 300000 }, { hour: 14, orders: 1, revenue: 100000 }]);
  mock.method(adminModel, 'salesBySource', async () => [{ source: 'pos', orders: 2, revenue: 300000, cogs: 90000 }, { source: 'zalo', orders: 1, revenue: 100000, cogs: 30000 }]);
  mock.method(adminModel, 'salesByPayment', async () => [{ method: 'cash', orders: 2, revenue: 300000 }, { method: 'unpaid', orders: 1, revenue: 100000 }]);
  mock.method(adminModel, 'topProducts', async () => [{ product_id: 1, product_name: 'Cà phê sữa đá', qty: 12, revenue: 300000, cogs: 71280 }]);
  mock.method(adminModel, 'recentPurchases', async () => [{ id: 1, inventory_item_id: 1, item_name: 'Cà phê rang xay', unit: 'g', quantity_change: 1000, unit_cost: 280, balance_after: 5000, note: 'NCC A', created_at: NOW, user_name: 'Chủ Quán' }]);
  mock.method(adminModel, 'zaloEventStats', async () => ({ received: 0, processed: 10, ignored: 2, failed: 1, lastEventAt: NOW }));
  mock.method(adminModel, 'zaloRecentEvents', async () => [{ id: 1, event_name: 'user_send_text', status: 'failed', error: 'boom <script>', num_retry: 1, received_at: NOW }]);
  mock.method(adminModel, 'topDebtors', async () => [{ zalo_user_id: 'z-1234', customer_name: 'Chị Lan', orders: 2, amount: 120000, oldest: NOW }]);
  mock.method(adminModel, 'zaloPendingDrafts', async () => [{ id: 1, chat_type: 'user', last_activity_at: NOW, expires_at: NOW, order_id: 50, order_code: 'CF-D', total: 35000 }]);
  const CUSTOMER = { id: 5, name: 'Chị Lan', phone: '0909000111', zalo_user_id: 'z-1234', note: 'văn phòng', balance: 120000, order_count: 2, created_at: NOW, updated_at: NOW };
  mock.method(customerModel, 'list', async () => [CUSTOMER]);
  mock.method(customerModel, 'count', async () => 1);
  mock.method(customerModel, 'summary', async () => ({ total_customers: 1, debt_customers: 1, total_debt: 120000 }));
  mock.method(customerModel, 'getById', async (id) => (Number(id) === 5 ? CUSTOMER : null));
  mock.method(customerModel, 'ledgerHistory', async () => [
    { id: 2, entry_type: 'payment', amount: -30000, method: 'cash', note: 'Thu nợ', created_at: NOW, order_id: null, order_code: null, created_by_name: 'boss' },
    { id: 1, entry_type: 'debt', amount: 150000, method: null, note: 'Nợ đơn CF-1', created_at: NOW, order_id: 42, order_code: ORDER.order_code, created_by_name: null },
  ]);
  mock.method(customerModel, 'orderHistory', async () => [{ ...ORDER, payment_status: 'unpaid', status: 'completed', total: 150000 }]);
  mock.method(customerModel, 'reconciliation', async () => [{ id: 5, name: 'Chị Lan', phone: '0909000111', opening: 50000, increase: 100000, decrease: 30000, closing: 120000 }]);
  mock.method(customerModel, 'statement', async () => ({ opening: 50000, increase: 100000, decrease: 30000, closing: 120000,
    entries: [{ id: 1, entry_type: 'debt', amount: 100000, created_at: NOW, order_code: ORDER.order_code, balance: 150000 }, { id: 2, entry_type: 'payment', amount: -30000, method: 'transfer', created_at: NOW, balance: 120000 }] }));
  mock.method(customerModel, 'zaloSenders', async () => [{ zalo_user_id: 'z-5678', display_name: 'Anh Tuấn', last_seen_at: NOW, order_count: 2 }]);
  mock.method(customerModel, 'create', rec('customer.create', 9));
  mock.method(customerModel, 'update', rec('customer.update'));
  mock.method(customerService, 'collect', rec('customer.collect', { amount: 50000, balance: 70000, settled: [ORDER.order_code] }));
  mock.method(customerService, 'adjust', rec('customer.adjust', { balance: 100000 }));
  const MEDIA = new Map(); let mediaSeq = 0;   // media_files, in memory
  mock.method(mediaModel, 'create', rec('media.create', ({ folder, mime, bytes }) => { const id = ++mediaSeq; MEDIA.set(id, { id, folder, mime, bytes }); return id; }));
  mock.method(mediaModel, 'get', async (id) => MEDIA.get(Number(id)) || null);
  mock.method(mediaModel, 'remove', rec('media.remove', (id) => { MEDIA.delete(Number(id)); }));
  const payonModel = require('../../src/models/payonModel');
  mock.method(payonModel, 'countNeedingAttention', async () => 0);
  mock.method(payonModel, 'listForOrder', async () => []);
  mock.method(payonModel, 'listNeedingAttention', async () => []);
  mock.method(payonModel, 'listRecent', async () => []);
  const IDEMPOTENCY = new Map();   // idempotency_keys, in memory (scope -> row)
  mock.method(idempotencyModel, 'find', async (scope) => IDEMPOTENCY.get(scope) || null);
  mock.method(idempotencyModel, 'claim', async (scope, hash) => { if (IDEMPOTENCY.has(scope)) return false; IDEMPOTENCY.set(scope, { request_hash: hash, status: null, body: null }); return true; });
  mock.method(idempotencyModel, 'complete', async (scope, status, body) => { IDEMPOTENCY.set(scope, { ...IDEMPOTENCY.get(scope), status, body: JSON.stringify(body) }); });
  mock.method(idempotencyModel, 'release', async (scope) => { IDEMPOTENCY.delete(scope); });
  mock.method(idempotencyModel, 'sweep', async () => {});
  const SETTINGS = new Map();   // app_settings, in memory
  mock.method(settingsModel, 'getByPrefix', async (prefix) => Object.fromEntries([...SETTINGS].filter(([k]) => k.startsWith(prefix))));
  mock.method(settingsModel, 'setMany', rec('settings.setMany', (values) => { for (const [k, v] of Object.entries(values)) SETTINGS.set(k, String(v)); }));
  mock.method(tokenModel, 'get', async () => ({ access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH', access_expires_at: NOW, needs_refresh: 0 }));

  // withTransaction() -> a connection that does nothing; the models above ignore it
  const conn = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, query: async () => [[]] };
  mock.method(pool, 'getConnection', async () => conn);

  const app = require('../../app');
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const encode = (form) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) p.append(k, x); return p.toString(); };

  /** Minimal cookie jar around fetch (redirects are NOT followed so tests can assert them). */
  function client() {
    const jar = new Map();
    const store = (res) => { for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i); const v = pair.slice(i + 1); if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v); } };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    async function req(path, { method = 'GET', form, json, headers = {} } = {}) {
      const res = await fetch(base + path, {
        method, redirect: 'manual',
        headers: { cookie: cookie(), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
        body: form ? encode(form) : json ? JSON.stringify(json) : undefined,
      });
      store(res);
      return res;
    }
    return { req, jar, get: (p) => req(p), post: (p, form) => req(p, { method: 'POST', form }), postJson: (p, json) => req(p, { method: 'POST', json }) };
  }

  /** Log in as `username` and return a client whose later requests carry the session. */
  async function login(username = 'boss', password = PASSWORD) {
    const c = client();
    const res = await c.post('/admin/login', { username, password });
    return { c, res };
  }

  /** The CSRF token embedded in any rendered admin page. */
  async function csrfOf(c, path = '/admin/tables') {
    const html = await (await c.get(path)).text();
    return /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1];
  }

  const stop = () => { server.close(); mock.restoreAll(); };
  const resetPasswords = () => USERS.forEach((u) => hashes.set(u.id, u.password_hash));
  return { base, calls, client, login, csrfOf, stop, resetPasswords, ORDER, PASSWORD };
}

module.exports = { start, PASSWORD };
