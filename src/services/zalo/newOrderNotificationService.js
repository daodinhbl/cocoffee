const env = require('../../config/env');
const logger = require('../../utils/logger');
const { formatVnd, formatShopTime } = require('../../utils/text');
const orderModel = require('../../models/orderModel');
const customerModel = require('../../models/customerModel');
const zaloConfig = require('./zaloConfig');
const zaloBot = require('./zaloBotPlatform');
const zaloApi = require('./zaloApiService');

/**
 * "Có đơn mới": the shop owner's Zalo chat (the one saved as the debt recipient in Admin > Zalo) is told when a
 * customer confirms an order on Zalo. A courtesy after COMMIT: it never throws and never holds the customer up.
 * Statuses: 'sent' | 'not_configured' | 'same_chat' | 'push_not_supported' | 'not_found' | 'failed'.
 */
const money = (n) => `${formatVnd(Math.round(Number(n) || 0))}đ`;

async function deliver(config, text) {
  if (config.mode === 'platform') return zaloBot.sendText(config.debtOwnerChatId, text);
  if (config.mode === 'oa') return zaloApi.sendText({ chatType: config.debtOwnerChatType, chatId: config.debtOwnerChatId }, text);
  return { skipped: 'push_not_supported' };
}

function message(order, items, customerName) {
  const lines = ['🛎️ CÓ ĐƠN MỚI', `Cửa hàng: ${env.business.shopName}`, `Đơn: ${order.order_code}`];
  if (customerName) lines.push(`Khách: ${customerName}`);
  lines.push('');
  for (const i of items) lines.push(`• ${i.quantity} × ${i.product_name}${i.note ? ` (${i.note})` : ''}`);
  lines.push('', `Tổng: ${money(order.total)}`, `Thời gian: ${formatShopTime(order.completed_at || order.created_at || new Date())}`);
  return lines.join('\n');
}

async function notifyNewOrder(orderId) {
  try {
    const config = await zaloConfig.get();
    if (!config.debtOwnerChatId) return 'not_configured';
    const order = await orderModel.getById(orderId);
    if (!order) return 'not_found';
    if (String(order.zalo_chat_id || '') === String(config.debtOwnerChatId)) return 'same_chat';   // the owner ordered from this chat
    const items = await orderModel.getItems(orderId);
    const customer = order.zalo_user_id ? await customerModel.findByZaloUser(order.zalo_user_id).catch(() => null) : null;
    const r = await deliver(config, message(order, items, customer && customer.name));
    return r && r.skipped ? r.skipped : 'sent';
  } catch (err) {
    logger.warn(`New-order notice for order ${orderId} not delivered`, err);
    return 'failed';
  }
}

module.exports = { notifyNewOrder, message };
