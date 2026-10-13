/**
 * Demo data: customers + random unpaid ("công nợ") Zalo orders with their invoice lines.
 *
 *   node scripts/seed-customers.js                 # 12 customers, 1-4 unpaid orders each
 *   node scripts/seed-customers.js --customers 20  # how many customers
 *   node scripts/seed-customers.js --reset         # remove earlier seed data first, then seed again
 *   node scripts/seed-customers.js --reset --only  # only remove the seed data
 *
 * What it writes (one transaction):
 *   - customers: Vietnamese names, unique phone, a synthetic zalo_user_id ("seed-..."), note "Khách mẫu (seed)";
 *   - per customer 1-4 orders (linked by customer_id, each with a 'debt' row in customer_ledger): source zalo, status completed, payment unpaid, dated in the last 20 days,
 *     1-4 lines of real active products at their current price, COGS estimated from the BOM / stock cost.
 * Stock is NOT deducted (these are invoices for display/testing, not real sales) and every seeded row is
 * tagged in `note`, so --reset removes exactly what this script created. Refuses NODE_ENV=production
 * without --yes, because the orders count as revenue in the reports.
 */
const { pool } = require('../src/config/db');
const env = require('../src/config/env');
const { ensureSchemaUpgrades } = require('../src/config/bootstrapDb');

const CUSTOMER_TAG = 'Khách mẫu (seed)';
const ORDER_TAG = 'Đơn mẫu (seed công nợ)';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback; };

const LAST = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý'];
const MIDDLE = ['Văn', 'Thị', 'Minh', 'Ngọc', 'Thanh', 'Quốc', 'Hoàng', 'Thu', 'Đức', 'Gia', 'Bảo', 'Khánh'];
const FIRST = ['An', 'Bình', 'Châu', 'Dũng', 'Giang', 'Hà', 'Hải', 'Hạnh', 'Hiếu', 'Hùng', 'Huy', 'Khoa', 'Lan', 'Linh', 'Long', 'Mai', 'Nam', 'Nga', 'Phúc', 'Quân', 'Sơn', 'Tâm', 'Thảo', 'Trang', 'Tuấn', 'Vy', 'Yến'];
const NOTES = ['khách quen', 'văn phòng tầng 3', 'ghi sổ cuối tuần', 'nhóm Zalo công ty', 'thanh toán chuyển khoản'];

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const between = (lo, hi) => lo + rnd(hi - lo + 1);

async function removeSeed(conn) {
  const [o] = await conn.query('DELETE FROM orders WHERE note = ? AND source = \'zalo\'', [ORDER_TAG]);   // order_items cascade
  const [c] = await conn.query('DELETE FROM customers WHERE note LIKE ?', [`${CUSTOMER_TAG}%`]);
  return { orders: o.affectedRows, customers: c.affectedRows };
}

/** Current price + estimated unit COGS for every active product. */
async function productCosts(conn) {
  const [rows] = await conn.query(
    `SELECT p.id, p.name, p.price,
            CASE WHEN p.stock_mode = 'direct' THEN COALESCE(i.avg_cost, 0)
                 ELSE COALESCE((SELECT SUM(r.quantity * ri.avg_cost) FROM recipes r JOIN inventory_items ri ON ri.id = r.inventory_item_id WHERE r.product_id = p.id), 0)
            END AS unit_cogs
       FROM products p LEFT JOIN inventory_items i ON i.id = p.inventory_item_id
      WHERE p.is_active = 1`
  );
  return rows.map((r) => ({ id: r.id, name: r.name, price: Number(r.price), unitCogs: Number(r.unit_cogs) }));
}

