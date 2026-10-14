const logger = require('../../utils/logger');
const { formatVnd } = require('../../utils/text');
const orderModel = require('../../models/orderModel');
const billMedia = require('./billMedia');
const chatbotInfo = require('./chatbotInfo');

/**
 * What a customer receives for a confirmed order, shared by the chatbot ("ok") and the admin "Gửi lại bill":
 *   1. the 80 mm PNG receipt; when the picture cannot be made or the channel refuses it, the text bill instead;
 *   2. when the order is still to be paid and the shop has a bank account: the account, amount and transfer
 *      content as text, then the VietQR code for that amount.
 * `io` is the channel: { reply(text), image?({ url, base64, mime, caption }), textBill() }. Never throws: each step
 * is attempted on its own and what happened is returned, so a failed picture can be told to the owner.
 * @returns {Promise<{ bill: 'picture'|'text'|'none', paymentInfo: boolean, qr: boolean, pictureError: string|null, error: string|null }>}
 */
async function deliver(io, orderId) {
  const result = { bill: 'none', paymentInfo: false, qr: false, pictureError: null, error: null };

  if (io.image) {
    try {
      const picture = await billMedia.receipt(orderId);
      if (!picture) result.pictureError = 'Không vẽ được ảnh hóa đơn (thiếu font hoặc thư viện ảnh trên máy chủ).';
      else {
        await io.image({ ...picture, caption: '🧾 Hóa đơn của bạn' });
        result.bill = 'picture';
      }
    } catch (err) {
      result.pictureError = err.message;
      logger.warn(`Receipt picture of order ${orderId} not delivered, sending the text bill`, err);
    }
  } else {
    result.pictureError = 'Kênh này không gửi được ảnh.';
  }

  if (result.bill === 'none') {
    try {
      await io.textBill();
      result.bill = 'text';
    } catch (err) {
      result.error = err.message;
      logger.warn(`Text bill of order ${orderId} not delivered`, err);
    }
  }

  try {
    const [order, info] = await Promise.all([orderModel.getById(orderId), chatbotInfo.get()]);
    if (order && order.payment_status !== 'paid' && chatbotInfo.bankReady(info)) {
      await io.reply(billMedia.paymentText(order, info));
      result.paymentInfo = true;
      if (io.image) {
        const qr = await billMedia.payQr(orderId, info);
        if (qr) {
          await io.image({ ...qr, caption: `Quét mã để chuyển ${formatVnd(order.total)}đ (nội dung ${billMedia.transferNote(order)})` });
          result.qr = true;
        }
      }
    }
  } catch (err) {
    result.error = result.error || err.message;
    logger.warn(`Payment info of order ${orderId} not delivered`, err);   // the bill above already went out
  }
  return result;
}

module.exports = { deliver };
