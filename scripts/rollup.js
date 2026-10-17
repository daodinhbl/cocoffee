/**
 * Rebuilds the daily rollups (rev_daily = revenue per tax group, exp_daily = expenses per category) from the source
 * rows and compares them with the sources. Also gives every completed order line that has no tax snapshot yet (orders
 * from before the tax feature) its tax group and the rates of its day.
 *
 *   node scripts/rollup.js                 the last 3 days (what the hPanel cron job at 02:30 should run)
 *   node scripts/rollup.js --days 30       the last 30 days
 *   node scripts/rollup.js --all           from the first order / expense ever (first run after the upgrade)
 *   node scripts/rollup.js --from 2026-01-01 --to 2026-03-31
 *
 * hPanel > Advanced > Cron Jobs:  30 2 * * *   cd /path/to/app && node scripts/rollup.js
 * Exit code 1 when the rollups still differ from the sources after the rebuild, so a monitor can notice.
 */
const { pool } = require('../src/config/db');
const { ensureSchemaUpgrades } = require('../src/config/bootstrapDb');
const rollupService = require('../src/services/rollupService');
const { shopDay, addDays, parseDay } = require('../src/utils/shopTime');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

(async () => {
  await ensureSchemaUpgrades();
  const today = shopDay();
  let from;
  let to = parseDay(opt('to') || '') || today;
  if (args.includes('--all')) {
    const [[r]] = await pool.query("SELECT LEAST(COALESCE((SELECT MIN(DATE(completed_at)) FROM orders WHERE status = 'completed'), '9999-12-31'), COALESCE((SELECT MIN(expense_date) FROM expenses), '9999-12-31')) AS first");
    from = r.first && String(r.first) < '9999' ? String(r.first).slice(0, 10) : today;
  } else if (opt('from')) {
    from = parseDay(opt('from'));
  } else {
    from = addDays(to, -(Math.max(1, Number(opt('days')) || 3) - 1));
  }
  if (!from) throw new Error('--from must be YYYY-MM-DD');
  const r = await rollupService.rebuild({ from, to });
  if (!r) { console.log('Another rollup is running (lock held). Nothing done.'); return; }
  const vnd = (n) => Math.round(n).toLocaleString('vi-VN');
  console.log(`Rollup ${from} → ${to}: ${r.days} day(s), ${r.snapshots} order(s) given a tax snapshot.`);
  console.log(`  revenue  rollup ${vnd(r.revenue.rollup)} / source ${vnd(r.revenue.source)}`);
  console.log(`  expenses rollup ${vnd(r.expenses.rollup)} / source ${vnd(r.expenses.source)}`);
  console.log(r.ok ? 'OK: the rollups match the sources.' : 'MISMATCH: investigate (an order without a tax group, or a change made while this ran).');
  if (!r.ok) process.exitCode = 1;
})()
  .catch((err) => { console.error('rollup failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
