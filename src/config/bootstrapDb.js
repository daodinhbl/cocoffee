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
  `CREATE TABLE IF NOT EXISTS tax_categories (
     id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
     code       VARCHAR(40)  NOT NULL,
     name       VARCHAR(100) NOT NULL,
     sort_order INT          NOT NULL DEFAULT 0,
     is_active  TINYINT(1)   NOT NULL DEFAULT 1,
     PRIMARY KEY (id),
     UNIQUE KEY uq_tax_categories_code (code)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS tax_rates (
     id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
     category_id    INT UNSIGNED  NOT NULL,
     effective_from DATE          NOT NULL,
     effective_to   DATE          NULL,
     vat_rate       DECIMAL(6,4)  NOT NULL DEFAULT 0,
     pit_rate       DECIMAL(6,4)  NOT NULL DEFAULT 0,
     legal_basis    VARCHAR(200)  NULL,
     created_by     INT UNSIGNED  NULL,
     created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_tax_rates_from (category_id, effective_from),
     CONSTRAINT fk_tax_rates_category FOREIGN KEY (category_id) REFERENCES tax_categories (id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS rev_daily (
     day             DATE          NOT NULL,
     tax_category_id INT UNSIGNED  NOT NULL,
     lines_count     INT UNSIGNED  NOT NULL DEFAULT 0,
     gross_revenue   DECIMAL(16,2) NOT NULL DEFAULT 0,
     discount        DECIMAL(16,2) NOT NULL DEFAULT 0,
     net_revenue     DECIMAL(16,2) NOT NULL DEFAULT 0,
     vat_amount      DECIMAL(16,2) NOT NULL DEFAULT 0,
     pit_amount      DECIMAL(16,2) NOT NULL DEFAULT 0,
     updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (day, tax_category_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS exp_daily (
     day         DATE          NOT NULL,
     category_id INT UNSIGNED  NOT NULL,
     amount      DECIMAL(16,2) NOT NULL DEFAULT 0,
     tx_count    INT           NOT NULL DEFAULT 0,
     updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (day, category_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS tax_periods (
     id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
     kind        ENUM('month','quarter','year') NOT NULL,
     period_from DATE         NOT NULL,
     period_to   DATE         NOT NULL,
     status      ENUM('open','locked','filed') NOT NULL DEFAULT 'locked',
     totals_json MEDIUMTEXT   NULL,
     filed_ref   VARCHAR(100) NULL,
     locked_by   INT UNSIGNED NULL,
     locked_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_tax_periods (kind, period_from),
     KEY idx_tax_periods_range (period_from, period_to),
     CONSTRAINT fk_tax_periods_user FOREIGN KEY (locked_by) REFERENCES users (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS tax_exports (
     id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
     kind         ENUM('s2a','revenue_book','expense_book','declaration','bundle') NOT NULL,
     period_from  DATE         NOT NULL,
     period_to    DATE         NOT NULL,
     status       ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
     attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
     file_name    VARCHAR(150) NULL,
     file_bytes   BIGINT UNSIGNED NULL,
     error        VARCHAR(255) NULL,
     requested_by INT UNSIGNED NULL,
     created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     started_at   DATETIME     NULL,
     finished_at  DATETIME     NULL,
     expires_at   DATETIME     NULL,
     PRIMARY KEY (id),
     KEY idx_tax_exports_status (status, id),
     CONSTRAINT fk_tax_exports_user FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS expense_categories (
     id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
     code          VARCHAR(40)  NOT NULL,
     name          VARCHAR(100) NOT NULL,
     parent_id     INT UNSIGNED NULL,
     tax_treatment ENUM('deductible','non_deductible','capex') NOT NULL DEFAULT 'deductible',
     ledger_code   VARCHAR(20)  NULL,
     sort_order    INT          NOT NULL DEFAULT 0,
     is_system     TINYINT(1)   NOT NULL DEFAULT 0,
     is_active     TINYINT(1)   NOT NULL DEFAULT 1,
     created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_expense_categories_code (code),
     KEY idx_expense_categories_parent (parent_id),
     CONSTRAINT fk_expense_categories_parent FOREIGN KEY (parent_id) REFERENCES expense_categories (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS expenses (
     id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
     expense_date        DATE          NOT NULL,
     category_id         INT UNSIGNED  NOT NULL,
     amount              DECIMAL(14,2) NOT NULL,
     vat_included       TINYINT(1)    NOT NULL DEFAULT 0,
     payee               VARCHAR(120)  NULL,
     supplier_id         INT UNSIGNED  NULL,
     purchase_receipt_id INT UNSIGNED  NULL,
     doc_no              VARCHAR(40)   NULL,
     note                VARCHAR(255)  NULL,
     receipt_media_id    INT UNSIGNED  NULL,
     receipt_sha256      CHAR(64)      NULL,
     source              ENUM('manual','purchase') NOT NULL DEFAULT 'manual',
     status              ENUM('posted','void') NOT NULL DEFAULT 'posted',
     void_reason         VARCHAR(255)  NULL,
     created_by          INT UNSIGNED  NULL,
     voided_by           INT UNSIGNED  NULL,
     created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_expenses_receipt (purchase_receipt_id),
     KEY idx_expenses_date (expense_date, category_id),
     KEY idx_expenses_category (category_id, expense_date),
     KEY idx_expenses_supplier (supplier_id),
     KEY idx_expenses_sha (receipt_sha256),
     CONSTRAINT fk_expenses_category FOREIGN KEY (category_id)         REFERENCES expense_categories (id),
     CONSTRAINT fk_expenses_supplier FOREIGN KEY (supplier_id)         REFERENCES suppliers (id)         ON DELETE SET NULL,
     CONSTRAINT fk_expenses_receipt  FOREIGN KEY (purchase_receipt_id) REFERENCES purchase_receipts (id) ON DELETE SET NULL,
     CONSTRAINT fk_expenses_user     FOREIGN KEY (created_by)          REFERENCES users (id)             ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS suppliers (
     id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
     name       VARCHAR(120) NOT NULL,
     phone      VARCHAR(30)  NULL,
     address    VARCHAR(200) NULL,
     tax_code   VARCHAR(30)  NULL,
     note       VARCHAR(255) NULL,
     is_active  TINYINT(1)   NOT NULL DEFAULT 1,
     created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_suppliers_name (name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS purchase_receipts (
     id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
     receipt_code VARCHAR(30)   NULL,
     supplier_id  INT UNSIGNED  NULL,
     doc_no       VARCHAR(40)   NULL,
     note         VARCHAR(255)  NULL,
     total        DECIMAL(14,2) NOT NULL DEFAULT 0,
     paid         DECIMAL(14,2) NOT NULL DEFAULT 0,
     created_by   INT UNSIGNED  NULL,
     created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_receipts_code (receipt_code),
     KEY idx_receipts_supplier (supplier_id, created_at),
     KEY idx_receipts_created (created_at),
     CONSTRAINT fk_receipts_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE SET NULL,
     CONSTRAINT fk_receipts_user     FOREIGN KEY (created_by)  REFERENCES users (id)     ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS purchase_receipt_lines (
     id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
     receipt_id        INT UNSIGNED  NOT NULL,
     inventory_item_id INT UNSIGNED  NOT NULL,
     item_name         VARCHAR(150)  NOT NULL,
     unit              VARCHAR(20)   NOT NULL,
     pack_label        VARCHAR(30)   NULL,
     pack_qty          DECIMAL(14,3) NOT NULL DEFAULT 0,
     pack_factor       DECIMAL(14,3) NOT NULL DEFAULT 1,
     pack_price        DECIMAL(14,4) NOT NULL DEFAULT 0,
     quantity          DECIMAL(14,3) NOT NULL,
     unit_cost         DECIMAL(14,4) NOT NULL,
     line_total        DECIMAL(14,2) NOT NULL,
     PRIMARY KEY (id),
     KEY idx_receipt_lines_receipt (receipt_id),
     KEY idx_receipt_lines_item (inventory_item_id),
     CONSTRAINT fk_receipt_lines_receipt FOREIGN KEY (receipt_id)        REFERENCES purchase_receipts (id) ON DELETE CASCADE,
     CONSTRAINT fk_receipt_lines_item    FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id)   ON DELETE RESTRICT
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS supplier_payments (
     id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
     supplier_id INT UNSIGNED  NOT NULL,
     receipt_id  INT UNSIGNED  NULL,
     amount      DECIMAL(14,2) NOT NULL,
     method      ENUM('cash','transfer','other') NOT NULL DEFAULT 'cash',
     note        VARCHAR(255)  NULL,
     created_by  INT UNSIGNED  NULL,
     paid_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_supplier_payments_supplier (supplier_id, paid_at),
     KEY idx_supplier_payments_receipt (receipt_id),
     CONSTRAINT fk_supplier_payments_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id)         ON DELETE CASCADE,
     CONSTRAINT fk_supplier_payments_receipt  FOREIGN KEY (receipt_id)  REFERENCES purchase_receipts (id) ON DELETE SET NULL,
     CONSTRAINT fk_supplier_payments_user     FOREIGN KEY (created_by)  REFERENCES users (id)             ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS shifts (
     id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
     period_from    DATETIME      NOT NULL,
     period_to      DATETIME      NOT NULL,
     closed_by      INT UNSIGNED  NULL,
     opening_cash   DECIMAL(14,2) NOT NULL DEFAULT 0,
     counted_cash   DECIMAL(14,2) NOT NULL DEFAULT 0,
     expected_cash  DECIMAL(14,2) NOT NULL DEFAULT 0,
     difference     DECIMAL(14,2) NOT NULL DEFAULT 0,
     cash_total     DECIMAL(14,2) NOT NULL DEFAULT 0,
     transfer_total DECIMAL(14,2) NOT NULL DEFAULT 0,
     card_total     DECIMAL(14,2) NOT NULL DEFAULT 0,
     other_total    DECIMAL(14,2) NOT NULL DEFAULT 0,
     orders_count   INT UNSIGNED  NOT NULL DEFAULT 0,
     cancelled_count INT UNSIGNED NOT NULL DEFAULT 0,
     revenue        DECIMAL(14,2) NOT NULL DEFAULT 0,
     discount_total DECIMAL(14,2) NOT NULL DEFAULT 0,
     unpaid_total   DECIMAL(14,2) NOT NULL DEFAULT 0,
     note           VARCHAR(255)  NULL,
     created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_shifts_from (period_from),
     KEY idx_shifts_to (period_to),
     CONSTRAINT fk_shifts_user FOREIGN KEY (closed_by) REFERENCES users (id) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
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
  // Leads from the public technical-service QR page (routes/kyThuatRoutes.js, models/leadModel.js).
  `CREATE TABLE IF NOT EXISTS service_leads (
     id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
     name        VARCHAR(120) NOT NULL,
     phone       VARCHAR(20)  NOT NULL,
     need        VARCHAR(40)  NOT NULL,
     source      VARCHAR(30)  NOT NULL DEFAULT 'qr',
     note        VARCHAR(500) NULL,
     status      ENUM('new','contacted','won','lost') NOT NULL DEFAULT 'new',
     created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_leads_phone (phone, created_at),
     KEY idx_leads_status (status, created_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
);

/** Columns added to existing tables: [table, column, ALTER statement]. MySQL 8 has no ADD COLUMN IF NOT EXISTS. */
const COLUMNS = [
  ['orders', 'customer_id', 'ALTER TABLE orders ADD COLUMN customer_id INT UNSIGNED NULL AFTER note, ADD KEY idx_orders_customer (customer_id)'],
  ['dining_tables', 'map_x', 'ALTER TABLE dining_tables ADD COLUMN map_x SMALLINT UNSIGNED NULL AFTER merged_into'],
  ['dining_tables', 'map_y', 'ALTER TABLE dining_tables ADD COLUMN map_y SMALLINT UNSIGNED NULL AFTER map_x'],
  ['dining_tables', 'map_shape', "ALTER TABLE dining_tables ADD COLUMN map_shape ENUM('square','round','long') NOT NULL DEFAULT 'square' AFTER map_y"],
  ['dining_tables', 'merged_into', 'ALTER TABLE dining_tables ADD COLUMN merged_into INT UNSIGNED NULL AFTER current_order_id, ADD KEY idx_tables_merged (merged_into)'],
  ['products', 'image_url', 'ALTER TABLE products ADD COLUMN image_url VARCHAR(255) NULL'],
  ['products', 'tax_category_id', 'ALTER TABLE products ADD COLUMN tax_category_id INT UNSIGNED NULL'],
  ['order_items', 'tax_category_id', 'ALTER TABLE order_items ADD COLUMN tax_category_id INT UNSIGNED NULL, ADD KEY idx_items_tax (tax_category_id)'],
  ['order_items', 'vat_rate', 'ALTER TABLE order_items ADD COLUMN vat_rate DECIMAL(6,4) NULL'],
  ['order_items', 'pit_rate', 'ALTER TABLE order_items ADD COLUMN pit_rate DECIMAL(6,4) NULL'],
  ['order_items', 'net_revenue', 'ALTER TABLE order_items ADD COLUMN net_revenue DECIMAL(14,2) NULL'],
  ['inventory_items', 'pack_name', 'ALTER TABLE inventory_items ADD COLUMN pack_name VARCHAR(20) NULL'],
  ['inventory_items', 'pack_size', 'ALTER TABLE inventory_items ADD COLUMN pack_size DECIMAL(14,3) NULL'],
  ['inventory_items', 'group_code', 'ALTER TABLE inventory_items ADD COLUMN group_code VARCHAR(20) NULL'],
  ['inventory_items', 'image_url', 'ALTER TABLE inventory_items ADD COLUMN image_url VARCHAR(255) NULL'],
];

/**
 * Backfill, idempotent: link Zalo orders to known customers, and open a debt row for every
 * confirmed-but-unpaid order of a customer that has none yet (uq_ledger_order makes it a no-op afterwards).
 */
const BACKFILL = [
  `INSERT IGNORE INTO tax_categories (code, name, sort_order) VALUES
     ('fnb_service', 'Dịch vụ ăn uống (đồ uống pha chế, đồ ăn)', 1),
     ('goods_distribution', 'Bán hàng hóa nguyên trạng (thuốc lá, nước đóng chai)', 2),
     ('none', 'Không chịu thuế / không tính', 3)`,
  `INSERT IGNORE INTO tax_rates (category_id, effective_from, vat_rate, pit_rate, legal_basis)
   SELECT c.id, '2026-01-01', x.vat, x.pit, 'Mặc định tạm thời, kế toán cần xác nhận theo văn bản hiện hành'
     FROM tax_categories c JOIN (SELECT 'fnb_service' AS code, 0.03 AS vat, 0.015 AS pit
                                 UNION ALL SELECT 'goods_distribution', 0.01, 0.005
                                 UNION ALL SELECT 'none', 0, 0) x ON x.code = c.code`,
  `INSERT IGNORE INTO expense_categories (code, name, tax_treatment, sort_order, is_system) VALUES
     ('nguyen-vat-lieu', 'Nguyên vật liệu & hàng hóa', 'deductible', 1, 1),
     ('bao-bi', 'Bao bì & vật dụng', 'deductible', 2, 1),
     ('nhan-cong', 'Nhân công / lương', 'deductible', 3, 1),
     ('thue-mat-bang', 'Thuê mặt bằng', 'deductible', 4, 1),
     ('dien-nuoc', 'Điện, nước, internet', 'deductible', 5, 1),
     ('marketing', 'Marketing & quảng cáo', 'deductible', 6, 1),
     ('sua-chua', 'Sửa chữa & bảo trì', 'deductible', 7, 1),
     ('thiet-bi', 'Mua thiết bị, dụng cụ', 'capex', 8, 1),
     ('thue-phi', 'Thuế, phí, lệ phí', 'non_deductible', 9, 1),
     ('khac', 'Chi phí khác', 'deductible', 10, 1)`,
  `INSERT IGNORE INTO expenses (expense_date, category_id, amount, payee, supplier_id, purchase_receipt_id, doc_no, note, source, created_by, created_at)
   SELECT DATE(r.created_at), (SELECT id FROM expense_categories WHERE code = 'nguyen-vat-lieu'), r.total, COALESCE(s.name, 'Mua lẻ'),
          r.supplier_id, r.id, r.doc_no, CONCAT('Phiếu nhập ', r.receipt_code), 'purchase', r.created_by, r.created_at
     FROM purchase_receipts r LEFT JOIN suppliers s ON s.id = r.supplier_id
    WHERE r.total > 0`,
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
    // tax_exports.kind gained 's2a' (Sổ doanh thu mẫu S2a-HKD): widen the ENUM of an older table once.
    const [[kindCol]] = await pool.query("SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tax_exports' AND column_name = 'kind'");
    if (kindCol && !/'s2a'/.test(kindCol.t || kindCol.COLUMN_TYPE || '')) {
      await pool.query("ALTER TABLE tax_exports MODIFY kind ENUM('s2a','revenue_book','expense_book','declaration','bundle') NOT NULL");
      logger.info('Schema upgrade: tax_exports.kind accepts s2a');
    }
    for (const sql of BACKFILL) await pool.query(sql);
    return 'ok';
  } catch (err) {
    logger.error('Schema upgrade failed', err);
    return 'failed';
  }
}

/**
 * A site built from a schema-only database (SEED_DEMO off) has no account to sign in with. When the users table is empty and
 * BOOTSTRAP_ADMIN_PASSWORD (>= 10 characters) is set, create the first admin from BOOTSTRAP_ADMIN_USER (default "admin").
 * Never overwrites anything and never throws.
 */
async function ensureFirstAdmin() {
  const { pool } = require('./db');
  const pw = env.db.bootstrapAdminPassword;
  if (!pw || pw.length < 10) return 'skipped';
  try {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users');
    if (Number(n) > 0) return 'skipped';
    await pool.query("INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, 'Quản trị viên', 'admin')", [env.db.bootstrapAdminUser, bcrypt.hashSync(pw, 12)]);
    logger.info(`First admin account "${env.db.bootstrapAdminUser}" created from BOOTSTRAP_ADMIN_PASSWORD`);
    return 'created';
  } catch (err) {
    logger.error('First admin account not created', err);
    return 'failed';
  }
}

module.exports = { bootstrapIfEmpty, ensureDemoAccount, ensureSchemaUpgrades, ensureFirstAdmin };
