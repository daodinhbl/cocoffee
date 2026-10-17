const { pool } = require('../config/db');

const db = (conn) => conn || pool;

/** Tax groups, dated rates, the daily rollups of revenue and expenses, tax periods and export jobs. */

// ------------------------------------------------------------------ groups & rates
async function categories(conn) {
  const [rows] = await db(conn).query('SELECT id, code, name, sort_order, is_active FROM tax_categories ORDER BY sort_order, id');
  return rows;
}

/** Every rate row, newest first per group (for the settings table). */
async function rates(conn) {
  const [rows] = await db(conn).query(
    `SELECT r.id, r.category_id, c.code, c.name AS category_name, r.effective_from, r.effective_to, r.vat_rate, r.pit_rate, r.legal_basis
       FROM tax_rates r JOIN tax_categories c ON c.id = r.category_id ORDER BY c.sort_order, r.effective_from DESC`
  );
  return rows;
}

/** The rate in force for each group on `day` (latest effective_from <= day, not past effective_to). */
async function ratesOn(day, conn) {
  const [rows] = await db(conn).query(
    `SELECT r.category_id, r.vat_rate, r.pit_rate
       FROM tax_rates r
       JOIN (SELECT category_id, MAX(effective_from) AS f FROM tax_rates
              WHERE effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) GROUP BY category_id) m
         ON m.category_id = r.category_id AND m.f = r.effective_from`,
    [day, day]
  );
  return new Map(rows.map((r) => [r.category_id, { vat: Number(r.vat_rate), pit: Number(r.pit_rate) }]));
}

/** New rate row: the previous one of the group (if still open) ends the day before. */
async function addRate({ categoryId, effectiveFrom, vatRate, pitRate, legalBasis, userId }, conn) {
  await db(conn).query(
    `UPDATE tax_rates SET effective_to = DATE_SUB(?, INTERVAL 1 DAY)
      WHERE category_id = ? AND effective_to IS NULL AND effective_from < ?`, [effectiveFrom, categoryId, effectiveFrom]
  );
  await db(conn).query(
    'INSERT INTO tax_rates (category_id, effective_from, vat_rate, pit_rate, legal_basis, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [categoryId, effectiveFrom, vatRate, pitRate, legalBasis || null, userId || null]
  );
}

// ------------------------------------------------------------------ order snapshot
/** Lines of an order with the product's own tax group (if any) and its stock mode (to pick a default group). */
async function orderLines(orderId, conn) {
  const [rows] = await db(conn).query(
    `SELECT oi.id, oi.line_total, p.tax_category_id AS product_tax, p.stock_mode
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id`, [orderId]
  );
  return rows.map((r) => ({ id: r.id, lineTotal: Number(r.line_total), productTax: r.product_tax, stockMode: r.stock_mode }));
}

async function setLineTax(itemId, { categoryId, vatRate, pitRate, netRevenue }, conn) {
  await db(conn).query('UPDATE order_items SET tax_category_id = ?, vat_rate = ?, pit_rate = ?, net_revenue = ? WHERE id = ?', [categoryId, vatRate, pitRate, netRevenue, itemId]);
}

// ------------------------------------------------------------------ rollups
async function bumpRevenue({ day, categoryId, lines, gross, discount, net, vat, pit }, conn) {
  await db(conn).query(
    `INSERT INTO rev_daily (day, tax_category_id, lines_count, gross_revenue, discount, net_revenue, vat_amount, pit_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE lines_count = lines_count + VALUES(lines_count), gross_revenue = gross_revenue + VALUES(gross_revenue),
       discount = discount + VALUES(discount), net_revenue = net_revenue + VALUES(net_revenue),
       vat_amount = vat_amount + VALUES(vat_amount), pit_amount = pit_amount + VALUES(pit_amount)`,
    [day, categoryId, lines, gross, discount, net, vat, pit]
  );
}

async function bumpExpense({ day, categoryId, amount, count }, conn) {
  await db(conn).query(
    `INSERT INTO exp_daily (day, category_id, amount, tx_count) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount), tx_count = tx_count + VALUES(tx_count)`,
    [day, categoryId, amount, count]
  );
}

