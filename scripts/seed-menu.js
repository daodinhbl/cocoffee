/**
 * Load the real CoCoffee menu board (categories, drinks with prices, Zalo keywords) into the database the .env
 * points at. Idempotent: run it again after editing src/config/menuSeed.js. Unlike the one-shot boot step, this
 * re-applies names and prices every time and also adds the extra Zalo keywords.
 *
 *   node scripts/seed-menu.js [--retire] [--dry-run]
 *
 *   --retire   also switch off (is_active = 0) the drinks an earlier seed added that the board no longer lists
 *              (SKUs MN-* and the demo "Trà đá"), and the printed groups left empty; the owner's own products
 *              (any other SKU) are never touched. Reversible from Web Admin > Thực đơn.
 *   --dry-run  show what would change and roll back.
 */
const { pool } = require('../src/config/db');
const { ensureSchemaUpgrades } = require('../src/config/bootstrapDb');
const { runMenuSeed } = require('../src/config/menuSeed');
const { assignMenuPhotos } = require('../src/config/menuPhotos');

const args = process.argv.slice(2);
const retire = args.includes('--retire');
const dryRun = args.includes('--dry-run');

(async () => {
  await ensureSchemaUpgrades();
  const { stats, aliases, retired } = await runMenuSeed(pool, { once: false, aliases: true, retire, dryRun });
  console.log(`${dryRun ? '[dry-run] ' : ''}Menu applied: ${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped (same name already active); ${aliases} Zalo keyword(s) added.`);
  if (retire) console.log(`${dryRun ? '[dry-run] ' : ''}Retired (not on the board): ${retired.length ? retired.join(', ') : 'nothing'}`);
  if (dryRun) { console.log('Rolled back: nothing was written.'); return; }
  const photos = await assignMenuPhotos(pool);
  console.log(`Photos: ${photos.products} product(s), ${photos.ingredients} ingredient(s) updated.`);
})()
  .catch((err) => { console.error('seed-menu failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
