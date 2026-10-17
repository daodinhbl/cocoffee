#!/usr/bin/env node
/**
 * Operator tool for the multi-shop mode (docs/da-tenant.md). Run it on the server (or locally with the production .env).
 *
 *   node scripts/tenant.js add-db <host> <db_name> <db_user> <db_password> [port]   register an EMPTY spare database
 *   node scripts/tenant.js list                                                      shops and databases
 *   node scripts/tenant.js provision [<slug>]                                        finish waiting sign-ups (all, or one)
 *   node scripts/tenant.js suspend <slug> | resume <slug>
 *
 * A database must exist (create it in hPanel > Databases) and be completely empty: provisioning builds the schema in it and
 * refuses a database that already has tables.
 */
require('dotenv').config();
const tenantModel = require('../src/models/tenantModel');
const tenantService = require('../src/services/tenantService');
const { defaultPool } = require('../src/config/db');

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  await tenantModel.ensureMasterSchema();
  if (cmd === 'add-db') {
    const [host, name, user, password, port] = a;
    if (!host || !name || !user || !password) throw new Error('usage: add-db <host> <db_name> <db_user> <db_password> [port]');
    const id = await tenantService.addDatabase({ host, name, user, password, port });
    console.log(`Database #${id} registered.`);
    const n = await tenantService.provisionPending();
    if (n) console.log(`${n} waiting shop(s) were set up with it.`);
  } else if (cmd === 'list') {
    console.log('Shops:');
    for (const t of await tenantModel.list()) console.log(`  #${t.id} ${t.slug.padEnd(24)} ${t.status.padEnd(9)} ${t.db_name || '(no database)'}  ${t.owner_email}${t.error ? `  ! ${t.error}` : ''}`);
    console.log('Databases:');
    for (const d of await tenantModel.listDbs()) console.log(`  #${d.id} ${d.db_name.padEnd(24)} ${d.slug ? `used by ${d.slug}` : 'free'}`);
  } else if (cmd === 'provision') {
    if (a[0]) {
      const t = await tenantModel.findBySlug(a[0]);
      if (!t) throw new Error(`unknown shop ${a[0]}`);
      console.log(`${t.slug}: ${await tenantService.provision(t.id)}`);
    } else {
      console.log(`${await tenantService.provisionPending()} shop(s) set up.`);
    }
  } else if (cmd === 'suspend' || cmd === 'resume') {
    const t = await tenantModel.findBySlug(a[0]);
    if (!t) throw new Error(`unknown shop ${a[0]}`);
    await tenantModel.setStatus(t.id, cmd === 'suspend' ? 'suspended' : 'active');
    console.log(`${t.slug}: ${cmd === 'suspend' ? 'suspended' : 'active'} (live within 30 s)`);
  } else {
    console.log('usage: node scripts/tenant.js add-db|list|provision|suspend|resume ...');
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => defaultPool.end());
