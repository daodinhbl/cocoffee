const logger = require('../utils/logger');

/**
 * Two-way copy between the shop's LOCAL database (the Windows installer's MariaDB, the one the POS really writes to) and the
 * CLOUD database on Hostinger, so the local box keeps working offline and the cloud copy follows when the connection is back.
 *
 *  - push : local -> cloud. Every table is upserted by primary key, only rows changed since the last run (watermark per table:
 *           `updated_at` when the table has it, else the autoincrement `id`; tables with neither are copied whole, they are small).
 *           Idempotent: running it twice, or after a crash half-way, repeats the same upserts.
 *  - pull : cloud -> local. Same engine in the other direction, meant for the FIRST run of a new install (seed the local box with the
 *           shop's existing data) or to take over what was entered on the cloud site while the shop was offline.
 *
 * LOCAL IS THE PRIMARY. Rows are matched by primary key, so a row edited on both sides is simply overwritten by whichever side is
 * copied last, and an id created on the cloud site while the local box also created the same id collides. Keep one side writing at a
 * time (the local box in the shop); use the cloud site to look. Deletions are not copied (the app soft-deletes everywhere it matters).
 * The cloud side's structure must match: a missing table or column stops the run before anything is written.
 */
const SKIP = new Set(['idempotency_keys', 'zalo_events', 'zalo_sessions', 'zalo_tokens', 'tax_exports']);
const BATCH = 500;
const WM_PREFIX = 'cloudsync.';

const q = (id) => `\`${String(id).replace(/`/g, '``')}\``;

/** Reads tables, columns, primary keys and foreign-key parents of the database `pool` points at. */
async function inspect(pool) {
  const [tables] = await pool.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
  const [cols] = await pool.query(
    'SELECT table_name AS t, column_name AS c, column_key AS k, extra AS x FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position'
  );
  const [fks] = await pool.query(
    'SELECT table_name AS t, referenced_table_name AS p FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL'
  );
  const out = new Map();
  for (const r of tables) out.set(String(r.name || r.NAME || r.TABLE_NAME).toLowerCase(), { name: String(r.name || r.NAME || r.TABLE_NAME), columns: [], pk: [], parents: new Set() });
  for (const r of cols) {
    const t = out.get(String(r.t || r.T).toLowerCase());
    if (!t) continue;
    const extra = String(r.x || r.X || '').toUpperCase();
    if (extra.includes('GENERATED')) continue;                // computed by the database, cannot be written
    const c = String(r.c || r.C);
    t.columns.push(c);
    if ((r.k || r.K) === 'PRI') t.pk.push(c);
  }
  for (const r of fks) {
    const t = out.get(String(r.t || r.T).toLowerCase());
    const p = String(r.p || r.P).toLowerCase();
    if (t && p !== String(r.t || r.T).toLowerCase()) t.parents.add(p);
  }
  return out;
}

/** Tables to copy, parents before children (foreign keys), alphabetical otherwise. Cycles are broken at the end. */
function copyOrder(tables) {
  const names = [...tables.keys()].filter((n) => !SKIP.has(n)).sort();
  const placed = new Set();
  const order = [];
  let left = names;
  while (left.length) {
    const ready = left.filter((n) => [...tables.get(n).parents].every((p) => placed.has(p) || !tables.has(p) || SKIP.has(p) || p === n));
    const next = ready.length ? ready : [left[0]];             // a cycle: take the first and go on
    for (const n of next) { placed.add(n); order.push(n); }
    left = left.filter((n) => !placed.has(n));
  }
  return order;
}

/** Which column says "this row changed": updated_at, else the single autoincrement-style id, else none (copy whole). */
function changeColumn(t) {
  if (t.columns.includes('updated_at')) return { col: 'updated_at', kind: 'time' };
  if (t.pk.length === 1 && t.columns.includes(t.pk[0]) && /^id$/i.test(t.pk[0])) return { col: t.pk[0], kind: 'id' };
  return { col: null, kind: 'whole' };
}

/** Columns both sides have; throws when `to` lacks a column of `from` (structure mismatch: do not write anything). */
function sharedColumns(name, fromT, toT) {
  const missing = fromT.columns.filter((c) => !toT.columns.includes(c));
  if (missing.length) throw new Error(`Cấu trúc bảng ${name} khác nhau: bên nhận thiếu cột ${missing.join(', ')}. Cập nhật phiên bản ứng dụng/CSDL hai bên cho khớp rồi đồng bộ lại.`);
  return fromT.columns;
}

function upsertSql(table, columns) {
  const list = columns.map(q).join(', ');
  const update = columns.map((c) => `${q(c)} = VALUES(${q(c)})`).join(', ');
  return `INSERT INTO ${q(table)} (${list}) VALUES ? ON DUPLICATE KEY UPDATE ${update}`;
}

async function readState(pool, table) {
  const [rows] = await pool.query('SELECT setting_value AS v FROM app_settings WHERE setting_key = ?', [`${WM_PREFIX}${table}`]);
  if (!rows.length) return null;
  try { return JSON.parse(rows[0].v); } catch (_) { return null; }
}

