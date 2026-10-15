const adminModel = require('../../models/adminModel');
const notificationService = require('../../services/notificationService');
const syncSnapshot = require('../../services/syncSnapshotService');
const { zaloStatus } = require('../../services/zalo/zaloStatus');

/** App shell: Zalo status dot (any staff), live Zalo drafts (any staff), notification bell (admin). */

/** GET /api/zalo/status and /api/admin/zalo/status -> { state: ok|warn|off|unknown, label } */
async function status(_req, res) {
  res.json(await zaloStatus());
}

/** GET /api/zalo/drafts?limit= (default 20, max 100): Zalo drafts still waiting for the customer (not expired). */
async function drafts(req, res) {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const rows = await adminModel.zaloPendingDrafts(limit);
  res.json({
    drafts: rows.map((d) => ({
      id: d.id, chat_type: d.chat_type, last_activity_at: d.last_activity_at, expires_at: d.expires_at,
      order_id: d.order_id, order_code: d.order_code, total: Number(d.total || 0),
    })),
  });
}

/** GET /api/admin/notifications -> { low_stock, counts: { drafts, open_orders, unpaid }, receipt_errors } */
async function notifications(_req, res) {
  res.json(await notificationService.load({ receiptErrors: 3 }));
}

/**
 * GET /api/admin/new-orders?after_id=N -> { last_id, orders: [{ id, order_code, total, item_count, customer_name, completed_at }] }
 * Zalo orders confirmed after order N. The app polls it; without after_id (first run) it only returns last_id.
 */
async function newOrders(req, res) {
  const after = parseInt(req.query.after_id, 10);
  const { rows, lastId } = await adminModel.newZaloOrders(Number.isInteger(after) && after >= 0 ? after : lastIdSentinel, 20);
  res.json({
    last_id: lastId,
    orders: Number.isInteger(after) && after >= 0 ? rows.map((o) => ({
      id: o.id, order_code: o.order_code, total: Number(o.total || 0), item_count: Number(o.item_count || 0),
      customer_name: o.customer_name || null, completed_at: o.completed_at,
    })) : [],
  });
}
const lastIdSentinel = Number.MAX_SAFE_INTEGER;   // no after_id: match nothing, just report last_id

/** GET /api/sync/snapshot: everything the app mirrors into its offline database (see services/syncSnapshotService.js). */
async function snapshot(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json(await syncSnapshot.build(req.user));
}

module.exports = { status, drafts, notifications, newOrders, snapshot };
