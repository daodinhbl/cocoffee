const { defaultPool } = require('../config/db');

/**
 * The shop registry. These tables live ONLY in the main database (DB_*), so every call here uses `defaultPool`
 * (never the request's tenant pool).
 */
const db = (conn) => conn || defaultPool;

const MASTER_DDL = [
  `CREATE TABLE IF NOT EXISTS tenant_dbs (
     id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
     db_host         VARCHAR(120) NOT NULL,
     db_port         SMALLINT UNSIGNED NOT NULL DEFAULT 3306,
     db_name         VARCHAR(64)  NOT NULL,
     db_user         VARCHAR(64)  NOT NULL,
     db_password_enc VARCHAR(400) NOT NULL,
     tenant_id       INT UNSIGNED NULL,
     note            VARCHAR(120) NULL,
     created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uq_tenant_dbs_name (db_host, db_name),
     UNIQUE KEY uq_tenant_dbs_tenant (tenant_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS tenants (
     id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
     slug                VARCHAR(30)  NOT NULL,
     name                VARCHAR(100) NOT NULL,
     owner_name          VARCHAR(100) NOT NULL,
     owner_email         VARCHAR(120) NOT NULL,
     owner_phone         VARCHAR(30)  NULL,
     owner_username      VARCHAR(50)  NOT NULL,
     owner_password_hash VARCHAR(100) NULL,
     status              ENUM('pending','active','suspended') NOT NULL DEFAULT 'pending',
     db_id               INT UNSIGNED NULL,
     error               VARCHAR(255) NULL,
     created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     activated_at        TIMESTAMP NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_tenants_slug (slug)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

async function ensureMasterSchema() {
  for (const sql of MASTER_DDL) await defaultPool.query(sql);
}

const BY_SLUG = `SELECT t.*, d.db_host, d.db_port, d.db_name, d.db_user, d.db_password_enc
                   FROM tenants t LEFT JOIN tenant_dbs d ON d.id = t.db_id`;

async function findBySlug(slug) {
  const [rows] = await defaultPool.query(`${BY_SLUG} WHERE t.slug = ? LIMIT 1`, [slug]);
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await defaultPool.query(`${BY_SLUG} WHERE t.id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

async function list() {
  const [rows] = await defaultPool.query(`${BY_SLUG} ORDER BY t.id`);
  return rows;
}

async function listPending() {
  const [rows] = await defaultPool.query("SELECT id FROM tenants WHERE status = 'pending' AND db_id IS NULL ORDER BY id");
  return rows;
}

async function insert({ slug, name, ownerName, ownerEmail, ownerPhone, ownerUsername, ownerPasswordHash }) {
  const [res] = await defaultPool.query(
    `INSERT INTO tenants (slug, name, owner_name, owner_email, owner_phone, owner_username, owner_password_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [slug, name, ownerName, ownerEmail, ownerPhone || null, ownerUsername, ownerPasswordHash]
  );
  return res.insertId;
}

async function insertDb({ host, port, name, user, passwordEnc, note }) {
  const [res] = await defaultPool.query(
    'INSERT INTO tenant_dbs (db_host, db_port, db_name, db_user, db_password_enc, note) VALUES (?, ?, ?, ?, ?, ?)',
    [host, port || 3306, name, user, passwordEnc, note || null]
  );
  return res.insertId;
}

async function listDbs() {
  const [rows] = await defaultPool.query(
    'SELECT d.id, d.db_host, d.db_name, d.db_user, d.tenant_id, d.note, t.slug FROM tenant_dbs d LEFT JOIN tenants t ON t.id = d.tenant_id ORDER BY d.id'
  );
  return rows;
}

/** Atomically reserves one unused database for a tenant; returns its id or null when none is free. */
async function claimFreeDb(tenantId) {
  const [res] = await defaultPool.query('UPDATE tenant_dbs SET tenant_id = ? WHERE tenant_id IS NULL ORDER BY id LIMIT 1', [tenantId]);
  if (!res.affectedRows) return null;
  const [rows] = await defaultPool.query('SELECT id FROM tenant_dbs WHERE tenant_id = ?', [tenantId]);
  return rows[0] ? rows[0].id : null;
}

async function findDbRow(id) {
  const [rows] = await defaultPool.query('SELECT * FROM tenant_dbs WHERE id = ?', [id]);
  return rows[0] || null;
}

async function releaseDb(tenantId) {
  await defaultPool.query('UPDATE tenant_dbs SET tenant_id = NULL WHERE tenant_id = ?', [tenantId]);
}

async function markActive(id, dbId) {
  await defaultPool.query(
    "UPDATE tenants SET status = 'active', db_id = ?, owner_password_hash = NULL, error = NULL, activated_at = NOW() WHERE id = ?",
    [dbId, id]
  );
}

async function markError(id, message) {
  await defaultPool.query('UPDATE tenants SET error = ? WHERE id = ?', [String(message).slice(0, 255), id]);
}

async function setStatus(id, status) {
  await defaultPool.query('UPDATE tenants SET status = ? WHERE id = ?', [status, id]);
}

async function slugTaken(slug) {
  const [rows] = await defaultPool.query('SELECT 1 FROM tenants WHERE slug = ? LIMIT 1', [slug]);
  return rows.length > 0;
}

module.exports = {
  db, ensureMasterSchema, findBySlug, findById, list, listPending, insert, insertDb, listDbs, findDbRow, claimFreeDb, releaseDb,
  markActive, markError, setStatus, slugTaken,
};
