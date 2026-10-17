/**
 * Sample data for the expense book (Sổ chi phí): a believable café's fixed costs for the last three months, so the
 * expense screens, the tax estimate and the exports can be tried with something in them.
 *
 *   node scripts/seed-expenses.js [--dry-run]     add the rows (idempotent: a row is added once)
 *   node scripts/seed-expenses.js --remove        delete exactly the rows this script added
 *
 * Every row is marked: document number "MAU-…" and a note starting "[Mẫu]". It never touches other expenses, and the
 * rows are real rows of the book: REMOVE THEM before declaring anything. Dates in the future are skipped.
 */
const { pool } = require('../src/config/db');
const { ensureSchemaUpgrades } = require('../src/config/bootstrapDb');
const expenseModel = require('../src/models/expenseModel');
const taxModel = require('../src/models/taxModel');
const { shopDay, addDays } = require('../src/utils/shopTime');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const remove = args.includes('--remove');

// [category code, day of month, payee, description, amount(s) per month offset 0 = this month, -1, -2], only = months it applies to
const PLAN = [
  ['thue-mat-bang', 5, 'Chủ nhà', 'Tiền thuê mặt bằng', [8000000, 8000000, 8000000]],
  ['nhan-cong', 1, 'Nhân viên ca sáng', 'Lương nhân viên ca sáng', [6000000, 6000000, 5800000]],
  ['nhan-cong', 1, 'Nhân viên ca tối', 'Lương nhân viên ca tối', [6000000, 6000000, 5800000]],
  ['dien-nuoc', 8, 'Nhà mạng', 'Cước internet', [250000, 250000, 250000]],
  ['dien-nuoc', 12, 'Điện lực', 'Tiền điện', [1920000, 1760000, 1680000]],
  ['dien-nuoc', 12, 'Công ty cấp nước', 'Tiền nước', [215000, 198000, 204000]],
  ['marketing', 15, 'Cửa hàng in ấn', 'In tờ rơi, menu, tem dán', [600000, 0, 450000]],
  ['sua-chua', 20, 'Thợ điện lạnh', 'Bảo trì máy lạnh, sửa vòi nước', [0, 450000, 0]],
  ['thiet-bi', 9, 'Cửa hàng thiết bị pha chế', 'Máy xay cà phê', [0, 0, 3500000]],
  ['thue-phi', 25, 'Công ty môi trường', 'Phí thu gom rác, vệ sinh', [100000, 100000, 100000]],
];

const pad = (n) => String(n).padStart(2, '0');
const monthOf = (day, offset) => {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) + offset;
  return { y: y + Math.floor((m - 1) / 12), m: ((m - 1 + 120) % 12) + 1 };
};

async function removeAll() {
  const [res] = await pool.query("DELETE FROM expenses WHERE doc_no LIKE 'MAU-%' AND source = 'manual'");
  return res.affectedRows;
}

async function addAll(today) {
  const cats = new Map((await expenseModel.listCategories()).map((c) => [c.code, c.id]));
  const rows = [];
  PLAN.forEach(([code, dom, payee, text, amounts], planIdx) => {
    amounts.forEach((amount, i) => {
      if (!amount) return;
      const { y, m } = monthOf(today, -i);
      const day = `${y}-${pad(m)}-${pad(dom)}`;
      if (day > today) return;                                       // not yet happened
      rows.push({ day, code, payee, text, amount, doc: `MAU-${String(planIdx + 1).padStart(2, '0')}-${y}${pad(m)}` });
    });
  });
  let added = 0;
  for (const r of rows) {
    const [[exists]] = await pool.query('SELECT COUNT(*) AS n FROM expenses WHERE doc_no = ?', [r.doc]);
    if (Number(exists.n)) continue;
    if (!dryRun) {
      await expenseModel.insert({
        expenseDate: r.day, categoryId: cats.get(r.code), amount: r.amount, payee: r.payee, docNo: r.doc, note: `[Mẫu] ${r.text}`, source: 'manual',
      });
    }
    added += 1;
  }
  return { planned: rows.length, added, from: rows.reduce((a, r) => (a && a < r.day ? a : r.day), ''), to: today };
}

(async () => {
  await ensureSchemaUpgrades();
  const today = shopDay();
  const from = addDays(`${monthOf(today, -2).y}-${pad(monthOf(today, -2).m)}-01`, 0);
  if (remove) {
    const n = await removeAll();
    await taxModel.rebuildExpenses(from, today);
    console.log(`Removed ${n} sample expense(s).`);
    return;
  }
  const r = await addAll(today);
  if (!dryRun) await taxModel.rebuildExpenses(from, today);
  console.log(`${dryRun ? '[dry-run] ' : ''}Sample expenses: ${r.added} added (${r.planned} planned, ${r.planned - r.added} already there), ${r.from} → ${r.to}.`);
  console.log('Remove them any time with: node scripts/seed-expenses.js --remove');
})()
  .catch((err) => { console.error('seed-expenses failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
