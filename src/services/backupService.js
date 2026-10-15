const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { once } = require('events');
const env = require('../config/env');
const { pool } = require('../config/db');
const settingsModel = require('../models/settingsModel');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');

/**
 * Database backup / restore for Web Admin > Sao lưu & khôi phục.
 *
 * Format: a plain SQL script, gzip-compressed (cocoffee-<kind>-YYYYMMDD-HHMMSS.sql.gz), so it also imports in
 * phpMyAdmin. Hosting has no mysqldump, so the dump is written here: a consistent snapshot (one InnoDB
 * transaction), every table as DROP + CREATE + batched INSERTs, one statement per line (string literals never
 * contain a raw newline). That layout is what makes restoring safe: the file is parsed line by line and only
 * our own statement shapes against our own tables are accepted, so an uploaded file can never run anything else.
 *
 * DDL commits implicitly in MySQL, so a restore cannot be rolled back. Instead the file is validated in full
 * first, and a "pre-restore" snapshot of the live database is saved before the first statement runs.
 */
const HEADER = '-- CoCoffee backup v1';
const FOOTER = '-- end of backup';
const KINDS = { auto: 'Tự động', manual: 'Thủ công', 'pre-restore': 'Trước khi khôi phục', uploaded: 'Tải lên' };
const NAME_RE = /^cocoffee-(auto|manual|pre-restore|uploaded)-\d{8}-\d{6}(?:-[a-f0-9]{4})?\.sql\.gz$/;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;       // compressed
const MAX_SQL_BYTES = 512 * 1024 * 1024;          // after decompression
const BATCH_ROWS = 200;
const BATCH_BYTES = 256 * 1024;
const PREFIX = 'backup.';
const INTERVALS = [6, 12, 24, 48, 168];
const q = (id) => `\`${String(id).replace(/`/g, '``')}\``;

// ------------------------------------------------------------------------------------------------ settings

function defaults() { return { autoEnabled: true, intervalHours: 24, keep: 7 }; }

/** Never throws: a database problem falls back to the defaults. */
async function getSettings() {
  const d = defaults();
  let raw = {};
  try { raw = await settingsModel.getByPrefix(PREFIX); } catch (err) { logger.warn('Backup settings unavailable, using defaults', err); }
  const hours = parseInt(raw[`${PREFIX}intervalHours`], 10);
  const keep = parseInt(raw[`${PREFIX}keep`], 10);
  return {
    autoEnabled: raw[`${PREFIX}autoEnabled`] === undefined ? d.autoEnabled : raw[`${PREFIX}autoEnabled`] === '1',
    intervalHours: INTERVALS.includes(hours) ? hours : d.intervalHours,
    keep: Number.isInteger(keep) && keep >= 1 && keep <= 60 ? keep : d.keep,
  };
}

async function saveSettings(input, userId) {
  const hours = parseInt(input.intervalHours, 10);
  const keep = parseInt(input.keep, 10);
  if (!INTERVALS.includes(hours)) throw new AppError(400, 'VALIDATION', 'Chu kỳ sao lưu không hợp lệ.');
  if (!Number.isInteger(keep) || keep < 1 || keep > 60) throw new AppError(400, 'VALIDATION', 'Số bản giữ lại phải từ 1 đến 60.');
  const auto = Array.isArray(input.autoEnabled) ? input.autoEnabled[input.autoEnabled.length - 1] : input.autoEnabled;
  await settingsModel.setMany({
    [`${PREFIX}autoEnabled`]: ['1', 'on', 'true'].includes(String(auto)) ? '1' : '0',
    [`${PREFIX}intervalHours`]: hours,
    [`${PREFIX}keep`]: keep,
  }, userId);
}

// ------------------------------------------------------------------------------------------------ files

