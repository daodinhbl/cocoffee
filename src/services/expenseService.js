const crypto = require('crypto');
const { withTransaction } = require('../config/db');
const { AppError } = require('../utils/httpError');
const expenseModel = require('../models/expenseModel');
const auditModel = require('../models/auditModel');
const taxModel = require('../models/taxModel');
const imageStore = require('./imageStore');
const taxService = require('./taxService');
const { shopDay, parseDay, addDays } = require('../utils/shopTime');
const logger = require('../utils/logger');

/**
 * Sổ chi phí (operating expenses).
 *  - manual rows: rent, salaries, electricity ... typed in, with an optional photo of the invoice;
 *  - purchase rows: one per stock receipt (phiếu nhập kho), created in the receipt's own transaction by fromReceipt(),
 *    so every purchase is a recorded expense without typing it twice. They can change category / note only; the money
 *    follows the receipt.
 * Rows are never deleted: "void" keeps the row and the reason (it drops out of every total).
 * Receipt photos are stored in media_files (folder "expense") and are served to admins only.
 */
const MAX_AMOUNT = 1e11;
const PURCHASE_CATEGORY = 'nguyen-vat-lieu';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function checkDate(value) {
  const day = parseDay(String(value || ''));
  if (!day) throw new AppError(400, 'VALIDATION', 'Ngày chi không hợp lệ.');
  if (day > addDays(shopDay(), 1)) throw new AppError(400, 'VALIDATION', 'Ngày chi không được ở tương lai.');
  return day;
}

function checkAmount(value) {
  const n = Number(value);
  if (!(n > 0) || n > MAX_AMOUNT) throw new AppError(400, 'VALIDATION', 'Số tiền không hợp lệ.');
  return Math.round(n * 100) / 100;
}

async function activeCategory(id, conn) {
  const c = await expenseModel.getCategory(id, conn);
  if (!c || !c.is_active) throw new AppError(400, 'VALIDATION', 'Chọn danh mục chi phí.');
  return c;
}

/** Validates + stores a receipt photo (data URL); returns { mediaId, sha256 } or null. A photo already used by another expense is refused. */
async function storePhoto(dataUrl, exceptId = 0) {
  if (!dataUrl) return null;
  const { buf } = imageStore.decode(dataUrl);
  const hash = sha256(buf);
  const dup = await expenseModel.findBySha(hash, exceptId);
  if (dup) throw new AppError(409, 'DUPLICATE_RECEIPT', `Ảnh chứng từ này đã được dùng cho khoản chi #${dup.id} (${Number(dup.amount).toLocaleString('vi-VN')}đ).`);
  const url = await imageStore.saveBuffer(buf, 'expense', 'chung-tu');
  return { mediaId: imageStore.mediaIdOf(url), sha256: hash, url };
}

async function create({ expenseDate, categoryId, amount, vatIncluded = false, payee, supplierId = null, docNo, note, userId, imageData }) {
  const date = checkDate(expenseDate);
  const money = checkAmount(amount);
  await activeCategory(categoryId);
  await taxService.assertOpenDay(date);
  const photo = await storePhoto(imageData);
  try {
    return await withTransaction(async (conn) => {
      const id = await expenseModel.insert({
        expenseDate: date, categoryId, amount: money, vatIncluded, payee, supplierId, docNo, note,
        receiptMediaId: photo && photo.mediaId, receiptSha256: photo && photo.sha256, source: 'manual', createdBy: userId,
      }, conn);
      await taxModel.bumpExpense({ day: date, categoryId, amount: money, count: 1 }, conn);
      try {
        await auditModel.write(conn, { userId, action: 'expense.create', entity: `expense:${id}`, details: { amount: money, categoryId, date } });
      } catch (err) {
        logger.error('Audit log write failed (expense)', err);
      }
      return id;
    });
  } catch (err) {
    if (photo) await imageStore.remove(photo.url);                  // do not leave an orphan photo behind
    throw err;
  }
}

