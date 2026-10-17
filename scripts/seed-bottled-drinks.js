/**
 * Bottled soft drinks (Sting, Number One, Bò Húc Thái (Redbull), Wake Up 24/7, Trà Xanh Không Độ, C2) as stock-tracked
 * retail goods in "Nước đóng chai" - see src/config/bottledDrinks.js. Idempotent: run it again after editing the list.
 * The four that were plain menu drinks are converted in place (history and keywords kept); stock starts at 0, so
 * receive the first delivery in Web Admin > Nhập kho before selling.
 *
 *   node scripts/seed-bottled-drinks.js [--dry-run]
 */
const { pool, withTransaction } = require('../src/config/db');
const { ensureSchemaUpgrades } = require('../src/config/bootstrapDb');
const { applyBottledDrinks, BOTTLED } = require('../src/config/bottledDrinks');
const { assignMenuPhotos } = require('../src/config/menuPhotos');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  await ensureSchemaUpgrades();
  const rolledBack = new Error('dry-run');
  let result;
  try {
    await withTransaction(async (conn) => {
      result = await applyBottledDrinks(conn);
      if (dryRun) throw rolledBack;
    });
  } catch (err) {
    if (err !== rolledBack) throw err;
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}${BOTTLED.length} drinks: ${result.created} product(s) created, ${result.converted} updated/converted, ${result.items} stock item(s) created, ${result.aliases} keyword(s) set.`);
  if (dryRun) { console.log('Rolled back: nothing was written.'); return; }
  const photos = await assignMenuPhotos(pool);
  console.log(`Photos: ${photos.products} product(s), ${photos.ingredients} ingredient(s) updated.`);
})()
  .catch((err) => { console.error('seed-bottled-drinks failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
