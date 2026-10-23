const bcrypt = require('bcryptjs');

const tenantContext = require('../config/tenantContext');
const { closeTenantPool } = require('../config/db');
const tenantModel = require('../models/tenantModel');
const tenantService = require('./tenantService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/httpError');

/**
 * Deleting a shop that was created by sign-up (the app's "Tạo quán mới" or the web's /dang-ky), as Google Play asks of
 * apps that create accounts: from the app (Cài đặt > Xóa tài khoản, POST /api/account/delete) or from the web page
 * /xoa-tai-khoan. The shop stops serving at once (its host answers 410) and, after GRACE_DAYS (time to change one's
 * mind by e-mail), every table of its database is dropped, the emptied database goes back to the spare pool and the
 * registry row (owner name, e-mail, phone) is removed.
 *
 * Shops that were not created by sign-up (the main shop, a self-hosted install) have no registry row: their owner
 * runs the server and deletes the data there, so these calls refuse with ACCOUNT_NOT_DELETABLE.
 */
const GRACE_DAYS = 30;
const { DUMMY_HASH } = require('../controllers/admin/authPages');

const badCredentials = () => new AppError(401, 'BAD_CREDENTIALS', 'Wrong shop, username or password');

/** Schedules the deletion of shop `tenantId`. @returns {{ slug, delete_after: Date, grace_days }} */
async function request(tenantId) {
  const t = await tenantModel.findById(tenantId);
  if (!t) throw new AppError(404, 'NOT_FOUND', 'Shop not found');
  if (!t.delete_after) await tenantModel.requestDeletion(t.id, GRACE_DAYS);
  tenantService.forget(t.slug);
  await closeTenantPool(t.id);
  const after = (await tenantModel.findById(tenantId))?.delete_after || null;
  logger.info(`Tenant ${t.slug}: deletion requested (purge after ${after ? new Date(after).toISOString() : '?'})`);
  return { slug: t.slug, delete_after: after, grace_days: GRACE_DAYS };
}

/**
 * Checks the owner's credentials for the web form: an admin account of the shop's own database, or (a sign-up still
 * waiting for its database) the owner account kept in the registry. Every failure looks the same.
 * @returns {Promise<object>} the registry row
 */
async function verifyOwner(slug, username, password) {
  const s = String(slug || '').trim().toLowerCase();
  const u = String(username || '').trim().toLowerCase();
  const pw = String(password || '');
  const row = s && u && pw ? await tenantModel.findBySlug(s) : null;
  if (!row) {
    await bcrypt.compare(pw, DUMMY_HASH);         // same timing as a real check
    throw badCredentials();
  }
  let ok = false;
  if (row.db_name) {
    const user = await tenantContext.run(tenantService.tenantOf(row), () => require('../models/userModel').findByUsername(u));
    ok = await bcrypt.compare(pw, user ? user.password_hash : DUMMY_HASH);
    ok = ok && Boolean(user) && user.role === 'admin' && Boolean(user.is_active);
  } else {
    ok = await bcrypt.compare(pw, row.owner_password_hash || DUMMY_HASH);
    ok = ok && Boolean(row.owner_password_hash) && row.owner_username === u;
  }
  if (!ok) throw badCredentials();
  return row;
}

/** Drops every table of the shop's database, gives the database back to the spare pool and forgets the shop. */
async function purge(tenantId) {
  const t = await tenantModel.findById(tenantId);
  if (!t) return false;
  await closeTenantPool(t.id);
  if (t.db_name) {
    const conn = await tenantService.openConnection(tenantService.tenantOf(t).db);
    try {
      const [rows] = await conn.query('SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = DATABASE()');
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const r of rows) await conn.query(`DROP ${r.type === 'VIEW' ? 'VIEW' : 'TABLE'} IF EXISTS \`${String(r.name).replace(/`/g, '``')}\``);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
      await conn.end().catch(() => {});
    }
  }
  await tenantModel.releaseDb(t.id);
  await tenantModel.remove(t.id);
  tenantService.forget(t.slug);
  logger.info(`Tenant ${t.slug}: purged (deletion requested by the owner)`);
  return true;
}

/** Purges every shop whose grace period is over. Returns how many were purged. */
async function purgeDue() {
  let n = 0;
  for (const { id } of await tenantModel.listDueForPurge()) {
    try {
      if (await purge(id)) n += 1;
    } catch (err) {
      logger.error(`Tenant #${id}: purge failed`, err);
    }
  }
  if (n) await tenantService.provisionPending().catch(() => {});   // a freed database may finish a waiting sign-up
  return n;
}

/** Twice a day while the multi-shop mode is on; never throws. */
function startScheduler() {
  if (!tenantService.enabled()) return;
  const run = () => purgeDue().catch((err) => logger.error('Shop purge failed', err));
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 12 * 60 * 60 * 1000).unref();
}

module.exports = { GRACE_DAYS, request, verifyOwner, purge, purgeDue, startScheduler };
