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
  `CREATE TABLE IF NOT EXISTS customers (
     id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
     name          VARCHAR(120) NOT NULL,
     phone         VARCHAR(20)  NULL,
     zalo_user_id  VARCHAR(64)  NULL,
     note          VARCHAR(255) NULL,
     created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_customers_phone (phone),
     UNIQUE KEY uq_customers_zalo (zalo_user_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

UPGRADES.push(
  `CREATE TABLE IF NOT EXISTS customer_ledger (
     id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     customer_id  INT UNSIGNED  NOT NULL,
     order_id     INT UNSIGNED  NULL,
     entry_type   ENUM('debt','payment','adjust') NOT NULL,
     amount       DECIMAL(14,2) NOT NULL,
     method       ENUM('cash','transfer','card','other') NULL,
     note         VARCHAR(255)  NULL,
     created_by   INT UNSIGNED  NULL,
     created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_ledger_order (order_id, entry_type),
     KEY idx_ledger_customer (customer_id, created_at),
     CONSTRAINT fk_ledger_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
     CONSTRAINT fk_ledger_order    FOREIGN KEY (order_id)    REFERENCES orders (id)    ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // QR payments through PayOn (services/payon): one row per QR; created here so existing databases get it.
  `CREATE TABLE IF NOT EXISTS payon_payments (
     id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_request_id  VARCHAR(64)  NOT NULL,                 -- our unique id sent to PayOn (order code + random suffix)
  kind                 ENUM('order','debt') NOT NULL DEFAULT 'order',
  order_id             INT UNSIGNED NULL,
  customer_id          INT UNSIGNED NULL,
  amount               DECIMAL(14,2) NOT NULL,                -- what the QR asks for
  status               ENUM('pending','applying','paid','manual','resolved','failed','expired') NOT NULL DEFAULT 'pending',
  payon_status         TINYINT      NULL,                     -- PayOn's own status (2 = success)
  payment_id           VARCHAR(40)  NULL,
  transaction_id       VARCHAR(64)  NULL,
  received             DECIMAL(14,2) NULL,
  fee                  DECIMAL(14,2) NULL,
  qr_pay               TEXT         NULL,                     -- QR content
  qr_image             MEDIUMTEXT   NULL,                     -- base64 picture, if PayOn sends one
  expires_at           DATETIME     NOT NULL,
  paid_at              DATETIME     NULL,
  note                 VARCHAR(255) NULL,                     -- why a payment needs a person (status manual)
  created_by           INT UNSIGNED NULL,
  created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payon_request (merchant_request_id),
  KEY idx_payon_order (order_id),
  KEY idx_payon_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Answers of the app's idempotent writes (middlewares/idempotency.js): survive a redeploy, shared by every worker.
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     id            CHAR(64)      NOT NULL,
     scope         VARCHAR(255)  NOT NULL,
     request_hash  CHAR(64)      NOT NULL,
     status        SMALLINT      NULL,
     body          MEDIUMTEXT    NULL,
     created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_idempotency_created (created_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Who did what (discounts so far): models/auditModel.js
  `CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id     INT UNSIGNED  NULL,
    action      VARCHAR(40)   NOT NULL,
    entity      VARCHAR(60)   NOT NULL,
    details     JSON          NULL,
    created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_audit_entity (entity, created_at),
    KEY idx_audit_action (action, created_at),
    KEY idx_audit_user (user_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Photos uploaded from the admin live in the database: a Node.js redeploy replaces public_html (public/uploads).
  `CREATE TABLE IF NOT EXISTS media_files (
     id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
     folder      VARCHAR(20)  NOT NULL,
     mime        VARCHAR(30)  NOT NULL,
     bytes       MEDIUMBLOB   NOT NULL,
     size        INT UNSIGNED NOT NULL,
     created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
);

/** Columns added to existing tables: [table, column, ALTER statement]. MySQL 8 has no ADD COLUMN IF NOT EXISTS. */
const COLUMNS = [
  ['orders', 'customer_id', 'ALTER TABLE orders ADD COLUMN customer_id INT UNSIGNED NULL AFTER note, ADD KEY idx_orders_customer (customer_id)'],
  ['products', 'image_url', 'ALTER TABLE products ADD COLUMN image_url VARCHAR(255) NULL'],
  ['inventory_items', 'image_url', 'ALTER TABLE inventory_items ADD COLUMN image_url VARCHAR(255) NULL'],
];

/**
 * Backfill, idempotent: link Zalo orders to known customers, and open a debt row for every
 * confirmed-but-unpaid order of a customer that has none yet (uq_ledger_order makes it a no-op afterwards).
 */
const BACKFILL = [
  `UPDATE orders o JOIN customers c ON c.zalo_user_id = o.zalo_user_id
      SET o.customer_id = c.id
    WHERE o.customer_id IS NULL AND o.zalo_user_id IS NOT NULL`,
  `INSERT IGNORE INTO customer_ledger (customer_id, order_id, entry_type, amount, note, created_at)
   SELECT o.customer_id, o.id, 'debt', o.total, CONCAT('Nợ đơn ', o.order_code), COALESCE(o.completed_at, o.created_at)
     FROM orders o
    WHERE o.customer_id IS NOT NULL AND o.status = 'completed' AND o.payment_status = 'unpaid'`,
];

async function ensureSchemaUpgrades() {
  const { pool } = require('./db');
  try {
    for (const sql of UPGRADES) await pool.query(sql);
    for (const [table, column, alter] of COLUMNS) {
      const [[{ n }]] = await pool.query(
        'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
        [table, column]
      );
      if (!Number(n)) { await pool.query(alter); logger.info(`Schema upgrade: added ${table}.${column}`); }
    }
    for (const sql of BACKFILL) await pool.query(sql);
    return 'ok';
  } catch (err) {
    logger.error('Schema upgrade failed', err);
    return 'failed';
  }
}

module.exports = { bootstrapIfEmpty, ensureSchemaUpgrades };