/** imageData: new photo (data URL) · removeImage: true to drop the current one. */
async function update(id, { expenseDate, categoryId, amount, vatIncluded, payee, docNo, note, userId, imageData, removeImage = false }) {
  const current = await expenseModel.getById(id);
  if (!current) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy khoản chi.');
  if (current.status === 'void') throw new AppError(409, 'EXPENSE_VOID', 'Khoản chi này đã hủy.');
  if (categoryId) await activeCategory(categoryId);

  const day = String(current.expense_date).slice(0, 10);
  await taxService.assertOpenDay(day);
  if (current.source === 'purchase') {                              // the money belongs to the stock receipt
    await withTransaction(async (conn) => {
      await expenseModel.setCategoryAndNote(id, { categoryId, note }, conn);
      if (categoryId && categoryId !== current.category_id) {
        await taxModel.bumpExpense({ day, categoryId: current.category_id, amount: -Number(current.amount), count: -1 }, conn);
        await taxModel.bumpExpense({ day, categoryId, amount: Number(current.amount), count: 1 }, conn);
      }
    });
    return;
  }
  const date = checkDate(expenseDate);
  const money = checkAmount(amount);
  await taxService.assertOpenDay(date);
  const photo = await storePhoto(imageData, id);
  await withTransaction(async (conn) => {
    await expenseModel.update(id, { expenseDate: date, categoryId, amount: money, vatIncluded, payee, docNo, note }, conn);
    await taxModel.bumpExpense({ day, categoryId: current.category_id, amount: -Number(current.amount), count: -1 }, conn);
    await taxModel.bumpExpense({ day: date, categoryId: categoryId || current.category_id, amount: money, count: 1 }, conn);
    try {
      await auditModel.write(conn, { userId, action: 'expense.update', entity: `expense:${id}`, details: { amount: money, categoryId, was: Number(current.amount) } });
    } catch (err) {
      logger.error('Audit log write failed (expense)', err);
    }
  });
  if (photo) {
    await expenseModel.setReceipt(id, photo.mediaId, photo.sha256);
    if (current.receipt_media_id) await imageStore.remove(`/media/${current.receipt_media_id}-x.jpg`).catch(() => {});
  } else if (removeImage && current.receipt_media_id) {
    await expenseModel.setReceipt(id, null, null);
  }
}

async function voidExpense(id, { reason, userId }) {
  return withTransaction(async (conn) => {
    const e = await expenseModel.getById(id, conn, { forUpdate: true });
    if (!e) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy khoản chi.');
    if (e.status === 'void') throw new AppError(409, 'EXPENSE_VOID', 'Khoản chi này đã hủy.');
    if (e.source === 'purchase') throw new AppError(409, 'PURCHASE_EXPENSE', 'Khoản chi này sinh từ phiếu nhập kho nên không hủy riêng được.');
    await taxService.assertOpenDay(String(e.expense_date).slice(0, 10), conn);
    const why = String(reason || '').trim().slice(0, 255);
    if (!why) throw new AppError(400, 'VALIDATION', 'Nhập lý do hủy khoản chi.');
    await expenseModel.voidExpense(id, why, userId, conn);
    await taxModel.bumpExpense({ day: String(e.expense_date).slice(0, 10), categoryId: e.category_id, amount: -Number(e.amount), count: -1 }, conn);
    try {
      await auditModel.write(conn, { userId, action: 'expense.void', entity: `expense:${id}`, details: { reason: why, amount: Number(e.amount) } });
    } catch (err) {
      logger.error('Audit log write failed (expense)', err);
    }
  });
}

/** Called inside purchaseService.createReceipt's transaction: the receipt becomes one "nguyên vật liệu" expense. */
async function fromReceipt(conn, { receiptId, code, total, supplierId, supplierName, docNo, userId }) {
  if (!(total > 0)) return null;
  const category = await expenseModel.categoryByCode(PURCHASE_CATEGORY, conn);
  if (!category) return null;                                       // categories not seeded yet: the boot backfill adds the row later
  const day = shopDay();
  await taxModel.bumpExpense({ day, categoryId: category.id, amount: total, count: 1 }, conn);
  return expenseModel.insert({
    expenseDate: day, categoryId: category.id, amount: total, payee: supplierName || 'Mua lẻ', supplierId, purchaseReceiptId: receiptId,
    docNo, note: `Phiếu nhập ${code}`, source: 'purchase', createdBy: userId,
  }, conn);
}

module.exports = { create, update, voidExpense, fromReceipt, PURCHASE_CATEGORY, MAX_AMOUNT };
