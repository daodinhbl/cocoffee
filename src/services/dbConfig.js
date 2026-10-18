const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');

/**
 * Change the database server, name, user and password from Cài đặt (web and app) instead of the hosting panel.
 *   section "db"    the database this site runs on (the installer's local MariaDB, or Hostinger's)
 *   section "cloud" the Hostinger database the local box copies to (services/cloudSync.js)
 * The values are saved in a small JSON file (DB_CONFIG_FILE, default data/db-config.json, readable by the account that runs the
 * site only) which config/env.js reads at start and which wins over DB_* / CLOUD_DB_*: the connection is opened once, so a change
 * applies after a restart. A new "db" connection is only saved after it was opened successfully (a typo must not take the site
 * down). The password is write-only: it is never sent back to a browser or the app, only "is one set".
 */
const SECTIONS = ['db', 'cloud'];

const fileOf = () => env.dbConfigFile;

function readFile() {
  try { return JSON.parse(fs.readFileSync(fileOf(), 'utf8')) || {}; } catch (_) { return {}; }
}

const RUNNING = {
  db: () => ({ host: env.db.host, port: env.db.port, name: env.db.name, user: env.db.user, password: env.db.password }),
  cloud: () => ({ host: env.cloudSync.host, port: env.cloudSync.port, name: env.cloudSync.name, user: env.cloudSync.user, password: env.cloudSync.password }),
};

const strip = (c) => (c ? { host: c.host || '', port: c.port || 3306, name: c.name || '', user: c.user || '', hasPassword: Boolean(c.password) } : null);

/** The connections in force and what is saved; `restartNeeded` when the file differs from what the running process uses. */
function view() {
  const saved = readFile();
  const out = { file: fileOf(), canRestart: canRestart(), sections: {} };
  for (const s of SECTIONS) {
    const running = RUNNING[s]();
    const fileSection = saved[s] || null;
    const merged = fileSection ? { ...running, ...Object.fromEntries(Object.entries(fileSection).filter(([, v]) => v !== '' && v !== undefined)) } : running;
    out.sections[s] = {
      running: strip(running),
      saved: strip(fileSection ? merged : null),
      source: fileSection ? 'file' : (running.host || running.name ? 'env' : ''),
      restartNeeded: Boolean(fileSection) && ['host', 'port', 'name', 'user', 'password'].some((k) => String(merged[k] ?? '') !== String(running[k] ?? '')),
    };
  }
  return out;
}

function clean(section, input) {
  const fail = (m) => { throw new AppError(400, 'VALIDATION', m); };
  if (!SECTIONS.includes(section)) fail('Loại kết nối không hợp lệ.');
  const cur = { ...RUNNING[section](), ...Object.fromEntries(Object.entries(readFile()[section] || {}).filter(([, v]) => v !== '' && v !== undefined)) };   // saved values first, then the running ones
  const host = String(input.host ?? cur.host ?? '').trim();
  const port = Number.parseInt(input.port ?? cur.port ?? 3306, 10);
  const name = String(input.name ?? cur.name ?? '').trim();
  const user = String(input.user ?? cur.user ?? '').trim();
  const typed = typeof input.password === 'string' ? input.password : '';
  const password = typed !== '' ? typed : String(cur.password ?? '');   // a blank password field keeps the current one
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || host.length > 120) fail('Máy chủ CSDL không hợp lệ (tên miền hoặc địa chỉ IP, ví dụ 127.0.0.1 hoặc srv2089.hstgr.io).');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Cổng phải từ 1 đến 65535.');
  if (!/^[A-Za-z0-9_$.-]{1,64}$/.test(name)) fail('Tên cơ sở dữ liệu không hợp lệ (chữ, số, gạch dưới, tối đa 64 ký tự).');
  if (!/^[A-Za-z0-9_$.@-]{1,64}$/.test(user)) fail('Tên người dùng CSDL không hợp lệ.');
  if (!password) fail('Cần nhập mật khẩu CSDL.');
  if (password.length > 200) fail('Mật khẩu CSDL quá dài.');
  return { host, port, name, user, password };
}

const REASONS = {
  ER_ACCESS_DENIED_ERROR: 'Sai tên người dùng hoặc mật khẩu CSDL (hoặc người dùng này chưa được phép kết nối từ máy này: với Hostinger, thêm IP của máy ở hPanel > Remote MySQL).',
  ER_DBACCESS_DENIED_ERROR: 'Người dùng này không có quyền với cơ sở dữ liệu đó.',
  ER_BAD_DB_ERROR: 'Cơ sở dữ liệu này chưa tồn tại trên máy chủ.',
  ECONNREFUSED: 'Máy chủ CSDL từ chối kết nối (chưa chạy, hoặc sai cổng).',
  ETIMEDOUT: 'Hết thời gian chờ: máy chủ CSDL không phản hồi (sai địa chỉ, tường lửa hoặc mất mạng).',
  ENOTFOUND: 'Không tìm thấy máy chủ CSDL với tên này.',
  EAI_AGAIN: 'Không tra được tên máy chủ CSDL (mất mạng?).',
  ECONNRESET: 'Kết nối bị ngắt giữa chừng.',
};

/** Opens a connection with the given values; returns what it found. Throws AppError(400) with the reason in Vietnamese. */
async function test(section, input) {
  const c = clean(section, input);
  let conn;
  try {
    conn = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.name, connectTimeout: 8000 });
    const [[v]] = await conn.query('SELECT VERSION() AS v');
    const [[t]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    return { ok: true, version: String(v.v), tables: Number(t.n), empty: Number(t.n) === 0 };
  } catch (err) {
    logger.warn(`DB connection test failed (${section}): ${err.code || err.message}`);
    throw new AppError(400, 'DB_CONNECT', REASONS[err.code] || `Không kết nối được: ${err.code || err.message}`);
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/** Tests, then saves one section to the file (atomic write, owner-only permissions). The change applies after a restart. */
async function save(section, input) {
  const c = clean(section, input);
  const probe = await test(section, c);                       // never save a connection that does not open
  const file = fileOf();
  const all = readFile();
  all[section] = { host: c.host, port: c.port, name: c.name, user: c.user, password: c.password };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  logger.info(`Database connection "${section}" saved to ${file}: ${c.user}@${c.host}:${c.port}/${c.name}`);
  return { ...probe, restartNeeded: true };
}

/** Removes the saved section: the environment values apply again after a restart. */
function reset(section) {
  if (!SECTIONS.includes(section)) throw new AppError(400, 'VALIDATION', 'Loại kết nối không hợp lệ.');
  const all = readFile();
  delete all[section];
  fs.mkdirSync(path.dirname(fileOf()), { recursive: true });
  fs.writeFileSync(fileOf(), JSON.stringify(all, null, 2), { mode: 0o600 });
}

/** Only where something starts the site again after it exits (Passenger on Hostinger, the Windows service manager). */
function canRestart() {
  return typeof PhusionPassenger !== 'undefined' || /^(1|true|yes)$/i.test(process.env.SERVICE_MANAGED || '');   // eslint-disable-line no-undef
}

function restart() {
  if (!canRestart()) throw new AppError(409, 'NO_SUPERVISOR', 'Ứng dụng đang chạy trực tiếp nên không tự khởi động lại được. Hãy tắt và mở lại ứng dụng (hoặc khởi động lại trong hPanel).');
  setTimeout(() => process.exit(0), 700).unref();
}

module.exports = { view, test, save, reset, restart, clean, canRestart, SECTIONS };
