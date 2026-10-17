const { pool, withTransaction } = require('../config/db');
const taxModel = require('../models/taxModel');
const taxService = require('./taxService');
const ownerNotice = require('./zalo/ownerNotice');
const { shopDay, addDays, offsetMinutes } = require('../utils/shopTime');
const logger = require('../utils/logger');

/**
 * Rollups (rev_daily / exp_daily) are grown at write time; this service REBUILDS them from the source rows, which is
 * how history gets in (orders from before the tax feature) and how drift is repaired. It runs from
 * scripts/rollup.js (hPanel cron job) and, as a fallback, from a once-a-night timer inside the app (02:30 shop time).
 * One day at a time, a short pause between days, and a MySQL named lock so two processes never rebuild together.
 */
const LOCK = 'cocoffee_rollup';
const PAUSE_MS = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Gives every completed line without a snapshot its tax group / rates (as of the order's day) and net revenue. */
async function backfillSnapshots({ batch = 200 } = {}) {
  let done = 0;
  for (;;) {
    const orders = await taxModel.unsnapshotted(batch);
    if (!orders.length) break;
    for (const o of orders) {
      await withTransaction(async (conn) => {
        const order = await conn.query('SELECT id, discount FROM orders WHERE id = ?', [o.id]).then(([r]) => r[0]);
        await taxService.snapshotOrder(conn, order, { day: o.day, rollup: false });
      });
      done += 1;
    }
    if (orders.length < batch) break;
    await sleep(PAUSE_MS);
  }
  return done;
}

/**
 * Rebuilds both rollups for [from, to] and compares them with the source tables.
 * @returns {Promise<{ days: number, snapshots: number, revenue: {rollup:number, source:number}, expenses: {rollup:number, source:number}, ok: boolean }|null>} null when another process holds the lock
 */
async function rebuild({ from, to, snapshots = true } = {}) {
  const [[l]] = await pool.query('SELECT GET_LOCK(?, 0) AS ok', [LOCK]);
  if (!Number(l.ok)) return null;
  try {
    const snaps = snapshots ? await backfillSnapshots() : 0;
    let days = 0;
    for (let day = from; day <= to; day = addDays(day, 1)) {
      await withTransaction(async (conn) => {
        await taxModel.rebuildRevenue(day, day, conn);
        await taxModel.rebuildExpenses(day, day, conn);
      });
      days += 1;
      if (days % 7 === 0) await sleep(PAUSE_MS);
    }
    const source = await taxModel.sourceTotals(from, to);
    const rollupRevenue = await taxModel.revenueTotal(from, to);
    const rollupExpenses = (await taxModel.expenseByTreatment(from, to));
    const expenses = rollupExpenses.deductible + rollupExpenses.non_deductible + rollupExpenses.capex;
    const ok = Math.abs(rollupRevenue - source.net) < 1 && Math.abs(expenses - source.expenses) < 1;
    return { days, snapshots: snaps, revenue: { rollup: rollupRevenue, source: source.net }, expenses: { rollup: expenses, source: source.expenses }, ok };
  } finally {
    await pool.query('SELECT RELEASE_LOCK(?)', [LOCK]).catch(() => {});
  }
}

/** The last `n` days including today. */
async function rebuildRecent(n = 3) {
  const to = shopDay();
  return rebuild({ from: addDays(to, -(n - 1)), to });
}

// ------------------------------------------------------------------ nightly timer (fallback to the cron job)
let timer = null;
let lastRunDay = '';

function shopMinutes(now = new Date()) {
  const d = new Date(now.getTime() + offsetMinutes() * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

async function tick() {
  const today = shopDay();
  const m = shopMinutes();
  if (lastRunDay === today || m < 150 || m > 240) return;            // 02:30 - 04:00 shop time, once a day
  lastRunDay = today;
  try {
    const r = await rebuildRecent(3);
    if (r && !r.ok) {
      logger.warn(`Rollup drift repaired: revenue ${r.revenue.rollup} vs ${r.revenue.source}, expenses ${r.expenses.rollup} vs ${r.expenses.source}`);
    } else if (r) {
      logger.info(`Nightly rollup ok (${r.days} days)`);
    }
  } catch (err) {
    logger.error('Nightly rollup failed', err);
    ownerNotice.notifyOwner('⚠️ Tổng hợp doanh thu / chi phí ban đêm bị lỗi. Kiểm tra nhật ký máy chủ.').catch(() => {});
  }
}

function startScheduler() {
  if (timer) return;
  timer = setInterval(() => { tick(); }, 10 * 60 * 1000);
  timer.unref();
}

module.exports = { rebuild, rebuildRecent, backfillSnapshots, startScheduler, tick };
