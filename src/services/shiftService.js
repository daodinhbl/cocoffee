const { withTransaction } = require('../config/db');
const { AppError } = require('../utils/httpError');
const shiftModel = require('../models/shiftModel');
const auditModel = require('../models/auditModel');
const { shopDay } = require('../utils/shopTime');
const logger = require('../utils/logger');

/**
 * Chốt ca (close the shift) at the POS. A shift is the period since the previous closing (the first one starts at the
 * beginning of the shop's day). Closing stores the totals - takings per payment method, orders, discounts, debt - and
 * what the cashier counted in the till, so the difference is on record. Nothing is locked: orders keep working.
 */
const MONEY_MAX = 1e11;

const startOfFirstShift = () => `${shopDay()} 00:00:00`;

async function figures(from, to, conn) {
  const [pay, totals] = await Promise.all([shiftModel.paymentsByMethod(from, to, conn), shiftModel.orderTotals(from, to, conn)]);
  return { pay, totals };
}

/** What the close dialog shows: the open period and the till the cashier should find. */
async function preview() {
  const prev = await shiftModel.last();
  const from = prev ? prev.period_to : startOfFirstShift();
  const to = await shiftModel.now();
  const { pay, totals } = await figures(from, to);
  return { from, to, pay, totals, suggestedOpening: prev ? Number(prev.counted_cash) : 0, recent: await shiftModel.recent(8) };
}

const money = (value, name) => {
  const n = value === undefined || value === null || value === '' ? 0 : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MONEY_MAX) throw new AppError(400, 'VALIDATION', `${name} không hợp lệ.`);
  return Math.round(n);
};

/** @returns {Promise<object>} the stored shift */
async function close({ openingCash, countedCash, note, userId }) {
  const opening = money(openingCash, 'Tiền đầu ca');
  const counted = money(countedCash, 'Tiền mặt đếm được');
  const text = typeof note === 'string' ? note.trim().slice(0, 255) : '';
  return withTransaction(async (conn) => {
    const prev = await shiftModel.last(conn, { forUpdate: true });
    const to = await shiftModel.now(conn);
    const from = prev ? prev.period_to : startOfFirstShift();
    const { pay, totals } = await figures(from, to, conn);
    const expected = opening + pay.cash;
    let id;
    try {
      id = await shiftModel.insert({ from, to, closedBy: userId, openingCash: opening, countedCash: counted, expectedCash: expected, difference: counted - expected, pay, totals, note: text }, conn);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError(409, 'SHIFT_EXISTS', 'Ca này vừa được chốt. Mở lại hộp thoại để xem ca mới.');
      throw err;
    }
    try {
      await auditModel.write(conn, { userId, action: 'shift.close', entity: `shift:${id}`, details: { opening, counted, expected, difference: counted - expected, revenue: totals.revenue } });
    } catch (err) {
      logger.error('Audit log write failed (shift)', err);
    }
    return shiftModel.getById(id, conn);
  });
}

module.exports = { preview, close };
