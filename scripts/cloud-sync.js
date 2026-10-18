#!/usr/bin/env node
/**
 * Copies data between the local database (DB_*) and the Hostinger one (CLOUD_DB_*). See services/cloudSync.js for the rules.
 *
 *   node scripts/cloud-sync.js push [--full] [--dry-run] [--only orders,order_items]     local -> cloud
 *   node scripts/cloud-sync.js pull [--full] [--dry-run] [--only ...]                    cloud -> local (first run of a new install)
 *   node scripts/cloud-sync.js status                                                    is the cloud database reachable?
 *
 * Always try --dry-run first: it only counts the rows that would be copied.
 */
const env = require('../src/config/env');
const { defaultPool } = require('../src/config/db');
const svc = require('../src/services/cloudSyncService');
const cloudSync = require('../src/services/cloudSync');

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const c = env.cloudSync;
  if (!c.host || !c.name || !c.user) throw new Error('Set CLOUD_DB_HOST, CLOUD_DB_NAME, CLOUD_DB_USER and CLOUD_DB_PASSWORD first.');
  const remote = svc.remotePool();
  if (cmd === 'status') {
    const [[r]] = await remote.query('SELECT DATABASE() AS db, NOW() AS now');
    console.log(`Cloud database reachable: ${r.db} (server time ${r.now}).`);
    return;
  }
  if (cmd !== 'push' && cmd !== 'pull') { console.log('usage: node scripts/cloud-sync.js push|pull|status [--full] [--dry-run] [--only a,b]'); return; }
  const onlyAt = rest.indexOf('--only');
  const r = await cloudSync.sync({
    from: cmd === 'push' ? defaultPool : remote, to: cmd === 'push' ? remote : defaultPool, local: defaultPool, dir: cmd,
    full: rest.includes('--full'), dryRun: rest.includes('--dry-run'), only: onlyAt >= 0 ? rest[onlyAt + 1].split(',') : null,
  });
  for (const t of r.tables.filter((x) => x.rows)) console.log(`  ${t.table}: ${t.rows}`);
  console.log(`${r.dryRun ? 'Would copy' : 'Copied'} ${r.rows} row(s) in ${r.tables.length} tables (${cmd}).`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => { defaultPool.end(); try { svc.remotePool().end(); } catch (_) { /* never opened */ } });
