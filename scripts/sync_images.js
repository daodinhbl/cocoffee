/**
 * Find, download and attach photos to products (menu) and inventory items (ingredients) that have none.
 *
 *   node scripts/sync_images.js                     # everything still missing a photo
 *   node scripts/sync_images.js --only products     # or --only ingredients
 *   node scripts/sync_images.js --limit 5           # at most 5 records this run
 *   node scripts/sync_images.js --dry-run           # search only, download/update nothing
 *   node scripts/sync_images.js --force             # also replace photos that are already set
 *
 * Flow per record (strictly one at a time):
 *   1. read rows whose image_url is NULL (never set)     (MySQL via the app's pool, mysql2/promise)
 *   2. search Pexels with an English query built from the Vietnamese name
 *   3. download the first hit as a square ~400px JPEG    (Pexels CDN resizes: small file, light on the host)
 *   4. store it in media_files (same validation as an admin upload: real JPEG/PNG/WebP, <= 600 KB)
 *   5. UPDATE image_url = '/media/<id>-<slug>.jpg'
 *   ...then sleep 2.5s before the next record (Pexels rate limit + shared-hosting CPU limits).
 * A failure on one record (no result, HTTP error, bad image) is logged and the loop moves on.
 *
 * Hostinger: run it over SSH or as a cron job from the app folder. Plain HTTP only (axios), no browser.
 * Photos are stored in MySQL (media_files, served at /media/...) like photos uploaded in the admin, so a
 * Node.js redeploy (which replaces public_html) does not lose them.
 *
 * Needs PEXELS_API_KEY (free: https://www.pexels.com/api/). Photos are credited in the log; Pexels' licence
 * allows commercial use without attribution, but keep the credit if you show it publicly.
 */
const axios = require('axios');
const { pool } = require('../src/config/db');
const { ensureSchemaUpgrades } = require('../src/config/bootstrapDb');
const imageStore = require('../src/services/imageStore');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '[YOUR_PEXELS_API_KEY]';
const DELAY_MS = 2500;                 // pause between records (>= 2s as required on shared hosting)
const SIZE = 400;                      // square edge in px

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const val = (f) => { const i = args.indexOf(`--${f}`); return i >= 0 ? args[i + 1] : undefined; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "Cà phê sữa đá" -> "ca-phe-sua-da" */
function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

/**
 * Pexels is searched in English: translate the common Vietnamese F&B words, keep brand names / unknown
 * words as they are, and add a context word so "Đường" (sugar) does not return streets.
 */
const VI_EN = [
  [/ca phe sua da|cafe sua da/, 'vietnamese iced milk coffee'], [/ca phe den|cafe den/, 'black iced coffee'],
  [/bac xiu/, 'iced latte milk coffee'], [/ca phe|cafe|coffee/, 'coffee'], [/tra dao/, 'peach iced tea'],
  [/tra vai/, 'lychee tea'], [/tra sua/, 'milk tea boba'], [/tra da/, 'iced tea glass'], [/\btra\b/, 'tea'],
  [/sinh to/, 'smoothie'], [/nuoc cam/, 'orange juice'], [/nuoc ep/, 'fresh juice'], [/banh mi/, 'baguette sandwich'],
  [/banh/, 'cake pastry'], [/thuoc la/, 'cigarette pack'], [/nuoc suoi|aquafina|lavie/, 'bottled water'],
  [/sua dac/, 'condensed milk'], [/sua tuoi/, 'fresh milk'], [/\bsua\b/, 'milk'], [/duong/, 'sugar'],
  [/syrup|siro/, 'syrup bottle'], [/\bda\b|da vien/, 'ice cubes'], [/ly nhua|coc nhua/, 'plastic cup'],
  [/ong hut/, 'drinking straw'], [/dao/, 'peach'], [/cam/, 'orange'], [/chanh/, 'lemon'], [/bo\b/, 'avocado'],
];
function queryFor(name, kind) {
  const n = slugify(name).replace(/-/g, ' ');
  const hit = VI_EN.find(([re]) => re.test(n));
  const base = hit ? hit[1] : name;
  return kind === 'products' ? `${base} drink cafe` : `${base} ingredient`;
}

/** First Pexels photo for the query, as a square SIZE x SIZE URL, or null. */
async function searchPexels(query) {
  const { data } = await axios.get('https://api.pexels.com/v1/search', {
    params: { query, per_page: 5, orientation: 'square', size: 'small' },
    headers: { Authorization: PEXELS_API_KEY },
    timeout: 15000,
  });
  const photo = (data.photos || [])[0];
  if (!photo) return null;
  // Pexels images are served by an imgix-style CDN: ask it for a compressed square crop.
  const url = `${photo.src.original}?auto=compress&cs=tinysrgb&fit=crop&w=${SIZE}&h=${SIZE}`;
  return { url, credit: `${photo.photographer} (${photo.url})` };
}

/** Stream the image to disk safely: <file>.part first, renamed only when complete and non-trivial. */
/** Download the image into memory (Pexels sends ~30-80 KB at 400px); the size/type check happens in imageStore. */
async function download(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 5 * 1024 * 1024 });
  const type = String(res.headers['content-type'] || '');
  if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no content-type'})`);
  return Buffer.from(res.data);
}

