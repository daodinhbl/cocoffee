const env = require('../../config/env');
const { withTransaction } = require('../../config/db');
const logger = require('../../utils/logger');
const { formatVnd } = require('../../utils/text');
const productModel = require('../../models/productModel');
const orderModel = require('../../models/orderModel');
const { sessionModel } = require('../../models/zaloModel');
const orderService = require('../../services/orderService');
const receiptService = require('../../services/receiptService');
const zaloApi = require('../../services/zalo/zaloApiService');
const parser = require('./zaloOrderParser');

/**
 * Chat flow (per chat + sender, state in zalo_sessions):
 *   text with items  -> DRAFT order saved, summary sent, session = awaiting_confirm
 *   "ok" / "oke"     -> ONE transaction: draft -> completed, stock deducted, COGS fixed, session cleared
 *                       -> after COMMIT the bill is sent through the Zalo API
 *   "huy"            -> draft cancelled
 * In GROUP chats the bot stays silent unless the message is clearly meant for it
 * (order items, or a command while a draft exists), otherwise every "ok" in a group would trigger it.
 */

const TXT = {
  help: 'Chào bạn 👋 Nhắn tên món để đặt, ví dụ: "2 cà phê sữa, 1 bạc xỉu". Nhắn "menu" để xem thực đơn.',
  noDraft: 'Bạn chưa có đơn nào đang chờ xác nhận. Nhắn tên món để đặt nhé!',
  expired: (min) => `Đơn tạm đã hết hạn (quá ${min} phút). Bạn nhắn lại món giúp mình nhé!`,
  cancelled: 'Đã hủy đơn tạm. Cần đặt món khác cứ nhắn nhé!',
  busy: 'Xin lỗi, hệ thống đang bận. Bạn vui lòng thử lại sau ít phút nhé!',
  notFound: (list) => `Mình chưa tìm thấy món: ${list.map((s) => `"${s}"`).join(', ')}. Nhắn "menu" để xem thực đơn nhé!`,
  outOfStock: (names) => `Rất tiếc hiện đã hết hàng/nguyên liệu cho: ${names.join(', ')}. Bạn chọn món khác hoặc nhắn "huy" để hủy đơn nhé!`,
};

async function say(target, text) {
  try {
    await zaloApi.sendText(target, text);
  } catch (err) {
    logger.error(`Zalo reply failed (${target.chatType}:${target.chatId})`, err);
  }
}

function draftSummary(order, unmatched) {
  const lines = [
    '🧾 ĐƠN TẠM (chưa xác nhận)',
    ...order.items.map((i) => `• ${i.quantity} x ${i.product_name} — ${formatVnd(i.line_total)}đ`),
    `TỔNG: ${formatVnd(order.total)}đ`,
  ];
  if (unmatched.length) lines.push(`⚠️ Chưa tìm thấy: ${unmatched.map((s) => `"${s}"`).join(', ')}`);
  lines.push('👉 Nhắn "ok" để xác nhận, "huy" để hủy. Nhắn lại món để sửa đơn, hoặc "thêm ..." để bổ sung.');
  return lines.join('\n');
}

async function menuText() {
  const catalog = await productModel.listForMatching();
  const out = ['📋 THỰC ĐƠN'];
  let category = null;
  for (const p of catalog) {
    if (p.category_name !== category) { category = p.category_name; out.push(`\n${category}:`); }
    out.push(`• ${p.name} — ${formatVnd(p.price)}đ`);
  }
  return out.join('\n').slice(0, 1900);
}

// --------------------------------------------------------------------------- entry point
async function handleText({ chatType, chatId, userId, text, msgId }) {
  const target = { chatType, chatId };
  const isGroup = chatType === 'group';
  const ctx = { target, chatType, chatId, userId, msgId, isGroup };

  const command = parser.detectCommand(text);
  if (command === 'confirm') return confirm(ctx);
  if (command === 'cancel') return cancel(ctx);
  if (command === 'menu') return say(target, await menuText());

  const parsed = parser.parseOrder(text, await productModel.listForMatching());
  if (!parsed.items.length) {
    if (isGroup) return undefined;                                   // ignore group chatter
    return say(target, parsed.unmatched.length ? TXT.notFound(parsed.unmatched) : TXT.help);
  }

  try {
    const order = await withTransaction(async (conn) => {
      const session = await sessionModel.lockOrCreate(conn, { chatType, chatId, userId });
      const orderId = await orderService.upsertZaloDraft(conn, {
        session, chatType, chatId, userId, items: parsed.items, mode: parsed.append ? 'append' : 'replace',
      });
      await sessionModel.setDraft(conn, session.id, orderId, msgId, env.zalo.draftTtlMinutes);
      return orderService.getWithItems(orderId, conn);
    });
    return say(target, draftSummary(order, parsed.unmatched));
  } catch (err) {
    logger.error('Draft creation failed', err);
    return say(target, TXT.busy);
  }
}

// --------------------------------------------------------------------------- confirm
async function confirm({ target, chatType, chatId, userId, isGroup }) {
  let outcome;
  try {
    outcome = await withTransaction(async (conn) => {
      const session = await sessionModel.find(conn, { chatType, chatId, userId }, { forUpdate: true });
      if (!session || !session.draft_order_id) return { status: 'no_draft' };

      if (session.is_expired) {
        await orderService.cancelDraft(conn, session.draft_order_id);
        await sessionModel.clearDraft(conn, session.id);
        return { status: 'expired' };
      }

      // Draft -> Completed + inventory deduction + COGS. Any throw below rolls back EVERYTHING
      // (order status, stock, ledger, session): the draft stays confirmable.
      await orderService.confirmDraft(conn, session.draft_order_id);
      await sessionModel.clearDraft(conn, session.id);
      return { status: 'ok', orderId: session.draft_order_id };
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_STOCK') return say(target, TXT.outOfStock(err.details?.products?.length ? err.details.products : [err.message]));
    if (err.code === 'ORDER_NOT_DRAFT') return say(target, TXT.noDraft);
    logger.error('Order confirmation rolled back', err);
    return say(target, TXT.busy);
  }

  switch (outcome.status) {
    case 'ok': {
      // After COMMIT: a delivery problem must never undo the sale; it is stored on the order for retry.
      const result = await receiptService.sendReceipt(outcome.orderId);
      if (!result.sent) logger.warn(`Order ${outcome.orderId} completed but receipt not delivered: ${result.error}`);
      return undefined;
    }
    case 'expired': return say(target, TXT.expired(env.zalo.draftTtlMinutes));
    default: return isGroup ? undefined : say(target, TXT.noDraft);
  }
}

// --------------------------------------------------------------------------- cancel
async function cancel({ target, chatType, chatId, userId, isGroup }) {
  const had = await withTransaction(async (conn) => {
    const session = await sessionModel.find(conn, { chatType, chatId, userId }, { forUpdate: true });
    if (!session || !session.draft_order_id) return false;
    await orderService.cancelDraft(conn, session.draft_order_id);
    await sessionModel.clearDraft(conn, session.id);
    return true;
  });
  if (had) return say(target, TXT.cancelled);
  return isGroup ? undefined : say(target, TXT.noDraft);
}

module.exports = { handleText, draftSummary };
