const test = require('node:test');
const assert = require('node:assert/strict');
const cloudSync = require('../src/services/cloudSync');

/** A tiny in-memory stand-in for a mysql2 pool: just the statements cloudSync issues. */
function fakeDb(schema, data = {}) {
  const tables = new Map(Object.entries(data).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  for (const t of Object.keys(schema)) if (!tables.has(t)) tables.set(t, []);
  const log = [];
  const pkOf = (t) => schema[t].pk;
  async function query(sql, params = []) {
    sql = String(sql).replace(/\s+/g, ' ').trim();
    log.push(sql);
    if (/FROM information_schema\.tables/.test(sql)) return [Object.keys(schema).map((name) => ({ name })), []];
    if (/FROM information_schema\.columns/.test(sql)) {
      const rows = [];
      for (const [t, s] of Object.entries(schema)) for (const c of s.cols) rows.push({ t, c, k: s.pk.includes(c) ? 'PRI' : '', x: (s.generated || []).includes(c) ? 'VIRTUAL GENERATED' : '' });
      return [rows, []];
    }
    if (/FROM information_schema\.key_column_usage/.test(sql)) return [Object.entries(schema).flatMap(([t, s]) => (s.parents || []).map((p) => ({ t, p }))), []];
    if (/^SET /.test(sql)) return [{}, []];
    let m = /^SELECT setting_value AS v FROM app_settings WHERE setting_key = \?$/.exec(sql);
    if (m) { const r = (tables.get('app_settings') || []).find((x) => x.setting_key === params[0]); return [r ? [{ v: r.setting_value }] : [], []]; }
    if (/^INSERT INTO app_settings/.test(sql)) {
      const rows = tables.get('app_settings');
      const i = rows.findIndex((x) => x.setting_key === params[0]);
      if (i >= 0) rows[i].setting_value = params[1]; else rows.push({ setting_key: params[0], setting_value: params[1] });
      return [{}, []];
    }
    m = /^SELECT COUNT\(\*\) AS c FROM `(\w+)` ?(WHERE `(\w+)` (>=|>) \?)?$/.exec(sql);
    if (m) {
      let rows = tables.get(m[1]);
      if (m[3]) rows = rows.filter((r) => (m[4] === '>' ? r[m[3]] > params[0] : r[m[3]] >= params[0]));
      return [[{ c: rows.length }], []];
    }
    m = /^SELECT (.+) FROM `(\w+)` (WHERE `(\w+)` (>=|>) \?)? ?ORDER BY (.+) LIMIT (\d+) OFFSET (\d+)$/.exec(sql);
    if (m) {
      let rows = [...tables.get(m[2])];
      if (m[4]) rows = rows.filter((r) => (m[5] === '>' ? r[m[4]] > params[0] : r[m[4]] >= params[0]));
      const orderCols = m[6].split(',').map((s) => s.trim().replace(/`/g, ''));
      rows.sort((a, b) => { for (const c of orderCols) { if (a[c] < b[c]) return -1; if (a[c] > b[c]) return 1; } return 0; });
      return [rows.slice(Number(m[8]), Number(m[8]) + Number(m[7])).map((r) => ({ ...r })), []];
    }
    m = /^INSERT INTO `(\w+)` \((.+?)\) VALUES \? ON DUPLICATE KEY UPDATE/.exec(sql);
    if (m) {
      const cols = m[2].split(',').map((s) => s.trim().replace(/`/g, ''));
      const rows = tables.get(m[1]);
      for (const vals of params[0]) {
        const rec = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
        const idx = rows.findIndex((r) => pkOf(m[1]).every((k) => r[k] === rec[k]));
        if (idx >= 0) rows[idx] = { ...rows[idx], ...rec }; else rows.push(rec);
      }
      return [{ affectedRows: params[0].length }, []];
    }
    throw new Error(`fake db: unhandled SQL: ${sql}`);
  }
  const conn = { query, release() {} };
  return { query, getConnection: async () => conn, tables, log };
}

const D = (s) => new Date(`2026-10-${s}T00:00:00Z`);
const SCHEMA = {
  categories: { cols: ['id', 'name', 'updated_at'], pk: ['id'] },
  products: { cols: ['id', 'category_id', 'name', 'updated_at'], pk: ['id'], parents: ['categories'] },
  orders: { cols: ['id', 'code', 'total', 'created_at'], pk: ['id'] },
  order_items: { cols: ['id', 'order_id', 'qty'], pk: ['id'], parents: ['orders'] },
  recipes: { cols: ['product_id', 'item_id', 'qty'], pk: ['product_id', 'item_id'], parents: ['products'] },
  app_settings: { cols: ['setting_key', 'setting_value', 'updated_by'], pk: ['setting_key'] },
  idempotency_keys: { cols: ['id', 'k'], pk: ['id'] },
};

test('copy order puts parents first and skips the noise tables', () => {
  const tables = new Map(Object.entries(SCHEMA).map(([n, s]) => [n, { name: n, columns: s.cols, pk: s.pk, parents: new Set(s.parents || []) }]));
  const order = cloudSync.copyOrder(tables);
  assert.ok(order.indexOf('categories') < order.indexOf('products'));
  assert.ok(order.indexOf('orders') < order.indexOf('order_items'));
  assert.ok(order.indexOf('products') < order.indexOf('recipes'));
  assert.ok(!order.includes('idempotency_keys'));
  assert.equal(new Set(order).size, order.length);
});

test('change column: updated_at, else the id, else the whole table', () => {
  assert.deepEqual(cloudSync.changeColumn({ columns: ['id', 'updated_at'], pk: ['id'] }), { col: 'updated_at', kind: 'time' });
  assert.deepEqual(cloudSync.changeColumn({ columns: ['id', 'qty'], pk: ['id'] }), { col: 'id', kind: 'id' });
  assert.deepEqual(cloudSync.changeColumn({ columns: ['a', 'b'], pk: ['a', 'b'] }), { col: null, kind: 'whole' });
});

test('a missing column on the receiving side is refused before anything is written', async () => {
  const local = fakeDb(SCHEMA, { categories: [{ id: 1, name: 'Cà phê', updated_at: D('01') }] });
  const cloud = fakeDb({ ...SCHEMA, categories: { cols: ['id', 'name'], pk: ['id'] } });
  await assert.rejects(cloudSync.sync({ from: local, to: cloud, local, dir: 'push' }), /bên nhận thiếu cột updated_at/);
  assert.equal(cloud.tables.get('categories').length, 0);
  const missingTable = { ...SCHEMA };
  delete missingTable.orders;
  await assert.rejects(cloudSync.sync({ from: local, to: fakeDb(missingTable), local, dir: 'push' }), /chưa có bảng orders/);
});

test('push is incremental: the first run copies everything, the next only what changed, a re-run copies nothing new', async () => {
  const local = fakeDb(SCHEMA, {
    categories: [{ id: 1, name: 'Cà phê', updated_at: D('01') }],
    products: [{ id: 1, category_id: 1, name: 'Cà phê sữa', updated_at: D('02') }, { id: 2, category_id: 1, name: 'Bạc xỉu', updated_at: D('03') }],
    orders: [{ id: 1, code: 'A1', total: 10, created_at: D('04') }, { id: 2, code: 'A2', total: 20, created_at: D('05') }],
    order_items: [{ id: 1, order_id: 1, qty: 2 }, { id: 2, order_id: 2, qty: 1 }],
    recipes: [{ product_id: 1, item_id: 9, qty: 18 }],
    idempotency_keys: [{ id: 1, k: 'x' }],
  });
  const cloud = fakeDb(SCHEMA);
  const r1 = await cloudSync.sync({ from: local, to: cloud, local, dir: 'push' });
  assert.equal(cloud.tables.get('products').length, 2);
  assert.equal(cloud.tables.get('order_items').length, 2);
  assert.equal(cloud.tables.get('recipes').length, 1);
  assert.equal(cloud.tables.get('idempotency_keys').length, 0, 'noise tables are not copied');
  assert.ok(r1.rows >= 8);
  assert.ok(local.tables.get('app_settings').some((x) => x.setting_key === 'cloudsync.push.products'), 'progress marks live in the local database');

  // a new order, an edited product, a new item
  local.tables.get('orders').push({ id: 3, code: 'A3', total: 30, created_at: D('06') });
  local.tables.get('order_items').push({ id: 3, order_id: 3, qty: 3 });
  Object.assign(local.tables.get('products').find((p) => p.id === 1), { name: 'Cà phê sữa đá', updated_at: D('07') });
  const r2 = await cloudSync.sync({ from: local, to: cloud, local, dir: 'push' });
  const copied = Object.fromEntries(r2.tables.filter((t) => t.rows).map((t) => [t.table, t.rows]));
  assert.equal(copied.orders, 1, 'only the order newer than the mark');
  assert.equal(copied.order_items, 1);
  assert.ok(copied.products >= 1 && copied.products <= 2, 'the edited product (and maybe the one sharing the mark second)');
  assert.equal(cloud.tables.get('products').find((p) => p.id === 1).name, 'Cà phê sữa đá');
  assert.equal(cloud.tables.get('orders').length, 3);

  const r3 = await cloudSync.sync({ from: local, to: cloud, local, dir: 'push' });
  assert.equal(cloud.tables.get('orders').length, 3, 'idempotent');
  assert.equal(r3.tables.find((t) => t.table === 'orders').rows, 0);
});

test('dry run counts without writing; --full ignores the marks', async () => {
  const local = fakeDb(SCHEMA, { orders: [{ id: 1, code: 'A1', total: 10, created_at: D('04') }, { id: 2, code: 'A2', total: 20, created_at: D('05') }] });
  const cloud = fakeDb(SCHEMA);
  const dry = await cloudSync.sync({ from: local, to: cloud, local, dir: 'push', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.tables.find((t) => t.table === 'orders').rows, 2);
  assert.equal(cloud.tables.get('orders').length, 0);
  await cloudSync.sync({ from: local, to: cloud, local, dir: 'push' });
  const again = await cloudSync.sync({ from: local, to: cloud, local, dir: 'push', full: true });
  assert.equal(again.tables.find((t) => t.table === 'orders').rows, 2, 'full copies again');
});

test('pull seeds an empty local box from the cloud, with its own marks', async () => {
  const cloud = fakeDb(SCHEMA, { categories: [{ id: 1, name: 'Cà phê', updated_at: D('01') }], products: [{ id: 1, category_id: 1, name: 'Cà phê sữa', updated_at: D('02') }] });
  const local = fakeDb(SCHEMA);
  await cloudSync.sync({ from: cloud, to: local, local, dir: 'pull' });
  assert.equal(local.tables.get('products').length, 1);
  assert.ok(local.tables.get('app_settings').some((x) => x.setting_key === 'cloudsync.pull.products'));
  assert.ok(!local.tables.get('app_settings').some((x) => x.setting_key === 'cloudsync.push.products'), 'the two directions never share a mark');
});

test('generated columns are never written', async () => {
  const schema = { ...SCHEMA, orders: { cols: ['id', 'code', 'total', 'created_at', 'total_x2'], pk: ['id'], generated: ['total_x2'] } };
  const local = fakeDb(schema, { orders: [{ id: 1, code: 'A1', total: 10, created_at: D('04'), total_x2: 20 }] });
  const cloud = fakeDb(schema);
  await cloudSync.sync({ from: local, to: cloud, local, dir: 'push' });
  assert.ok(cloud.log.some((s) => /INSERT INTO `orders`/.test(s) && !s.includes('total_x2')));
});