const tzMinutes = () => {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(env.db.timezone);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};
const stamp = () => new Date(Date.now() + tzMinutes() * 60000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const newName = (kind) => `cocoffee-${kind}-${stamp()}-${crypto.randomBytes(2).toString('hex')}.sql.gz`;

async function ensureDir() { await fsp.mkdir(env.backupDir, { recursive: true }); }

/** A stored file by name. Only names we generate are accepted, so a request can never leave the backup folder. */
function pathOf(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy bản sao lưu này.');
  return path.join(env.backupDir, name);
}

/** @returns {Promise<Array<{name:string, kind:string, size:number, createdAt:Date}>>} newest first */
async function list() {
  let names = [];
  try { names = await fsp.readdir(env.backupDir); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const out = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    try {
      const st = await fsp.stat(path.join(env.backupDir, name));
      out.push({ name, kind: m[1], size: st.size, createdAt: st.mtime });
    } catch (_) { /* vanished between readdir and stat */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
}

async function remove(name) {
  const file = pathOf(name);
  try { await fsp.unlink(file); } catch (err) { if (err.code === 'ENOENT') throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy bản sao lưu này.'); throw err; }
}

/** Keep the newest `keep` files of one kind. Manual and uploaded files are only ever deleted by hand. */
async function prune(kind, keep) {
  const old = (await list()).filter((f) => f.kind === kind).slice(keep);
  for (const f of old) await fsp.unlink(path.join(env.backupDir, f.name)).catch(() => {});
  return old.length;
}

// ------------------------------------------------------------------------------------------------ dump

async function tableNames(conn) {
  const [rows] = await conn.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name"
  );
  return rows.map((r) => r.name || r.NAME || r.TABLE_NAME);
}

// Exact text for the types JS would round or reformat (BIGINT, DECIMAL, dates).
const EXACT = new Set(['DATETIME', 'TIMESTAMP', 'DATE', 'TIME', 'NEWDECIMAL', 'DECIMAL', 'LONGLONG']);
const typeCast = (field, next) => (EXACT.has(field.type) ? field.string() : next());

function literal(conn, v) {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return v.length ? `X'${v.toString('hex')}'` : "''";
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return conn.escape(typeof v === 'string' ? v : String(v));
}

/** Write a gzip'd dump of the whole database to `file`. Returns { tables, rows }. */
async function dumpTo(file) {
  const tmp = `${file}.part`;
  const conn = await pool.getConnection();
  const gzip = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp);
  const finished = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gzip.on('error', reject); });
  gzip.pipe(out);
  const write = async (s) => { if (!gzip.write(`${s}\n`)) await once(gzip, 'drain'); };
  let rowCount = 0;
  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const tables = await tableNames(conn);
    await write(HEADER);
    await write(`-- created: ${new Date().toISOString()}`);
    await write(`-- tables: ${tables.length}`);
    await write('SET NAMES utf8mb4;');
    await write('SET FOREIGN_KEY_CHECKS=0;');
    for (const t of tables) {
      const [[create]] = await conn.query(`SHOW CREATE TABLE ${q(t)}`);
      await write(`-- table ${t}`);
      await write(`DROP TABLE IF EXISTS ${q(t)};`);
      await write(`${String(create['Create Table']).replace(/\s*\n\s*/g, ' ')};`);
      const [keys] = await conn.query(`SHOW KEYS FROM ${q(t)} WHERE Key_name = 'PRIMARY'`);
      const order = keys.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map((k) => q(k.Column_name)).join(', ');
      const [[{ size }]] = await conn.query(
        'SELECT COALESCE(MAX(avg_row_length), 0) AS size FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t]
      );
      const page = size > 8192 ? 10 : 500;                       // photo tables: small pages, the rows are big
      for (let offset = 0; ; offset += page) {
        const [rows] = await conn.query({ sql: `SELECT * FROM ${q(t)}${order ? ` ORDER BY ${order}` : ''} LIMIT ${page} OFFSET ${offset}`, typeCast });
        if (!rows.length) break;
        const cols = Object.keys(rows[0]);
        const head = `INSERT INTO ${q(t)} (${cols.map(q).join(', ')}) VALUES `;
        let batch = [];
        let bytes = 0;
        const flush = async () => { if (batch.length) await write(`${head}${batch.join(',')};`); batch = []; bytes = 0; };
        for (const r of rows) {
          const tuple = `(${cols.map((c) => literal(conn, r[c])).join(',')})`;
          batch.push(tuple);
          bytes += tuple.length;
          rowCount += 1;
          if (batch.length >= BATCH_ROWS || bytes >= BATCH_BYTES) await flush();
        }
        await flush();
        if (rows.length < page) break;
      }
    }
    await write('SET FOREIGN_KEY_CHECKS=1;');
    await write(FOOTER);
    gzip.end();
    await finished;
    await fsp.rename(tmp, file);
    return { tables: tables.length, rows: rowCount };
  } catch (err) {
    gzip.destroy();
    out.destroy();
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  } finally {
    try { await conn.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    conn.release();
  }
}

