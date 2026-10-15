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

const n = (x) => Number(x) || 0;

async function recentOrders(limit) {
  const rows = await orderModel.list({ limit });
  const full = [];
  for (let i = 0; i < rows.length; i += 20) {                                   // small batches: the pool is tiny
    const slice = rows.slice(i, i + 20);
    const parts = await Promise.all(slice.map(async (o) => ({
      ...o, items: await orderModel.getItems(o.id), payments: await orderModel.getPayments(o.id),
    })));
    full.push(...parts);
  }
  return full;
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
    snapshot.customer_stats = {
      total_customers: n(summary.total_customers), debt_customers: n(summary.debt_customers), total_debt: n(summary.total_debt),
    };
  } else {
    snapshot.inventory = { items: await inventoryModel.list() };
  }
  return snapshot;
}

module.exports = { build, RECENT_ORDERS, MAX_CUSTOMERS };