function makeCustomers(n, usedPhones) {
  const out = [];
  while (out.length < n) {
    const name = `${pick(LAST)} ${pick(MIDDLE)} ${pick(FIRST)}`;
    const phone = `09${String(between(0, 99999999)).padStart(8, '0')}`;
    if (usedPhones.has(phone)) continue;
    usedPhones.add(phone);
    out.push({ name, phone, zalo: `seed-${Date.now().toString(36)}-${out.length}-${rnd(1e6)}`, note: `${CUSTOMER_TAG} · ${pick(NOTES)}` });
  }
  return out;
}

async function main() {
  if (env.nodeEnv === 'production' && !flag('yes')) {
    console.error('NODE_ENV=production: these orders would show up as revenue. Re-run with --yes if you really want demo debts here.');
    process.exit(1);
  }
  await ensureSchemaUpgrades();                       // customers table on older databases
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (flag('reset')) {
      const removed = await removeSeed(conn);
      console.log(`Removed earlier seed: ${removed.customers} customers, ${removed.orders} orders.`);
      if (flag('only')) { await conn.commit(); return; }
    }

    const products = await productCosts(conn);
    if (!products.length) throw new Error('No active products: run the menu seed first.');
    const [phones] = await conn.query('SELECT phone FROM customers WHERE phone IS NOT NULL');
    const customers = makeCustomers(Math.max(1, Math.min(200, opt('customers', 12))), new Set(phones.map((p) => p.phone)));

    let orderCount = 0;
    let debtTotal = 0;
    for (const c of customers) {
      const [cust] = await conn.query('INSERT INTO customers (name, phone, zalo_user_id, note) VALUES (?, ?, ?, ?)', [c.name, c.phone, c.zalo, c.note]);
      const nOrders = between(1, 4);
      let owed = 0;
      for (let k = 0; k < nOrders; k++) {
        // 1-4 distinct products, 1-3 of each
        const lines = [...new Map(Array.from({ length: between(1, 4) }, () => { const p = pick(products); return [p.id, p]; })).values()]
          .map((p) => ({ ...p, qty: between(1, 3) }));
        const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
        const cogs = lines.reduce((s, l) => s + Math.round(l.unitCogs * l.qty), 0);
        const at = new Date(Date.now() - between(1, 20 * 24 * 60) * 60 * 1000);   // last 20 days
        const [res] = await conn.query(
          `INSERT INTO orders (source, zalo_user_id, zalo_chat_type, zalo_chat_id, customer_id, status, payment_status, subtotal, discount, total, cogs_total, note, completed_at, created_at)
           VALUES ('zalo', ?, 'user', ?, ?, 'completed', 'unpaid', ?, 0, ?, ?, ?, ?, ?)`,
          [c.zalo, c.zalo, cust.insertId, subtotal, subtotal, cogs, ORDER_TAG, at, at]
        );
        await conn.query(`UPDATE orders SET order_code = CONCAT('CF', DATE_FORMAT(created_at, '%y%m%d'), '-', LPAD(id, 5, '0')) WHERE id = ?`, [res.insertId]);
        await conn.query(
          'INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total, unit_cogs, line_cogs) VALUES ?',
          [lines.map((l) => [res.insertId, l.id, l.name, l.price, l.qty, l.price * l.qty, l.unitCogs, Math.round(l.unitCogs * l.qty)])]
        );
        await conn.query(
          `INSERT INTO customer_ledger (customer_id, order_id, entry_type, amount, note, created_at)
           SELECT ?, id, 'debt', total, CONCAT('Nợ đơn ', order_code), completed_at FROM orders WHERE id = ?`,
          [cust.insertId, res.insertId]
        );
        owed += subtotal; orderCount += 1;
      }
      debtTotal += owed;
      console.log(`  ${c.name.padEnd(24)} ${c.phone}  ${nOrders} đơn  ${owed.toLocaleString('vi-VN')}đ`);
    }
    await conn.commit();
    console.log(`Seeded ${customers.length} customers, ${orderCount} unpaid orders, total debt ${debtTotal.toLocaleString('vi-VN')}đ.`);
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

main()
  .catch((err) => { console.error('Seed failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
