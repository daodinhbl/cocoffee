const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const env = require('../config/env');
const tenantContext = require('../config/tenantContext');
const tenantModel = require('../models/tenantModel');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');

/**
 * Shops (tenants): every shop is a sub-domain <slug>.<TENANT_BASE_DOMAIN> with its OWN MySQL database.
 * Hostinger will not let the app create databases, so spare, empty databases are registered up front
 * (`node scripts/tenant.js add-db ...`); a sign-up takes the next free one, builds the schema in it and creates the
 * owner's admin account. With no spare database the sign-up stays "pending" and is finished by the operator
 * (`node scripts/tenant.js provision <slug>`), or automatically the moment a database is added.
 */
const DB_DIR = path.join(env.rootDir, 'database');
const RESERVED = new Set([
  'www', 'api', 'admin', 'app', 'mail', 'smtp', 'ftp', 'webmail', 'ns1', 'ns2', 'dang-ky', 'signup', 'register', 'login', 'static', 'cdn',
  'support', 'help', 'status', 'download', 'fnb', 'demo', 'test', 'root', 'tasotek', 'system', 'billing',
]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const enabled = () => Boolean(env.tenancy.baseDomain);

// ------------------------------------------------------------------ credentials of the tenant databases
function key() {
  return crypto.createHash('sha256').update(`tenant-db:${env.tenancy.secret || env.jwt.secret}`).digest();
}

/** AES-256-GCM: base64(iv | tag | ciphertext). */
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

function dbOf(row) {
  return { host: row.db_host, port: row.db_port, user: row.db_user, password: decrypt(row.db_password_enc), database: row.db_name };
}

/** A registry row (with its database columns) as the tenant object tenantContext.run expects. */
const tenantOf = (row) => ({ id: row.id, slug: row.slug, name: row.name, db: dbOf(row) });

// ------------------------------------------------------------------ host -> shop
const CACHE_MS = 30 * 1000;
const resolved = new Map();   // slug -> { at, value }

/** The sub-domain part of `host` under the base domain, or null (not a shop host). The default shop's own host returns its slug. */
function slugOfHost(host) {
  if (!enabled()) return null;
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  const base = env.tenancy.baseDomain;
  if (h === base || h === `www.${base}`) return env.tenancy.defaultSlug;
  if (!h.endsWith(`.${base}`)) return null;
  const sub = h.slice(0, -(base.length + 1));
  return sub.includes('.') ? null : sub;
}

/**
 * Looks a slug up: { id, slug, name, db } for an active shop, 'pending' / 'suspended' for one that cannot serve yet,
 * 'deleting' for one its owner asked to delete (services/accountDeletion.js), null when unknown. The default slug is never a tenant (it is the main database).
 */
async function resolve(slug) {
  const hit = resolved.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = await tenantModel.findBySlug(slug);
  let value = null;
  if (row) {
    if (row.delete_after) value = 'deleting';
    else if (row.status === 'active' && row.db_name) value = tenantOf(row);
    else value = row.status === 'suspended' ? 'suspended' : 'pending';
  }
  resolved.set(slug, { at: Date.now(), value });
  return value;
}

const forget = (slug) => resolved.delete(slug);

// ------------------------------------------------------------------ sign-up
function validateSignup(b) {
  const slug = String(b.slug || '').trim().toLowerCase();
  const name = String(b.name || '').trim();
  const ownerName = String(b.ownerName || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const phone = String(b.phone || '').trim();
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  const fail = (msg, field) => { const e = new AppError(400, 'VALIDATION', msg); e.field = field; throw e; };
  if (!SLUG_RE.test(slug)) fail('Tên miền phụ gồm 3-30 ký tự: chữ thường, số và dấu gạch ngang, không bắt đầu hoặc kết thúc bằng dấu gạch.', 'slug');
  if (RESERVED.has(slug) || slug === env.tenancy.defaultSlug) fail('Tên miền phụ này đã được dành riêng, vui lòng chọn tên khác.', 'slug');
  if (name.length < 2 || name.length > 80) fail('Tên quán cần 2-80 ký tự.', 'name');
  if (ownerName.length < 2 || ownerName.length > 80) fail('Họ tên chủ quán cần 2-80 ký tự.', 'ownerName');
  if (!EMAIL_RE.test(email) || email.length > 120) fail('Email không hợp lệ.', 'email');
  if (phone && !/^[0-9+\s.-]{8,20}$/.test(phone)) fail('Số điện thoại không hợp lệ.', 'phone');
  if (!USER_RE.test(username)) fail('Tên đăng nhập gồm 3-30 ký tự: chữ thường, số, dấu chấm, gạch ngang hoặc gạch dưới.', 'username');
  if (password.length < 10 || password.length > 72) fail('Mật khẩu cần 10-72 ký tự.', 'password');
  if (password !== String(b.password2 ?? b.password)) fail('Hai lần nhập mật khẩu chưa giống nhau.', 'password2');
  return { slug, name, ownerName, email, phone, username, password };
}

/**
 * Registers a shop and its owner account, then tries to give it a database at once.
 * @returns {{ slug, status: 'active'|'pending', url }}
 */
async function signup(body) {
  if (!enabled() || !env.tenancy.signupOpen) throw new AppError(403, 'FORBIDDEN', 'Đăng ký quán mới đang tạm đóng.');
  const f = validateSignup(body);
  if (await tenantModel.slugTaken(f.slug)) {
    const e = new AppError(409, 'DUPLICATE', 'Tên miền phụ này đã có người dùng, vui lòng chọn tên khác.');
    e.field = 'slug';
    throw e;
  }
  let id;
  try {
    id = await tenantModel.insert({
      slug: f.slug, name: f.name, ownerName: f.ownerName, ownerEmail: f.email, ownerPhone: f.phone, ownerUsername: f.username,
      ownerPasswordHash: bcrypt.hashSync(f.password, 12),
    });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') { const e = new AppError(409, 'DUPLICATE', 'Tên miền phụ này vừa có người đăng ký, vui lòng chọn tên khác.'); e.field = 'slug'; throw e; }
    throw err;
  }
  forget(f.slug);
  const status = await module.exports.provision(id).catch((err) => { logger.error(`Tenant ${f.slug}: provisioning failed`, err); return 'pending'; });
  return { slug: f.slug, status, url: urlOf(f.slug) };
}

const urlOf = (slug) => `https://${slug}.${env.tenancy.baseDomain}`;

// ------------------------------------------------------------------ provisioning
async function openConnection(db) {
  return mysql.createConnection({ host: db.host, port: db.port, user: db.user, password: db.password, database: db.database, multipleStatements: true, charset: 'utf8mb4' });
}

/** Builds the schema in an EMPTY database. schema.sql drops tables first, so anything already there makes this refuse. */
async function buildSchema(db) {
  const conn = await openConnection(db);
  try {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    if (Number(n) > 0) throw new Error(`Database ${db.database} is not empty (${n} tables): refusing to build the schema over it`);
    await conn.query(fs.readFileSync(path.join(DB_DIR, 'schema.sql'), 'utf8'));
  } finally {
    await conn.end().catch(() => {});
  }
}

/**
 * Gives a pending shop a database, builds it and creates the owner's admin account. Safe to call again.
 * @returns {Promise<'active'|'pending'>} pending = no spare database (yet) or the build failed (see tenants.error)
 */
async function provision(tenantId) {
  const t = await tenantModel.findById(tenantId);
  if (!t) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
  if (t.status === 'active') return 'active';
  if (!t.owner_password_hash) throw new AppError(409, 'CONFLICT', 'This shop has no owner password left to provision with');

  const dbId = t.db_id || (await tenantModel.claimFreeDb(tenantId));
  if (!dbId) { await tenantModel.markError(tenantId, 'Chưa có database trống để cấp'); return 'pending'; }
  const full = await tenantModel.findDbRow(dbId);
  if (!full) { await tenantModel.releaseDb(tenantId); return 'pending'; }
  const db = dbOf(full);
  try {
    await buildSchema(db);
    const tenant = { id: tenantId, slug: t.slug, name: t.name, db };
    await tenantContext.run(tenant, async () => {
      const { ensureSchemaUpgrades } = require('../config/bootstrapDb');
      const userModel = require('../models/userModel');
      const settingsModel = require('../models/settingsModel');
      if ((await ensureSchemaUpgrades()) !== 'ok') throw new Error('Schema upgrades failed in the new database');
      const userId = await userModel.create({ username: t.owner_username, passwordHash: t.owner_password_hash, fullName: t.owner_name, role: 'admin' });
      await settingsModel.setMany({ 'shop.name': t.name, 'shop.ownerName': t.owner_name, 'shop.email': t.owner_email, 'shop.phone': t.owner_phone || '' }, userId);
    });
    await tenantModel.markActive(tenantId, dbId);
    forget(t.slug);
    logger.info(`Tenant ${t.slug}: provisioned on database ${db.database}`);
    return 'active';
  } catch (err) {
    logger.error(`Tenant ${t.slug}: provisioning failed`, err);
    await tenantModel.markError(tenantId, err.message || 'Provisioning failed');
    // A half-built database must not be handed to another shop: keep it reserved for this tenant until the operator looks.
    return 'pending';
  }
}

/** Finishes every waiting sign-up for which a database is now free. Returns how many became active. */
async function provisionPending() {
  let done = 0;
  for (const { id } of await tenantModel.listPending()) {
    if ((await provision(id)) === 'active') done += 1;
    else break;                       // the next one would find no database either
  }
  return done;
}

async function addDatabase({ host, port, name, user, password, note }) {
  const db = { host, port: Number(port) || 3306, user, password, database: name };
  const conn = await openConnection(db);                       // fails loudly on wrong credentials
  await conn.end();
  return tenantModel.insertDb({ host, port: db.port, name, user, passwordEnc: encrypt(password), note });
}

module.exports = {
  enabled, slugOfHost, resolve, forget, signup, provision, provisionPending, addDatabase, validateSignup, encrypt, decrypt, urlOf, RESERVED,
  tenantOf, openConnection,
};
