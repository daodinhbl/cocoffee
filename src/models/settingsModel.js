const { pool } = require('../config/db');

/** Key/value settings (table app_settings). Values are stored as text; callers parse them. */
const db = (conn) => conn || pool;

/** @returns {Promise<Record<string,string>>} every key starting with `prefix` */
async function getByPrefix(prefix, conn) {
  const [rows] = await db(conn).query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE CONCAT(?, '%')",
    [prefix]
  );
  return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
}

/** Upsert several keys at once. */
async function setMany(values, userId, conn) {
  const entries = Object.entries(values);
  if (!entries.length) return;
  await db(conn).query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES ?
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
    [entries.map(([k, v]) => [k, v === null || v === undefined ? null : String(v), userId || null])]
  );
}

module.exports = { getByPrefix, setMany };