async function writeState(pool, table, state) {
  await pool.query(
    'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [`${WM_PREFIX}${table}`, JSON.stringify(state)]
  );
}

/**
 * Copies one table. `watermarkPool` is the database that keeps the progress marks (always the local one, whichever way we copy);
 * `dir` ('push' | 'pull') only namespaces them so the two directions never share a mark.
 * @returns {{ table, rows }}
 */
async function copyTable({ from, to, toConn, name, fromT, toT, watermarkPool, dir, full = false, batch = BATCH, onRows }) {
  const cols = sharedColumns(name, fromT, toT);
  const change = changeColumn(fromT);
  const key = `${dir}.${name}`;
  const state = full ? null : await readState(watermarkPool, key);
  const sql = upsertSql(name, cols);
  const orderBy = (fromT.pk.length ? fromT.pk : cols.slice(0, 1)).map(q);
  let total = 0;
  let last = state && state.last !== undefined ? state.last : null;
  if (last !== null && change.kind === 'time' && typeof last === 'string') last = new Date(last);   // marks are stored as ISO text; the driver formats a Date in the pool's time zone
  for (;;) {
    let where = '';
    const params = [];
    if (change.col && last !== null) { where = `WHERE ${q(change.col)} ${change.kind === 'id' ? '>' : '>='} ?`; params.push(last); }
    const order = change.col ? [q(change.col), ...orderBy.filter((o) => o !== q(change.col))].join(', ') : orderBy.join(', ');
    const offset = !change.col ? total : 0;
    const [rows] = await from.query(`SELECT ${cols.map(q).join(', ')} FROM ${q(name)} ${where} ORDER BY ${order} LIMIT ${batch} OFFSET ${offset}`, params);
    if (!rows.length) break;
    await toConn.query(sql, [rows.map((r) => cols.map((c) => r[c]))]);
    total += rows.length;
    if (onRows) onRows(name, total);
    if (change.col) {
      const tail = rows[rows.length - 1][change.col];
      // time columns use >= so rows sharing the last second are never skipped; a full batch of identical stamps would loop forever, so stop then
      const same = change.kind === 'time' && last !== null && String(tail) === String(last) && rows.length >= batch;
      last = tail;
      if (same) break;
    }
    if (rows.length < batch) break;
  }
  if (change.col && last !== null) await writeState(watermarkPool, key, { last: last instanceof Date ? last.toISOString() : last, at: new Date().toISOString() });
  else if (!change.col) await writeState(watermarkPool, key, { whole: true, rows: total, at: new Date().toISOString() });
  return { table: name, rows: total };
}

/**
 * @param {{ from, to, local, dir: 'push'|'pull', full?: boolean, only?: string[], dryRun?: boolean, onProgress?: Function }} o
 *   from / to: mysql2 pools (or anything with query / getConnection); local: the pool that holds the progress marks.
 * @returns {Promise<{ tables: {table, rows}[], rows: number, dryRun: boolean }>}
 */
async function sync({ from, to, local, dir, full = false, only = null, dryRun = false, onProgress = null }) {
  const [src, dst] = await Promise.all([inspect(from), inspect(to)]);
  const order = copyOrder(src).filter((n) => !only || only.includes(n));
  for (const n of order) {
    if (!dst.has(n)) throw new Error(`Bên nhận chưa có bảng ${n}: chạy ứng dụng phiên bản mới nhất ở bên đó (nó tự tạo bảng) rồi đồng bộ lại.`);
    sharedColumns(n, src.get(n), dst.get(n));            // fail before the first write
  }
  const results = [];
  if (dryRun) {
    for (const n of order) {
      const change = changeColumn(src.get(n));
      const state = full ? null : await readState(local, `${dir}.${n}`);
      let where = '';
      const params = [];
      if (change.col && state && state.last !== undefined) { where = `WHERE ${q(change.col)} ${change.kind === 'id' ? '>' : '>='} ?`; params.push(state.last); }
      const [[{ c }]] = await from.query(`SELECT COUNT(*) AS c FROM ${q(n)} ${where}`, params);
      results.push({ table: n, rows: Number(c) });
    }
    return { tables: results, rows: results.reduce((a, r) => a + r.rows, 0), dryRun: true };
  }
  const conn = await to.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    await conn.query("SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_ZERO_DATE', '')");
    for (const n of order) {
      const r = await copyTable({ from, to, toConn: conn, name: n, fromT: src.get(n), toT: dst.get(n), watermarkPool: local, dir, full, onRows: onProgress });
      results.push(r);
      if (r.rows) logger.info(`Cloud sync ${dir}: ${n} ${r.rows} row(s)`);
    }
  } finally {
    try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } catch (_) { /* connection gone */ }
    conn.release();
  }
  return { tables: results, rows: results.reduce((a, r) => a + r.rows, 0), dryRun: false };
}

module.exports = { sync, inspect, copyOrder, changeColumn, sharedColumns, upsertSql, SKIP, BATCH };
