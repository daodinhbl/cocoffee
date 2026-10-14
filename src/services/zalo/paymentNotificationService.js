const env = require('../../config/env');
const logger = require('../../utils/logger');
const { formatVnd, formatShopTime } = require('../../utils/text');
const orderModel = require('../../models/orderModel');
const zaloConfig = require('./zaloConfig');
const billMedia = require('./billMedia');

/**
 * "Đã nhận thanh toán": what the customer gets on Zalo when the shop presses "Thu tiền".
 *   - an order paid (Admin > Đơn hàng, POS "Chờ thu tiền", the app): a confirmation with amount and method, then the
 *     receipt picture again, now marked ĐÃ THANH TOÁN (and the copy under uploads is overwritten with it);
 *   - a debt collected from the customer's page: amount received, the balance still owed, the orders settled.
 * Delivery is a courtesy: nothing here can undo a payment, every function resolves to a status string and never
 * throws. Statuses: 'sent' | 'not_zalo' | 'not_linked' | 'not_paid' | 'push_not_supported' | 'failed' | 'pending'.
 */
const METHOD_LABEL = { cash: 'Tiền mặt', transfer: 'Chuyển khoản', card: 'Thẻ', other: 'Khác' };
const money = (n) => `${formatVnd(Math.round(Number(n) || 0))}đ`;

/** The channel to push into, or null when the Zalo mode cannot push (Bot Client). Lazy: receiptService needs this module's peers. */
async function channel(order, text = '') {
  const { mode } = await zaloConfig.get();
  return require('../receiptService').channelFor(order, mode, text);
}

function orderPaidText(order, payment) {
  const lines = [
    '✅ ĐÃ NHẬN THANH TOÁN',
    `Cửa hàng: ${env.business.shopName}`,
    `Đơn: ${order.order_code}`,
    `Số tiền: ${money(payment ? payment.amount : order.total)}`,
  ];
  if (payment && payment.method) lines.push(`Hình thức: ${METHOD_LABEL[payment.method] || payment.method}`);
  lines.push(`Thời gian: ${formatShopTime((payment && payment.paid_at) || new Date())}`, 'Cảm ơn quý khách! ☕');
  return lines.join('\n');
}

/** Confirmation of a paid Zalo order. */
async function notifyOrderPaid(orderId) {
  try {
    const order = await orderModel.getById(orderId);
    if (!order || order.source !== 'zalo' || !order.zalo_chat_id) return 'not_zalo';
    if (order.payment_status !== 'paid') return 'not_paid';
    const io = await channel(order);
    if (!io) return 'push_not_supported';
    const payments = await orderModel.getPayments(orderId).catch(() => []);
    await io.reply(orderPaidText(order, payments.length ? payments[payments.length - 1] : null));
    try {                                                   // the receipt again, now stamped paid: a courtesy on top
      const picture = await billMedia.receipt(orderId);
      if (picture) await io.image({ ...picture, caption: '🧾 Hóa đơn đã thanh toán' });
    } catch (err) {
      logger.warn(`Paid receipt picture of order ${orderId} not delivered`, err);
    }
    return 'sent';
  } catch (err) {
    logger.warn(`Payment confirmation of order ${orderId} not delivered`, err);
    return 'failed';
  }
}

/**
 * Like notifyOrderPaid, but the caller (the "Thu tiền" button) waits at most `ms` for the answer: a slow Zalo never
 * holds up the cashier. After the cap the message keeps being delivered in the background ('pending').
 */
async function notifyOrderPaidSoon(orderId, ms = 4000) {
  let timer;
  const work = notifyOrderPaid(orderId);
  const cap = new Promise((resolve) => { timer = setTimeout(() => resolve('pending'), ms); });
  try {
    return await Promise.race([work, cap]);
  } finally {
    clearTimeout(timer);
  }
}

/** Confirmation of a debt collection to the customer's linked Zalo account. */
async function notifyDebtCollected({ customer, amount, balance, settled = [], method }) {
  try {
    if (!customer || !customer.zalo_user_id) return 'not_linked';
    const io = await channel({ zalo_chat_id: String(customer.zalo_user_id), zalo_chat_type: 'user' });
    if (!io) return 'push_not_supported';
    const lines = [
      '✅ ĐÃ NHẬN THANH TOÁN CÔNG NỢ',
      `Cửa hàng: ${env.business.shopName}`,
      `Khách hàng: ${customer.name}`,
      `Số tiền đã thu: ${money(amount)}${method ? ` (${METHOD_LABEL[method] || method})` : ''}`,
    ];
    if (settled.length) lines.push(`Đơn đã tất toán: ${settled.join(', ')}`);
    lines.push(Number(balance) > 0 ? `Công nợ còn lại: ${money(balance)}` : 'Bạn đã hết công nợ. Cảm ơn bạn! 🙏');
    await io.reply(lines.join('\n'));
    return 'sent';
  } catch (err) {
    logger.warn('Debt collection confirmation not delivered', err);
    return 'failed';
  }
}

/** Sentence for the admin's flash message. */
function describe(status) {
  switch (status) {
    case 'sent': return ' Đã gửi xác nhận thanh toán cho khách qua Zalo.';
    case 'pending': return ' Tin xác nhận cho khách đang được gửi qua Zalo.';
    case 'not_linked': return ' Khách chưa liên kết Zalo nên chưa nhận được tin xác nhận.';
    case 'push_not_supported': return ' Chế độ Zalo hiện tại không gửi tin chủ động cho khách.';
    case 'failed': return ' Gửi xác nhận cho khách qua Zalo không thành công.';
    default: return '';
  }
}

module.exports = { notifyOrderPaid, notifyOrderPaidSoon, notifyDebtCollected, describe, orderPaidText };
