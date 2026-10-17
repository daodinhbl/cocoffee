const { withTransaction } = require('../config/db');
const taxModel = require('../models/taxModel');
const settingsModel = require('../models/settingsModel');
const auditModel = require('../models/auditModel');
const { AppError } = require('../utils/httpError');
const { shopDay, parseDay, addDays } = require('../utils/shopTime');
const logger = require('../utils/logger');

/**
 * Tax for a household business that declares (kê khai), ESTIMATED from the daily rollups, never from scanning orders:
 *  - at completion every order line gets a snapshot (tax group, VAT / PIT rate in force that day, net revenue after its
 *    share of the order discount), and the day's rollup (rev_daily) grows in the same transaction;
 *  - a period (month / quarter / year) is a sum over at most a few hundred rollup rows;
 *  - rates live in tax_rates with effective dates, so a change of law is a new row, never a rewrite of the past.
 * The figures are estimates to prepare the declaration; the accountant decides what is declared (docs/thiet-ke-*.md).
 */
const PREFIX = 'tax.';
const DEFAULTS = { exemptThreshold: 500000000, pitMethod: 'revenue', profitRate: 0.15 };
const KINDS = ['month', 'quarter', 'year'];
const GOODS = 'goods_distribution';
const SERVICE = 'fnb_service';

const round2 = (n) => Math.round(n * 100) / 100;
const round0 = (n) => Math.round(n);

// ------------------------------------------------------------------ configuration
async function getConfig() {
  let raw = {};
  try {
    raw = await settingsModel.getByPrefix(PREFIX);
  } catch (err) {
    logger.warn('Tax settings unavailable, using defaults', err);
  }
  const threshold = Number(raw[`${PREFIX}exemptThreshold`]);
  const profitRate = Number(raw[`${PREFIX}profitRate`]);
  return {
    exemptThreshold: Number.isFinite(threshold) && threshold >= 0 && raw[`${PREFIX}exemptThreshold`] !== undefined && raw[`${PREFIX}exemptThreshold`] !== '' ? threshold : DEFAULTS.exemptThreshold,
    pitMethod: raw[`${PREFIX}pitMethod`] === 'profit' ? 'profit' : DEFAULTS.pitMethod,
    profitRate: Number.isFinite(profitRate) && profitRate > 0 && profitRate < 1 ? profitRate : DEFAULTS.profitRate,
  };
}

async function saveConfig({ exemptThreshold, pitMethod, profitRate }, userId) {
  const t = Number(exemptThreshold);
  const r = Number(profitRate);
  if (!(t >= 0) || t > 1e12) throw new AppError(400, 'VALIDATION', 'Ngưỡng doanh thu không hợp lệ.');
  if (!['revenue', 'profit'].includes(pitMethod)) throw new AppError(400, 'VALIDATION', 'Chọn cách tính thuế TNCN.');
  if (!(r > 0 && r < 1)) throw new AppError(400, 'VALIDATION', 'Thuế suất trên lợi nhuận phải nằm trong khoảng 0–100%.');
  await settingsModel.setMany({ [`${PREFIX}exemptThreshold`]: String(Math.round(t)), [`${PREFIX}pitMethod`]: pitMethod, [`${PREFIX}profitRate`]: String(r) }, userId);
}

// ------------------------------------------------------------------ periods
const lastOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');

