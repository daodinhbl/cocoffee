const { AsyncLocalStorage } = require('async_hooks');

/**
 * Which shop (tenant) the current request / job belongs to. Set once per request by middlewares/tenant.js and read by
 * config/db.js (to pick the database) and by per-tenant caches. No store = the default shop (the main site's own
 * database), which is also what boot tasks, schedulers and every single-tenant install use.
 */
const als = new AsyncLocalStorage();

/** Runs fn with `tenant` ({ id, slug, name, db }) as the current shop. */
const run = (tenant, fn) => als.run(tenant, fn);

/** The current tenant, or null for the default shop. */
const current = () => als.getStore() || null;

/** Key for per-tenant caches: 0 = default shop. */
const key = () => (als.getStore() ? als.getStore().id : 0);

module.exports = { run, current, key };
