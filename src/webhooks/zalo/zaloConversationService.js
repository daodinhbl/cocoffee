const env = require('../../config/env');
const { withTransaction } = require('../../config/db');
const logger = require('../../utils/logger');
const { formatVnd } = require('../../utils/text');
const productModel = require('../../models/productModel');
const orderModel = require('../../models/orderModel');
const { sessionModel } = require('../../models/zaloModel');
const orderService = require('../../services/orderService');
const parser = require('./zaloOrderParser');

/**
 * Chat flow (per chat + sender, state in zalo_sessions). Transport-agnostic: the caller passes
 *   io.reply(text)            - how a message reaches the chat (bot HTTP response, or the OA API)
 *   io.onConfirmed(orderId)   - what to do with the bill after COMMIT
 *
 *   text with items  -> DRAFT order saved, summary replied, session = awaiting_confirm
 *   "ok" / "oke"     -> ONE transaction: draft -> completed, stock deducted, COGS fixed, session cleared
 *                       -> after COMMIT the bill goes out through io.onConfirmed
 *   "huy"            -> draft cancelled
 * In GROUP chats the bot stays silent unless the message is clearly meant for it
 * (order items, or a command while a draft exists), otherwise every "ok" in a group would trigger it.
 * Drafts are per sender even inside a group, so one customer's "ok" never confirms another's order.
 *
 * Returns the action taken: 'draft' | 'confirmed' | 'cancelled' | 'expired' | 'menu' | 'help' | 'ignored' | 'error'.
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

/** Deliver a reply; a delivery failure is logged, never thrown (the order state is already saved). */
async function say(ctx, text, action) {
  try {
    await ctx.io.reply(text);
  } catch (err) {
    logger.error(`Zalo reply failed (${ctx.chatType}:${ctx.chatId})`, err);
  }
  return action;
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
async function handleText({ chatType, chatId, userId, text, msgId }, io) {
  const isGroup = chatType === 'group';
  const ctx = { io, chatType, chatId, userId, msgId, isGroup };

  const command = parser.detectCommand(text);
  if (command === 'identity') {
    if (isGroup) return 'ignored';
    return say(ctx, [
      '🆔 THÔNG TIN CHAT ZALO',
      'Chat ID: ' + chatId,
      'User ID: ' + userId,
      'Loại chat: ' + chatType,
      'Sao chép Chat ID để cấu hình nhận thông báo công nợ.',
    ].join('\n'), 'identity');
  }
  if (command === 'confirm') return confirm(ctx);
  if (command === 'cancel') return cancel(ctx);
  if (command === 'menu') return say(ctx, await menuText(), 'menu');

  const parsed = parser.parseOrder(text, await productModel.listForMatching());
  if (!parsed.items.length) {
    if (isGroup) return 'ignored';                                   // ignore group chatter
    return say(ctx, parsed.unmatched.length ? TXT.notFound(parsed.unmatched) : TXT.help, 'help');
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
    return say(ctx, draftSummary(order, parsed.unmatched), 'draft');
  } catch (err) {
    logger.error('Draft creation failed', err);
    return say(ctx, TXT.busy, 'error');
  }
}

// --------------------------------------------------------------------------- confirm
async function confirm(ctx) {
  const { chatType, chatId, userId, isGroup } = ctx;
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
      const orderId = session.draft_order_id;                        // read before the session is cleared
      await orderService.confirmDraft(conn, orderId);
      await sessionModel.clearDraft(conn, session.id);
      return { status: 'ok', orderId };
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_STOCK') return say(ctx, TXT.outOfStock(err.details?.products?.length ? err.details.products : [err.message]), 'error');
    if (err.code === 'ORDER_NOT_DRAFT') return say(ctx, TXT.noDraft, 'ignored');
    logger.error('Order confirmation rolled back', err);
    return say(ctx, TXT.busy, 'error');
  }

  switch (outcome.status) {
    case 'ok':
      // After COMMIT: a delivery problem must never undo the sale (the transport records it on the order).
      try {
        await ctx.io.onConfirmed(outcome.orderId);
      } catch (err) {
        logger.warn(`Order ${outcome.orderId} completed but the bill was not delivered`, err);
      }
      return 'confirmed';
    case 'expired': return say(ctx, TXT.expired(env.zalo.draftTtlMinutes), 'expired');
    default: return isGroup ? 'ignored' : say(ctx, TXT.noDraft, 'ignored');
  }
}

// --------------------------------------------------------------------------- cancel
async function cancel(ctx) {
  const { chatType, chatId, userId, isGroup } = ctx;
  const had = await withTransaction(async (conn) => {
    const session = await sessionModel.find(conn, { chatType, chatId, userId }, { forUpdate: true });
    if (!session || !session.draft_order_id) return false;
    await orderService.cancelDraft(conn, session.draft_order_id);
    await sessionModel.clearDraft(conn, session.id);
    return true;
  });
  if (had) return say(ctx, TXT.cancelled, 'cancelled');
  return isGroup ? 'ignored' : say(ctx, TXT.noDraft, 'ignored');
}

module.exports = { handleText, draftSummary };