/** { kind, from, to, label } of the month / quarter / year containing `day`. */
function periodOf(kind, day = shopDay()) {
  if (!KINDS.includes(kind)) throw new AppError(400, 'VALIDATION', 'Kỳ phải là tháng, quý hoặc năm.');
  const d = parseDay(day) || shopDay();
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  if (kind === 'month') return { kind, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastOfMonth(y, m))}`, label: `Tháng ${m}/${y}` };
  if (kind === 'quarter') {
    const q = Math.ceil(m / 3);
    const first = (q - 1) * 3 + 1;
    return { kind, from: `${y}-${pad(first)}-01`, to: `${y}-${pad(first + 2)}-${pad(lastOfMonth(y, first + 2))}`, label: `Quý ${q}/${y}` };
  }
  return { kind, from: `${y}-01-01`, to: `${y}-12-31`, label: `Năm ${y}` };
}

/** The neighbouring period (step -1 / +1). */
function shiftPeriod(kind, day, step) {
  const p = periodOf(kind, day);
  return periodOf(kind, step < 0 ? addDays(p.from, -1) : addDays(p.to, 1));
}

// ------------------------------------------------------------------ snapshot at completion
/** Default group for a line: retail goods sold as they are vs drinks / food prepared here. */
const defaultCode = (line) => (line.stockMode === 'direct' ? GOODS : SERVICE);

/**
 * Called inside finalizeOrder's transaction, after the order is completed: tax snapshot per line + today's rollup.
 * The order discount is shared over the lines in proportion to their value (the last line takes the rounding rest).
 */
async function snapshotOrder(conn, order, { day = shopDay(), rollup = true } = {}) {
  const lines = await taxModel.orderLines(order.id, conn);
  if (!lines.length) return;
  const cats = await taxModel.categories(conn);
  const byCode = new Map(cats.map((c) => [c.code, c.id]));
  if (!byCode.size) return;                                           // tax tables not seeded yet: the boot backfill + rollup catch up later
  const rates = await taxModel.ratesOn(day, conn);
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const discount = Math.min(Number(order.discount) || 0, subtotal);
  let left = discount;
  const sums = new Map();
  lines.forEach((l, i) => {
    const share = i === lines.length - 1 ? left : Math.min(left, round2(subtotal > 0 ? (discount * l.lineTotal) / subtotal : 0));
    left = round2(left - share);
    const categoryId = l.productTax || byCode.get(defaultCode(l));
    const rate = rates.get(categoryId) || { vat: 0, pit: 0 };
    const net = round2(l.lineTotal - share);
    l.snap = { categoryId, vatRate: rate.vat, pitRate: rate.pit, netRevenue: net, share };
    const s = sums.get(categoryId) || { lines: 0, gross: 0, discount: 0, net: 0, vat: 0, pit: 0 };
    s.lines += 1; s.gross += l.lineTotal; s.discount += share; s.net += net; s.vat += net * rate.vat; s.pit += net * rate.pit;
    sums.set(categoryId, s);
  });
  for (const l of lines) await taxModel.setLineTax(l.id, l.snap, conn);
  if (!rollup) return;                                              // history backfill: rollups are rebuilt from the snapshot afterwards
  for (const [categoryId, s] of sums) {
    await taxModel.bumpRevenue({ day, categoryId, lines: s.lines, gross: round2(s.gross), discount: round2(s.discount), net: round2(s.net), vat: round2(s.vat), pit: round2(s.pit) }, conn);
  }
}

// ------------------------------------------------------------------ estimate
/**
 * Estimated VAT and PIT of [from, to].
 *  - exemption: only the part of the YEAR's revenue above the threshold is taxed, so this period's tax is
 *    (revenue above threshold within the period / period revenue) x the period's computed tax;
 *  - PIT 'revenue' method: sum of net x PIT rate of each line; 'profit' method: (taxable revenue - deductible expenses) x rate.
 */
async function estimate(from, to, { config } = {}) {
  const cfg = config || await getConfig();
  const [cats, split, expenses] = await Promise.all([taxModel.categories(), taxModel.revenueByCategory(from, to), taxModel.expenseByTreatment(from, to)]);
  const name = new Map(cats.map((c) => [c.id, c.name]));
  const yearStart = `${from.slice(0, 4)}-01-01`;
  const before = from > yearStart ? await taxModel.revenueTotal(yearStart, addDays(from, -1)) : 0;
  const lines = split.map((r) => ({ ...r, name: name.get(r.categoryId) || `#${r.categoryId}` })).sort((a, b) => b.net - a.net);
  const net = lines.reduce((s, r) => s + r.net, 0);
  const vat0 = lines.reduce((s, r) => s + r.vat, 0);
  const pit0 = lines.reduce((s, r) => s + r.pit, 0);
  const through = before + net;
  const above = Math.max(0, through - Math.max(cfg.exemptThreshold, before));
  const share = net > 0 ? Math.min(1, above / net) : 0;
  const vatDue = round0(vat0 * share);
  const pitDue = cfg.pitMethod === 'profit'
    ? round0(Math.max(0, above - expenses.deductible * share) * cfg.profitRate)
    : round0(pit0 * share);
  const expenseTotal = expenses.deductible + expenses.non_deductible + expenses.capex;
  return {
    from, to, config: cfg, categories: lines,
    revenue: { gross: lines.reduce((s, r) => s + r.gross, 0), discount: lines.reduce((s, r) => s + r.discount, 0), net },
    expenses: { ...expenses, total: expenseTotal },
    profit: net - expenses.deductible,
    year: { before, through, threshold: cfg.exemptThreshold, exempt: through <= cfg.exemptThreshold, remaining: Math.max(0, cfg.exemptThreshold - through) },
    taxableRevenue: round0(above),
    vatBeforeThreshold: round0(vat0), pitBeforeThreshold: round0(pit0),
    vat: vatDue, pit: pitDue, tax: vatDue + pitDue,
  };
}

