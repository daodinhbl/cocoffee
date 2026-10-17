const { withTransaction } = require('../config/db');
const { AppError } = require('../utils/httpError');
const inventoryModel = require('../models/inventoryModel');
const supplierModel = require('../models/supplierModel');
const purchaseModel = require('../models/purchaseModel');
const auditModel = require('../models/auditModel');
const inventoryService = require('./inventoryService');
const expenseService = require('./expenseService');
const logger = require('../utils/logger');

/**
 * Purchase slips (phiếu nhập kho) with several lines, supplier and payment.
 *
 * A line is entered in the unit it was bought in ("2 thùng, 240.000đ / thùng") and booked in the stock unit
 * ("48 chai at 10.000đ / chai"): quantity = packQty × packFactor, unitCost = packPrice / packFactor. The stock
 * ledger (inventoryService.receive) only ever sees stock units, so the moving-average cost stays per chai / per g.
 *
 * Money: receipt.total = sum of the lines; receipt.paid = what has been paid (at once or later). A receipt without a
 * supplier is a cash purchase and counts as fully paid. Debt per supplier = sum(total - paid).
 */
const METHODS = ['cash', 'transfer', 'other'];
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {{ supplierId?: number|null, docNo?: string, note?: string, userId: number, paid?: number|'all'|null, method?: string,
 *           lines: Array<{ itemId: number, packQty: number, packFactor?: number, packPrice: number, packLabel?: string }> }} p
 * @returns {Promise<{ id: number, code: string, total: number, paid: number, lines: number }>}
 */
async function createReceipt({ supplierId = null, docNo = null, note = null, userId = null, paid = 'all', method = 'cash', lines }) {
  if (!Array.isArray(lines) || !lines.length) throw new AppError(400, 'VALIDATION', 'Phiếu nhập chưa có mặt hàng nào.');
  if (!METHODS.includes(method)) throw new AppError(400, 'VALIDATION', 'Hình thức thanh toán không hợp lệ.');
  return withTransaction(async (conn) => {
    let supplierName = null;
    if (supplierId) {
      const supplier = await supplierModel.getById(supplierId, conn, { forUpdate: true });
      if (!supplier) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nhà cung cấp.');
      supplierName = supplier.name;
    }
    const receiptId = await purchaseModel.insertReceipt({ supplierId, docNo, note, createdBy: userId }, conn);
    const receipt = await purchaseModel.getReceipt(receiptId, conn);
    const code = receipt.receipt_code;
    let total = 0;
    for (const l of lines) {
      const factor = l.packFactor && l.packFactor > 0 ? l.packFactor : 1;
      const item = await inventoryModel.getById(l.itemId, conn);
      if (!item) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nguyên liệu.');
      const quantity = Math.round(l.packQty * factor * 1000) / 1000;
      const unitCost = Math.round((l.packPrice / factor) * 10000) / 10000;
      const lineTotal = round2(l.packQty * l.packPrice);
      const detail = factor !== 1 ? `${l.packQty} ${l.packLabel || 'gói'} × ${factor}` : '';
      const lineNote = [code, docNo && `HĐ: ${docNo}`, note, detail].filter(Boolean).join(' · ').slice(0, 255);
      await inventoryService.receive(conn, l.itemId, quantity, unitCost, { userId, note: lineNote });
      await purchaseModel.insertLine(receiptId, {
        itemId: l.itemId, itemName: item.name, unit: item.unit, packLabel: factor !== 1 ? (l.packLabel || null) : null,
        packQty: l.packQty, packFactor: factor, packPrice: l.packPrice, quantity, unitCost, lineTotal,
      }, conn);
      total += lineTotal;
    }
    total = round2(total);
    let paidNow = paid === 'all' || paid === null || paid === undefined ? total : round2(Number(paid));
    if (!supplierId) paidNow = total;                                   // no supplier: a cash purchase, nothing is owed
    if (!(paidNow >= 0) || paidNow > total) throw new AppError(400, 'VALIDATION', 'Số tiền đã trả không được lớn hơn tổng tiền hàng.');
    await purchaseModel.setTotals(receiptId, total, paidNow, conn);
    // the purchase is also an operating expense (sổ chi phí), booked in the same transaction
    await expenseService.fromReceipt(conn, { receiptId, code, total, supplierId, supplierName: supplierName, docNo, userId });
    if (supplierId && paidNow > 0) {
      await purchaseModel.insertPayment({ supplierId, receiptId, amount: paidNow, method, note: 'Trả khi nhập hàng', createdBy: userId }, conn);
    }
    try {
      await auditModel.write(conn, { userId, action: 'purchase.create', entity: `receipt:${receiptId}`, details: { code, supplierId, total, paid: paidNow, lines: lines.length } });
    } catch (err) {
      logger.error('Audit log write failed (purchase)', err);
    }
    return { id: receiptId, code, total, paid: paidNow, lines: lines.length };
  });
}

/**
 * Pay a supplier's debt, oldest receipt first. `receiptId` pays that receipt only.
 * @returns {Promise<{ amount: number, receipts: number, debtLeft: number }>}
 */
async function payDebt({ supplierId, receiptId = null, amount, method = 'cash', note = null, userId = null }) {
  const pay = round2(Number(amount));
  if (!(pay > 0)) throw new AppError(400, 'VALIDATION', 'Nhập số tiền trả nhà cung cấp.');
  if (!METHODS.includes(method)) throw new AppError(400, 'VALIDATION', 'Hình thức thanh toán không hợp lệ.');
  return withTransaction(async (conn) => {
    const supplier = await supplierModel.getById(supplierId, conn, { forUpdate: true });
    if (!supplier) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nhà cung cấp.');
    let open = await purchaseModel.unpaidReceipts(supplierId, conn);
    if (receiptId) open = open.filter((r) => r.id === receiptId);
    const owed = round2(open.reduce((s, r) => s + (Number(r.total) - Number(r.paid)), 0));
    if (!open.length) throw new AppError(409, 'NOTHING_OWED', 'Không còn khoản nợ nào để trả.');
    if (pay > owed) throw new AppError(422, 'OVERPAY', `Số tiền trả lớn hơn công nợ còn lại (${owed.toLocaleString('vi-VN')}đ).`);
    let left = pay;
    let touched = 0;
    for (const r of open) {
      if (left <= 0) break;
      const part = round2(Math.min(left, Number(r.total) - Number(r.paid)));
      await purchaseModel.addPaid(r.id, part, conn);
      await purchaseModel.insertPayment({ supplierId, receiptId: r.id, amount: part, method, note, createdBy: userId }, conn);
      left = round2(left - part);
      touched += 1;
    }
    try {
      await auditModel.write(conn, { userId, action: 'supplier.pay', entity: `supplier:${supplierId}`, details: { amount: pay, receiptId, method } });
    } catch (err) {
      logger.error('Audit log write failed (supplier payment)', err);
    }
    return { amount: pay, receipts: touched, debtLeft: round2(owed - pay) };
  });
}

module.exports = { createReceipt, payDebt, METHODS };