const SOURCES = {
  products: { table: 'products', folder: 'products' },
  ingredients: { table: 'inventory_items', folder: 'ingredients' },
};

async function rowsMissing(kind) {
  const { table } = SOURCES[kind];
  // '' = photo removed in the admin on purpose: only NULL (never set) is missing.
  const where = has('force') ? 'is_active = 1' : 'is_active = 1 AND image_url IS NULL';
  const [rows] = await pool.query(`SELECT id, name, image_url FROM ${table} WHERE ${where} ORDER BY id`);
  return rows;
}

async function main() {
  if (!has('dry-run') && (!PEXELS_API_KEY || PEXELS_API_KEY.startsWith('['))) {
    console.error('Set PEXELS_API_KEY (free key at https://www.pexels.com/api/) — or use --dry-run to preview.');
    process.exitCode = 1;
    return;
  }
  await ensureSchemaUpgrades();                         // image_url columns on older databases

  const only = val('only');
  const kinds = only ? [only] : ['products', 'ingredients'];
  if (kinds.some((k) => !SOURCES[k])) throw new Error('--only must be "products" or "ingredients"');
  const limit = Number(val('limit')) || Infinity;

  const stats = { ok: 0, notFound: 0, failed: 0 };
  let done = 0;
  for (const kind of kinds) {
    const rows = await rowsMissing(kind);
    console.log(`\n${kind}: ${rows.length} without a photo`);
    for (const row of rows) {
      if (done >= limit) break;
      done += 1;
      const query = queryFor(row.name, kind);
      try {
        if (has('dry-run')) {
          console.log(`  [dry-run] #${row.id} ${row.name} -> "${query}"`);
        } else {
          const hit = await searchPexels(query);
          if (!hit) {
            stats.notFound += 1;
            console.log(`  -  #${row.id} ${row.name}: no photo for "${query}"`);
          } else {
            const publicUrl = await imageStore.saveBuffer(await download(hit.url), SOURCES[kind].folder, row.name);
            await pool.query(`UPDATE ${SOURCES[kind].table} SET image_url = ? WHERE id = ?`, [publicUrl, row.id]);
            if (row.image_url && row.image_url !== publicUrl) await imageStore.remove(row.image_url);   // --force: drop the replaced upload
            stats.ok += 1;
            console.log(`  ok #${row.id} ${row.name} -> ${publicUrl}  (photo: ${hit.credit})`);
          }
        }
      } catch (err) {
        stats.failed += 1;
        const why = err.response ? `HTTP ${err.response.status}` : err.message;
        console.log(`  !! #${row.id} ${row.name}: ${why}`);
        if (err.response && err.response.status === 429) { console.log('     rate limited: waiting 60s'); await sleep(60000); }
      }
      if (!has('dry-run')) await sleep(DELAY_MS);
    }
  }
  console.log(`\nDone: ${stats.ok} saved, ${stats.notFound} without result, ${stats.failed} failed.`);
}

main()
  .catch((err) => { console.error('sync_images failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
