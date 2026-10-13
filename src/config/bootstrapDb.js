const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const env = require('./env');
const logger = require('../utils/logger');

const DB_DIR = path.join(env.rootDir, 'database');

/**
 * First-boot database setup for hosts that cannot import SQL (Hostinger's API only gives a phpMyAdmin
 * link, and the platform-generated DB password is never shown to anyone).
 *
 * Safety contract:
 *   - does nothing unless AUTO_BOOTSTRAP_DB=true;
 *   - runs ONLY when the target database holds no data. schema.sql starts with DROP TABLE IF EXISTS, so the
 *     emptiness check is what guarantees a redeploy can never wipe real data. "No data" means zero tables, or
 *     a previous bootstrap that stopped half-way (DDL cannot be rolled back): only our own tables, every one
 *     of them empty, and either some missing or the requested seed absent. Then it is simply re-run;
 *   - SEED_DEMO=true additionally loads seed.sql (demo menu/BOM/tables + the admin account). The seeded
 *     admin/admin is never left live: BOOTSTRAP_ADMIN_PASSWORD replaces it, or a random password is
 *     generated and written to the log once (fail closed on a public host).
 * Failures are logged, never thrown: the API still starts and /health reports the database state.
 *
 * @returns {Promise<'disabled'|'skipped-not-empty'|'applied'|'failed'>}
 */
async function bootstrapIfEmpty() {
  if (!env.db.autoBootstrap) return 'disabled';

  let conn;
  try {
    conn = await mysql.createConnection({
      host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password,
      database: env.db.name, multipleStatements: true, charset: 'utf8mb4',
    });
    const [existing] = await conn.query(
      'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'
    );
    if (existing.length > 0 && !(await isUnfinishedBootstrap(conn, existing.map((r) => r.name || r.NAME || r.TABLE_NAME)))) {
      logger.info(`DB bootstrap skipped: database already has ${existing.length} table(s)`);
      return 'skipped-not-empty';
    }
    if (existing.length > 0) logger.warn('DB bootstrap: resuming an unfinished bootstrap (our tables only, all empty)');

    const files = ['schema.sql', ...(env.db.seedDemo ? ['seed.sql'] : [])];
    for (const f of files) {
      await conn.query(fs.readFileSync(path.join(DB_DIR, f), 'utf8'));
      logger.info(`DB bootstrap applied ${f}`);
    }

    // seed.sql ships admin/admin; replace it before the site takes its first request.
    if (env.db.seedDemo) {
      let pw = env.db.bootstrapAdminPassword;
      if (!pw || pw.length < 10) {
        if (pw) logger.warn('BOOTSTRAP_ADMIN_PASSWORD ignored: it must be at least 10 characters');
        pw = crypto.randomBytes(12).toString('base64url');
        logger.warn(`DB bootstrap generated the admin password (shown once, change it after login): admin / ${pw}`);
      } else {
        logger.info('DB bootstrap set the admin password from BOOTSTRAP_ADMIN_PASSWORD');
      }
      await conn.query("UPDATE users SET password_hash = ? WHERE username = 'admin'", [bcrypt.hashSync(pw, 12)]);
    }
    return 'applied';
  } catch (err) {
    logger.error('DB bootstrap failed', err);
    return 'failed';
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/** Table names created by schema.sql (read from the file, so the list never drifts). */
function schemaTables() {
  const sql = fs.readFileSync(path.join(DB_DIR, 'schema.sql'), 'utf8');
  return [...sql.matchAll(/CREATE TABLE\s+`?(\w+)`?/gi)].map((m) => m[1].toLowerCase());
}

/** True only for a half-applied bootstrap: nothing but our tables, all empty, and something still missing. */
async function isUnfinishedBootstrap(conn, names) {
  const ours = new Set(schemaTables());
  const lower = names.map((n) => String(n).toLowerCase());
  if (!lower.every((n) => ours.has(n))) return false;              // a foreign table: not our database
  for (const n of lower) {
    const [[row]] = await conn.query(`SELECT EXISTS(SELECT 1 FROM \`${n}\`) AS has_rows`);
    if (Number(row.has_rows)) return false;                         // real data: never touch
  }
  const missingTables = [...ours].some((t) => !lower.includes(t));
  return missingTables || env.db.seedDemo;                          // all tables there but the seed never ran
}

/**
 * DEMO_MODE: make sure the demo account exists as an active admin with the published password. The hash is
 * rewritten only when the password does not match, so restarts do not end everyone's demo session.
 * @returns {Promise<'disabled'|'ok'|'reset'|'missing'|'failed'>}
 */
async function ensureDemoAccount() {
  if (!env.demo.enabled) return 'disabled';
  const userModel = require('../models/userModel');
  try {
    const user = await userModel.findByUsername(env.demo.username);
    if (!user) { logger.warn(`DEMO_MODE: account "${env.demo.username}" does not exist`); return 'missing'; }
    if (user.is_active && user.role === 'admin' && bcrypt.compareSync(env.demo.password, user.password_hash)) return 'ok';
    await userModel.setPassword(user.id, bcrypt.hashSync(env.demo.password, 12));
    await userModel.setActive(user.id, true);
    logger.info(`DEMO_MODE: demo account "${env.demo.username}" reset`);
    return 'reset';
  } catch (err) {
    logger.error('DEMO_MODE: could not prepare the demo account', err);
    return 'failed';
  }
}

/**
 * Additive schema upgrades for databases created by an older schema.sql (production keeps its data, so
 * schema.sql is never re-applied there). Only CREATE TABLE IF NOT EXISTS / additive statements belong here.
 * Never throws: a failure is logged and the feature that needs the table degrades to its defaults.
 */
const UPGRADES = [
  `CREATE TABLE IF NOT EXISTS app_settings (
     setting_key   VARCHAR(64)  NOT NULL,
     setting_value TEXT         NULL,
     updated_by    INT UNSIGNED NULL,
     updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (setting_key)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

async function ensureSchemaUpgrades() {
  const { pool } = require('./db');
  try {
    for (const sql of UPGRADES) await pool.query(sql);
    return 'ok';
  } catch (err) {
    logger.error('Schema upgrade failed', err);
    return 'failed';
  }
}

module.exports = { bootstrapIfEmpty, ensureDemoAccount, ensureSchemaUpgrades };