/** Rebuilds rev_daily for [from, to] from the order lines' own snapshot. */
async function rebuildRevenue(from, to, conn) {
  await db(conn).query('DELETE FROM rev_daily WHERE day >= ? AND day <= ?', [from, to]);
  const [res] = await db(conn).query(
    `INSERT INTO rev_daily (day, tax_category_id, lines_count, gross_revenue, discount, net_revenue, vat_amount, pit_amount)
     SELECT DATE(o.completed_at), oi.tax_category_id, COUNT(*), SUM(oi.line_total), SUM(oi.line_total - oi.net_revenue), SUM(oi.net_revenue),
            ROUND(SUM(oi.net_revenue * oi.vat_rate), 2), ROUND(SUM(oi.net_revenue * oi.pit_rate), 2)
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'completed' AND oi.tax_category_id IS NOT NULL AND DATE(o.completed_at) >= ? AND DATE(o.completed_at) <= ?
      GROUP BY DATE(o.completed_at), oi.tax_category_id`, [from, to]
  );
  return res.affectedRows;
}

async function rebuildExpenses(from, to, conn) {
  await db(conn).query('DELETE FROM exp_daily WHERE day >= ? AND day <= ?', [from, to]);
  const [res] = await db(conn).query(
    `INSERT INTO exp_daily (day, category_id, amount, tx_count)
     SELECT expense_date, category_id, SUM(amount), COUNT(*) FROM expenses
      WHERE status = 'posted' AND expense_date >= ? AND expense_date <= ? GROUP BY expense_date, category_id`, [from, to]
  );
  return res.affectedRows;
}

/** What the source tables say for [from, to] (to compare with the rollups). */
async function sourceTotals(from, to, conn) {
  const [[o]] = await db(conn).query(
    `SELECT COALESCE(SUM(oi.net_revenue), 0) AS net FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'completed' AND oi.tax_category_id IS NOT NULL AND DATE(o.completed_at) >= ? AND DATE(o.completed_at) <= ?`, [from, to]);
  const [[e]] = await db(conn).query("SELECT COALESCE(SUM(amount), 0) AS amount FROM expenses WHERE status = 'posted' AND expense_date >= ? AND expense_date <= ?", [from, to]);
  return { net: Number(o.net), expenses: Number(e.amount) };
}

/** Completed lines that still have no tax snapshot (orders from before the tax feature), oldest first. */
async function unsnapshotted(limit, conn) {
  const [rows] = await db(conn).query(
    `SELECT DISTINCT o.id, DATE(o.completed_at) AS day FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status = 'completed' AND oi.tax_category_id IS NULL ORDER BY o.id LIMIT ?`, [limit]
  );
  return rows;
}

async function revenueRows(from, to, conn) {
  const [rows] = await db(conn).query(
    `SELECT day, tax_category_id, lines_count, gross_revenue, discount, net_revenue, vat_amount, pit_amount
       FROM rev_daily WHERE day >= ? AND day <= ? ORDER BY day, tax_category_id`, [from, to]);
  return rows.map((r) => ({
    day: r.day, categoryId: r.tax_category_id, lines: Number(r.lines_count), gross: Number(r.gross_revenue), discount: Number(r.discount),
    net: Number(r.net_revenue), vat: Number(r.vat_amount), pit: Number(r.pit_amount),
  }));
}

/** Sum of rev_daily by group over [from, to]. */
async function revenueByCategory(from, to, conn) {
  const [rows] = await db(conn).query(
    `SELECT tax_category_id, SUM(lines_count) AS n_lines, SUM(gross_revenue) AS gross, SUM(discount) AS discount, SUM(net_revenue) AS net,
            SUM(vat_amount) AS vat, SUM(pit_amount) AS pit FROM rev_daily WHERE day >= ? AND day <= ? GROUP BY tax_category_id`, [from, to]);
  return rows.map((r) => ({ categoryId: r.tax_category_id, lines: Number(r.n_lines), gross: Number(r.gross), discount: Number(r.discount), net: Number(r.net), vat: Number(r.vat), pit: Number(r.pit) }));
}