// ------------------------------------------------------------------------------------------------ parse

/**
 * Validate a backup (gzip or plain SQL) and return its statements. Throws AppError(400) with a Vietnamese
 * reason. `known` = tables that exist in the live database: the file may only touch those.
 */
function parse(buffer, known) {
  let raw = buffer;
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try { raw = zlib.gunzipSync(raw, { maxOutputLength: MAX_SQL_BYTES }); } catch (_) {
      throw new AppError(400, 'BACKUP_INVALID', 'File nén bị hỏng hoặc quá lớn, không đọc được.');
    }
  }
  const lines = raw.toString('utf8').replace(/^﻿/, '').split('\n').map((l) => l.replace(/\r$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines[0] !== HEADER) throw new AppError(400, 'BACKUP_INVALID', 'Đây không phải file sao lưu của CoCoffee (thiếu dòng nhận dạng đầu file).');
  if (lines[lines.length - 1] !== FOOTER) throw new AppError(400, 'BACKUP_INVALID', 'File sao lưu bị cắt dở (thiếu dòng kết thúc). Hãy tải lại file đầy đủ.');

  const statements = [];
  const tables = new Set();
  const seen = new Set();
  lines.forEach((line, i) => {
    if (line === '' || line.startsWith('-- ')) return;
    const bad = (why) => new AppError(400, 'BACKUP_INVALID', `Dòng ${i + 1} trong file không hợp lệ (${why}).`);
    let m;
    if (/^SET NAMES utf8mb4;$|^SET FOREIGN_KEY_CHECKS=[01];$/.test(line)) { statements.push(line); return; }
    if ((m = /^DROP TABLE IF EXISTS `([a-z0-9_]+)`;$/.exec(line))) {
      if (!known.has(m[1])) throw bad(`bảng "${m[1]}" không có trong hệ thống`);
      seen.add(m[1]);
    } else if ((m = /^CREATE TABLE `([a-z0-9_]+)` \(.*\) ENGINE=[^;]*;$/.exec(line))) {
      if (!seen.has(m[1])) throw bad(`bảng "${m[1]}" không được khai báo đúng thứ tự`);
      tables.add(m[1]);
    } else if ((m = /^INSERT INTO `([a-z0-9_]+)` \(`[^;]*\) VALUES \(.*\);$/.exec(line))) {
      if (!tables.has(m[1])) throw bad(`dữ liệu của bảng "${m[1]}" đứng trước phần tạo bảng`);
    } else {
      throw bad('câu lệnh lạ');
    }
    statements.push(line);
  });
  if (!tables.size) throw new AppError(400, 'BACKUP_INVALID', 'File sao lưu không chứa bảng dữ liệu nào.');
  return { statements, tables: [...tables] };
}

// ------------------------------------------------------------------------------------------------ operations

let busy = null;                                           // 'backup' | 'restore' while one is running
const isBusy = () => busy;
async function exclusive(what, fn) {
  if (busy) throw new AppError(409, 'BUSY', busy === 'restore' ? 'Đang khôi phục dữ liệu, vui lòng đợi.' : 'Đang có một bản sao lưu chạy, vui lòng đợi vài giây.');
  busy = what;
  try { return await fn(); } finally { busy = null; }
}

/** Create a backup file on the server. kind: manual | auto | pre-restore */
async function createStored(kind) {
  return exclusive('backup', async () => dumpAndStore(kind));
}
async function dumpAndStore(kind) {
  await ensureDir();
  const name = newName(kind);
  const file = path.join(env.backupDir, name);
  const info = await dumpTo(file);
  const { size } = await fsp.stat(file);
  logger.info(`Backup ${name}: ${info.tables} tables, ${info.rows} rows, ${size} bytes`);
  return { name, size, ...info };
}

/** A fresh dump in the OS temp folder for an immediate download. `cleanup()` removes it. */
async function createTemp() {
  return exclusive('backup', async () => {
    const name = newName('manual');
    const file = path.join(os.tmpdir(), name);
    await dumpTo(file);
    return { name, file, cleanup: () => fsp.unlink(file).catch(() => {}) };
  });
}

/** Store an uploaded backup after validating it completely. Returns the stored name. */
async function storeUpload(buffer) {
  if (!buffer || !buffer.length) throw new AppError(400, 'BACKUP_INVALID', 'Chưa chọn file hoặc file rỗng.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new AppError(413, 'TOO_LARGE', 'File quá lớn (tối đa 100 MB sau khi nén).');
  const conn = await pool.getConnection();
  let known;
  try { known = new Set(await tableNames(conn)); } finally { conn.release(); }
  parse(buffer, known);
  await ensureDir();
  const name = newName('uploaded');
  const gz = buffer[0] === 0x1f && buffer[1] === 0x8b ? buffer : zlib.gzipSync(buffer);
  await fsp.writeFile(path.join(env.backupDir, name), gz);
  return name;
}

/** Replace the database content with a stored backup. Saves a pre-restore snapshot first. */
async function restore(name) {
  const file = pathOf(name);
  return exclusive('restore', async () => {
    let buffer;
    try { buffer = await fsp.readFile(file); } catch (err) { if (err.code === 'ENOENT') throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy bản sao lưu này.'); throw err; }
    const meta = await pool.getConnection();
    let known;
    try { known = new Set(await tableNames(meta)); } finally { meta.release(); }
    const { statements, tables } = parse(buffer, known);            // nothing is touched if this throws

    const snapshot = await dumpAndStore('pre-restore');
    const keep = (await getSettings()).keep;
    prune('pre-restore', Math.max(keep, 3)).catch(() => {});

    const conn = await pool.getConnection();
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS=0');
      for (const stmt of statements) await conn.query(stmt);
    } catch (err) {
      logger.error(`Restore of ${name} failed half-way`, err);
      throw new AppError(500, 'RESTORE_FAILED',
        `Khôi phục bị dừng giữa chừng (${err.sqlMessage || err.message}). Dữ liệu có thể đang dở dang — hãy khôi phục lại bản "${snapshot.name}" (bản tự lưu ngay trước đó).`);
    } finally {
      try { await conn.query('SET FOREIGN_KEY_CHECKS=1'); } catch (_) { /* connection gone */ }
      conn.release();
    }
    try { require('../models/productModel').invalidateCatalog(); } catch (_) { /* cache only */ }
    await require('../config/bootstrapDb').ensureSchemaUpgrades();   // an older backup may lack newer columns / tables
    const untouched = [...known].filter((t) => !tables.includes(t));
    logger.info(`Restored ${name}: ${tables.length} tables (snapshot ${snapshot.name})`);
    return { tables: tables.length, snapshot: snapshot.name, untouched };
  });
}

// ------------------------------------------------------------------------------------------------ schedule

const lastAuto = { at: null, error: null };

async function runAutoIfDue() {
  if (busy) return;
  const cfg = await getSettings();
  if (!cfg.autoEnabled) return;
  const newest = (await list()).find((f) => f.kind === 'auto');
  if (newest && Date.now() - newest.createdAt.getTime() < cfg.intervalHours * 3600 * 1000) return;
  try {
    await createStored('auto');
    await prune('auto', cfg.keep);
    lastAuto.at = new Date();
    lastAuto.error = null;
  } catch (err) {
    lastAuto.error = err.message;
    logger.error('Automatic backup failed', err);
  }
}

/** Check shortly after boot, then every 30 minutes. Never throws, never keeps the process alive. */
function startScheduler() {
  const tick = () => runAutoIfDue().catch((err) => logger.error('Backup scheduler', err));
  setTimeout(tick, 90 * 1000).unref();
  setInterval(tick, 30 * 60 * 1000).unref();
}

module.exports = {
  KINDS, INTERVALS, MAX_UPLOAD_BYTES, HEADER, FOOTER,
  getSettings, saveSettings, list, remove, prune, pathOf, createStored, createTemp, storeUpload, restore, parse,
  isBusy, startScheduler, runAutoIfDue, lastAuto,
};
