const inventoryModel = require('../models/inventoryModel');
const adminModel = require('../models/adminModel');

/**
 * What the notification bell is about, as data: low stock, bills waiting to be collected, Zalo receipts that
 * failed to send. The Web Admin turns it into Vietnamese rows; GET /api/admin/notifications returns it as is.
 */
async function load({ receiptErrors = 3 } = {}) {
  const [low, counts, failed] = await Promise.all([
    inventoryModel.list({ lowStockOnly: true }), adminModel.queueCounts(), adminModel.receiptErrors(receiptErrors),
  ]);
  return {
    low_stock: low.map((i) => ({ id: i.id, name: i.name, unit: i.unit, quantity_on_hand: Number(i.quantity_on_hand), min_stock: Number(i.min_stock) })),
    counts: { drafts: Number(counts.drafts) || 0, open_orders: Number(counts.open_orders) || 0, unpaid: Number(counts.unpaid) || 0 },
    receipt_errors: failed.map((e) => ({ id: e.id, order_code: e.order_code, receipt_error: e.receipt_error, completed_at: e.completed_at })),
  };
}

module.exports = { load };