async function revenueTotal(from, to, conn) {
  const [[r]] = await db(conn).query('SELECT COALESCE(SUM(net_revenue), 0) AS net FROM rev_daily WHERE day >= ? AND day <= ?', [from, to]);
  return Number(r.net);
}

/** Expenses by tax treatment over [from, to] from exp_daily. */
async function expenseByTreatment(from, to, conn) {
  const [rows] = await db(conn).query(
    `SELECT c.tax_treatment, COALESCE(SUM(d.amount), 0) AS amount FROM exp_daily d JOIN expense_categories c ON c.id = d.category_id
      WHERE d.day >= ? AND d.day <= ? GROUP BY c.tax_treatment`, [from, to]);
  const out = { deductible: 0, non_deductible: 0, capex: 0 };
  for (const r of rows) out[r.tax_treatment] = Number(r.amount);
  return out;
}

/** Month totals of the last `n` months ending at `to` (for the dashboard chart). */
async function monthly(from, to, conn) {
  const [rev] = await db(conn).query("SELECT DATE_FORMAT(day, '%Y-%m') AS m, SUM(net_revenue) AS v FROM rev_daily WHERE day >= ? AND day <= ? GROUP BY m", [from, to]);
  const [exp] = await db(conn).query("SELECT DATE_FORMAT(day, '%Y-%m') AS m, SUM(amount) AS v FROM exp_daily WHERE day >= ? AND day <= ? GROUP BY m", [from, to]);
  const map = new Map();
  for (const r of rev) map.set(r.m, { month: r.m, revenue: Number(r.v), expenses: 0 });
  for (const r of exp) map.set(r.m, { ...(map.get(r.m) || { month: r.m, revenue: 0 }), expenses: Number(r.v) });
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// ------------------------------------------------------------------ periods
async function periods({ from, to } = {}, conn) {
  const [rows] = await db(conn).query(
    `SELECT p.id, p.kind, p.period_from, p.period_to, p.status, p.filed_ref, p.locked_at, u.full_name AS locked_by_name
       FROM tax_periods p LEFT JOIN users u ON u.id = p.locked_by
      ${from ? 'WHERE p.period_to >= ? AND p.period_from <= ?' : ''} ORDER BY p.period_from DESC, p.kind LIMIT 50`,
    from ? [from, to] : []
  );
  return rows;
}

async function getPeriod(kind, from, conn) {
  const [rows] = await db(conn).query('SELECT * FROM tax_periods WHERE kind = ? AND period_from = ? LIMIT 1', [kind, from]);
  return rows[0] || null;
}

async function lockedCovering(day, conn) {
  const [rows] = await db(conn).query("SELECT id, kind, period_from, period_to FROM tax_periods WHERE status IN ('locked','filed') AND period_from <= ? AND period_to >= ? LIMIT 1", [day, day]);
  return rows[0] || null;
}

async function lockPeriod({ kind, from, to, totals, userId }, conn) {
  await db(conn).query(
    `INSERT INTO tax_periods (kind, period_from, period_to, status, totals_json, locked_by) VALUES (?, ?, ?, 'locked', ?, ?)
     ON DUPLICATE KEY UPDATE status = 'locked', totals_json = VALUES(totals_json), locked_by = VALUES(locked_by), locked_at = NOW()`,
    [kind, from, to, JSON.stringify(totals), userId || null]
  );
}

async function setFiled(kind, from, ref, conn) {
  await db(conn).query("UPDATE tax_periods SET status = 'filed', filed_ref = ? WHERE kind = ? AND period_from = ? AND status IN ('locked','filed')", [ref || null, kind, from]);
}

async function unlockPeriod(kind, from, conn) {
  const [res] = await db(conn).query("DELETE FROM tax_periods WHERE kind = ? AND period_from = ? AND status = 'locked'", [kind, from]);
  return res.affectedRows;
}

// ------------------------------------------------------------------ export queue
async function insertExport({ kind, from, to, userId }, conn) {
  const [res] = await db(conn).query('INSERT INTO tax_exports (kind, period_from, period_to, requested_by) VALUES (?, ?, ?, ?)', [kind, from, to, userId || null]);
  return res.insertId;
}

async function getExport(id, conn) {
  const [rows] = await db(conn).query('SELECT e.*, u.full_name AS user_name FROM tax_exports e LEFT JOIN users u ON u.id = e.requested_by WHERE e.id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function listExports(limit = 20, conn) {
  const [rows] = await db(conn).query(
    `SELECT e.id, e.kind, e.period_from, e.period_to, e.status, e.file_name, e.file_bytes, e.error, e.created_at, e.finished_at, e.expires_at, u.full_name AS user_name
       FROM tax_exports e LEFT JOIN users u ON u.id = e.requested_by ORDER BY e.id DESC LIMIT ?`, [Math.min(Number(limit) || 20, 100)]);
  return rows;
}

/** An unfinished job for the same book and period (a second click returns it instead of queuing another). */
async function findOpenExport(kind, from, to, conn) {
  const [rows] = await db(conn).query("SELECT id FROM tax_exports WHERE kind = ? AND period_from = ? AND period_to = ? AND status IN ('queued','running') LIMIT 1", [kind, from, to]);
  return rows[0] || null;
}

/** Takes the oldest queued job (single worker: the UPDATE guards against two workers taking the same one). */
async function claimNextExport(conn) {
  const [rows] = await db(conn).query("SELECT id FROM tax_exports WHERE status = 'queued' ORDER BY id LIMIT 1");
  if (!rows.length) return null;
  const [res] = await db(conn).query("UPDATE tax_exports SET status = 'running', started_at = NOW(), attempts = attempts + 1 WHERE id = ? AND status = 'queued'", [rows[0].id]);
  return res.affectedRows ? getExport(rows[0].id, conn) : null;
}

async function finishExport(id, { fileName, fileBytes }, conn) {
  await db(conn).query("UPDATE tax_exports SET status = 'done', file_name = ?, file_bytes = ?, finished_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY), error = NULL WHERE id = ?", [fileName, fileBytes, id]);
}

async function failExport(id, message, conn) {
  await db(conn).query("UPDATE tax_exports SET status = 'failed', error = ?, finished_at = NOW() WHERE id = ?", [String(message).slice(0, 255), id]);
}

/** Jobs left "running" by a process that died. */
async function requeueStale(minutes, conn) {
  const [res] = await db(conn).query("UPDATE tax_exports SET status = 'queued' WHERE status = 'running' AND started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE) AND attempts < 3", [minutes]);
  await db(conn).query("UPDATE tax_exports SET status = 'failed', error = 'Quá số lần thử' WHERE status = 'running' AND started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE) AND attempts >= 3", [minutes]);
  return res.affectedRows;
}

async function expiredExports(conn) {
  const [rows] = await db(conn).query("SELECT id, file_name FROM tax_exports WHERE status = 'done' AND file_name IS NOT NULL AND expires_at < NOW()");
  return rows;
}

async function clearExportFile(id, conn) {
  await db(conn).query("UPDATE tax_exports SET file_name = NULL, file_bytes = NULL, status = 'failed', error = 'Đã hết hạn lưu (7 ngày)' WHERE id = ?", [id]);
}

module.exports = {
  categories, rates, ratesOn, addRate, orderLines, setLineTax, bumpRevenue, bumpExpense, rebuildRevenue, rebuildExpenses, sourceTotals, unsnapshotted,
  revenueRows, revenueByCategory, revenueTotal, expenseByTreatment, monthly,
  periods, getPeriod, lockedCovering, lockPeriod, setFiled, unlockPeriod,
  insertExport, getExport, listExports, findOpenExport, claimNextExport, finishExport, failExport, requeueStale, expiredExports, clearExportFile,
};
