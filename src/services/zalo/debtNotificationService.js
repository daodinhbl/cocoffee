const env = require('../../config/env');
const logger = require('../../utils/logger');
const zaloConfig = require('./zaloConfig');
const zaloBot = require('./zaloBotPlatform');
const zaloApi = require('./zaloApiService');

const money = (value) => new Intl.NumberFormat('vi-VN').format(Math.round(Number(value) || 0)) + 'đ';

async function deliver(chatId, chatType, text) {
  const config = await zaloConfig.get();
  if (config.mode === 'platform') return zaloBot.sendText(chatId, text);
  if (config.mode === 'oa') return zaloApi.sendText({ chatType, chatId }, text);
  return { skipped: 'push_not_supported' };
}

function customerMessage({ customer, amount, balance, note }) {
  return [
    '📌 THÔNG BÁO CÔNG NỢ',
    'Cửa hàng: ' + env.business.shopName,
    'Khách hàng: ' + customer.name,
    'Số tiền ghi nợ: +' + money(amount),
    'Lý do: ' + note,
    'Công nợ hiện tại: ' + money(balance),
    'Vui lòng liên hệ cửa hàng nếu cần đối chiếu. Xin cảm ơn!',
  ].join('\n');
}

function ownerMessage({ customer, amount, balance, note }) {
  return [
    '🔔 GHI TĂNG CÔNG NỢ',
    'Khách hàng: ' + customer.name,
    'Số tiền: +' + money(amount),
    'Lý do: ' + note,
    'Số dư công nợ mới: ' + money(balance),
  ].join('\n');
}

/** Notify after the ledger transaction commits; delivery problems never undo a saved debt entry. */
async function notifyIncrease(details) {
  const config = await zaloConfig.get();
  const results = { customer: 'not_linked', owner: 'not_configured' };

  const tasks = [];
  if (details.customer.zalo_user_id) {
    tasks.push(
      deliver(String(details.customer.zalo_user_id), 'user', customerMessage(details))
        .then((r) => { results.customer = r?.skipped || 'sent'; })
        .catch((err) => {
          results.customer = 'failed';
          logger.warn('Could not send debt notice to customer', err);
        })
    );
  }

  if (config.debtOwnerChatId) {
    const chatType = config.debtOwnerChatType || 'user';
    tasks.push(
      deliver(config.debtOwnerChatId, chatType, ownerMessage(details))
        .then((r) => { results.owner = r?.skipped || 'sent'; })
        .catch((err) => {
          results.owner = 'failed';
          logger.warn('Could not send debt notice to shop owner', err);
        })
    );
  }

  await Promise.all(tasks);
  return results;
}

/** The sentence the admin sees after a debt notice (customer and owner parts). */
function describe(sent) {
  if (!sent) return '';
  let m = '';
  if (sent.customer === 'sent') m += ' Đã gửi Zalo cho khách.';
  else if (sent.customer === 'not_linked') m += ' Khách chưa liên kết Zalo nên chưa nhận được tin.';
  else if (sent.customer === 'failed') m += ' Gửi Zalo cho khách không thành công.';
  else if (sent.customer === 'push_not_supported') m += ' Chế độ Zalo hiện tại không hỗ trợ gửi tin chủ động cho khách.';
  if (sent.owner === 'sent') m += ' Đã báo chủ quán qua Zalo.';
  else if (sent.owner === 'failed') m += ' Gửi Zalo cho chủ quán không thành công.';
  return m;
}

module.exports = { notifyIncrease, describe };
