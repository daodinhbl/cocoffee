const adminModel = require('../../models/adminModel');
const notificationService = require('../../services/notificationService');
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

module.exports = { status, drafts, notifications };
