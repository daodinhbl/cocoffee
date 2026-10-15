const categoryModel = require('../models/categoryModel');
const productModel = require('../models/productModel');
const tableModel = require('../models/tableModel');
const inventoryModel = require('../models/inventoryModel');
const customerModel = require('../models/customerModel');
const orderModel = require('../models/orderModel');
const adminModel = require('../models/adminModel');
const inventoryService = require('./inventoryService');
const printerSettings = require('./printerSettings');

/**
 * What the Android app copies into its local SQLite database to keep working without a connection
 * (GET /api/sync/snapshot). Every collection has the shape of the matching list endpoint, so the app can answer
 * those screens locally. Staff get the POS data (menu, tables, recent orders); admins also get the whole
 * inventory and customer list.
 */
const RECENT_ORDERS = 200;
const MAX_CUSTOMERS = 5000;
const LEDGER_CUSTOMERS = 300;             // customers whose debt history is copied (those owing, then the most recently active)
const LEDGER_ROWS = 50;

const n = (x) => Number(x) || 0;

async function recentOrders(limit) {
  const rows = await orderModel.list({ limit });
  const ids = rows.map((o) => o.id);
  const [full, items, payments] = await Promise.all([
    orderModel.getFullByIds(ids), orderModel.getItemsByOrderIds(ids), orderModel.getPaymentsByOrderIds(ids),
  ]);
  const group = (arr) => { const m = new Map(); for (const x of arr) { if (!m.has(x.order_id)) m.set(x.order_id, []); m.get(x.order_id).push(x); } return m; };
  const fullById = new Map(full.map((o) => [o.id, o]));
  const itemsBy = group(items);
  const paymentsBy = group(payments);
  return rows.map((o) => ({                       // the full row (subtotal, discount, table_name, paid_at...) over the list row
    ...o, ...(fullById.get(o.id) || {}), items: itemsBy.get(o.id) || [], payments: paymentsBy.get(o.id) || [],
  }));
}

/** { customerId: newest ledger rows } for the customers the shop is most likely to open offline. */
async function ledgers(customers) {
  const owing = customers.filter((c) => n(c.balance) !== 0);
  const recent = customers.filter((c) => n(c.balance) === 0);
  const chosen = [...owing, ...recent].slice(0, LEDGER_CUSTOMERS);
  const out = {};
  for (let i = 0; i < chosen.length; i += 10) {
    const slice = chosen.slice(i, i + 10);
    const rows = await Promise.all(slice.map((c) => customerModel.ledgerHistory(c.id, LEDGER_ROWS)));
    slice.forEach((c, k) => { out[c.id] = rows[k]; });
  }
  return out;
}

async function build(user) {
  const isAdmin = user.role === 'admin';
  const [categories, products, tables, drafts, printer, orders] = await Promise.all([
    categoryModel.list({ activeOnly: false }), productModel.list({ activeOnly: false }), isAdmin ? tableModel.listAll() : tableModel.list(),
    adminModel.zaloPendingDrafts(20), printerSettings.get(), recentOrders(RECENT_ORDERS),
  ]);
  const snapshot = {
    generated_at: new Date().toISOString(),
    role: user.role,
    categories, products, tables, drafts, printer, orders,
  };
  if (isAdmin) {
    const [{ items, stockValue }, customers, summary] = await Promise.all([
      inventoryService.listWithValue(), customerModel.list({ limit: MAX_CUSTOMERS, offset: 0 }), customerModel.summary(),
    ]);
    snapshot.inventory = { items, stock_value: stockValue };
    snapshot.customers = customers.map((c) => ({ ...c, balance: n(c.balance), order_count: n(c.order_count) }));
    snapshot.ledgers = await ledgers(snapshot.customers);
    snapshot.customer_stats = {
      total_customers: n(summary.total_customers), debt_customers: n(summary.debt_customers), total_debt: n(summary.total_debt),
    };
  } else {
    snapshot.inventory = { items: await inventoryModel.list() };
  }
  return snapshot;
}

module.exports = { build, RECENT_ORDERS, MAX_CUSTOMERS };