/** Estimate + the stored lock (if any) + the neighbours, for a page or the app. */
async function overview(kind, day) {
  const p = periodOf(kind, day);
  const [est, locked, months] = await Promise.all([
    estimate(p.from, p.to),
    taxModel.getPeriod(p.kind, p.from),
    taxModel.monthly(addDays(shopDay(), -183).slice(0, 8) + '01', shopDay()),
  ]);
  return { period: p, prev: shiftPeriod(kind, day, -1), next: shiftPeriod(kind, day, 1), estimate: est, lock: locked ? { status: locked.status, lockedAt: locked.locked_at, filedRef: locked.filed_ref, totals: safeJson(locked.totals_json) } : null, months };
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// ------------------------------------------------------------------ lock / unlock
/** Locks a FINISHED period: the figures are stored; expenses dated inside it can no longer be added or changed. */
async function lockPeriod(kind, day, userId) {
  const p = periodOf(kind, day);
  if (p.to >= shopDay()) throw new AppError(409, 'PERIOD_NOT_OVER', `${p.label} chưa kết thúc nên chưa khóa kỳ được.`);
  const est = await estimate(p.from, p.to);
  return withTransaction(async (conn) => {
    await taxModel.lockPeriod({ kind: p.kind, from: p.from, to: p.to, totals: est, userId }, conn);
    await auditModel.write(conn, { userId, action: 'tax.lock', entity: `period:${p.kind}:${p.from}`, details: { revenue: est.revenue.net, vat: est.vat, pit: est.pit } }).catch((err) => logger.error('Audit log write failed (tax lock)', err));
    return p;
  });
}

async function unlockPeriod(kind, day, userId) {
  const p = periodOf(kind, day);
  const existing = await taxModel.getPeriod(p.kind, p.from);
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Kỳ này chưa khóa.');
  if (existing.status === 'filed') throw new AppError(409, 'PERIOD_FILED', 'Kỳ đã nộp tờ khai nên không mở khóa được.');
  await withTransaction(async (conn) => {
    await taxModel.unlockPeriod(p.kind, p.from, conn);
    await auditModel.write(conn, { userId, action: 'tax.unlock', entity: `period:${p.kind}:${p.from}`, details: {} }).catch((err) => logger.error('Audit log write failed (tax unlock)', err));
  });
  return p;
}

async function markFiled(kind, day, ref, userId) {
  const p = periodOf(kind, day);
  const existing = await taxModel.getPeriod(p.kind, p.from);
  if (!existing) throw new AppError(409, 'NOT_LOCKED', 'Khóa kỳ trước khi đánh dấu đã nộp.');
  await withTransaction(async (conn) => {
    await taxModel.setFiled(p.kind, p.from, String(ref || '').trim().slice(0, 100), conn);
    await auditModel.write(conn, { userId, action: 'tax.filed', entity: `period:${p.kind}:${p.from}`, details: { ref } }).catch(() => {});
  });
  return p;
}

/** Expenses may not be created / changed / voided inside a locked period. */
async function assertOpenDay(day, conn) {
  const locked = await taxModel.lockedCovering(day, conn);
  if (locked) throw new AppError(409, 'PERIOD_LOCKED', `Ngày ${day} nằm trong kỳ thuế đã khóa (${locked.period_from} → ${locked.period_to}). Mở khóa kỳ trước khi sửa.`);
}

// ------------------------------------------------------------------ rates
async function addRate({ categoryId, effectiveFrom, vatRate, pitRate, legalBasis, userId }) {
  const day = parseDay(String(effectiveFrom || ''));
  const vat = Number(vatRate);
  const pit = Number(pitRate);
  if (!day) throw new AppError(400, 'VALIDATION', 'Ngày hiệu lực không hợp lệ.');
  if (!(vat >= 0 && vat <= 1) || !(pit >= 0 && pit <= 1)) throw new AppError(400, 'VALIDATION', 'Thuế suất phải trong khoảng 0–100%.');
  const cats = await taxModel.categories();
  if (!cats.some((c) => c.id === categoryId)) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy nhóm thuế.');
  const existing = (await taxModel.rates()).find((r) => r.category_id === categoryId && String(r.effective_from).slice(0, 10) === day);
  if (existing) throw new AppError(409, 'DUPLICATE', 'Nhóm này đã có thuế suất bắt đầu cùng ngày.');
  await taxModel.addRate({ categoryId, effectiveFrom: day, vatRate: vat, pitRate: pit, legalBasis: String(legalBasis || '').slice(0, 200), userId });
}

module.exports = {
  DEFAULTS, KINDS, getConfig, saveConfig, periodOf, shiftPeriod, snapshotOrder, estimate, overview, lockPeriod, unlockPeriod, markFiled, assertOpenDay, addRate, defaultCode,
};
