/**
 * Load the printed CoCoffee menu (categories, 60 drinks with prices, Zalo aliases) into the database the .env
 * points at, then attach the shipped illustration photos (public/menu). Idempotent: run it again after editing
 * src/config/menuSeed.js. Unlike the one-shot boot step, this re-applies names and prices every time.
 *
 *   node scripts/seed-menu.js
 */
const { pool } = require('../src/config/db');
const { ensureSchemaUpgrades } = require('../src/config/bootstrapDb');
const { runMenuSeed } = require('../src/config/menuSeed');
const { assignMenuPhotos } = require('../src/config/menuPhotos');

(async () => {
  await ensureSchemaUpgrades();
  const { stats } = await runMenuSeed(pool, { once: false });
  console.log(`Menu applied: ${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped (same name already active).`);
  const photos = await assignMenuPhotos(pool);
  console.log(`Photos: ${photos.products} product(s), ${photos.ingredients} ingredient(s) updated.`);
})()
  .catch((err) => { console.error('seed-menu failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
