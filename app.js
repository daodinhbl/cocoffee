/**
 * Entry point (startup file: app.js). Works under Phusion Passenger / LiteSpeed (socket injected into
 * listen(), no port to configure) and as a plain `node app.js` (PORT from the environment).
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');

const env = require('./src/config/env');
const { pool } = require('./src/config/db');
const { bootstrapIfEmpty, ensureDemoAccount, ensureSchemaUpgrades, ensureFirstAdmin } = require('./src/config/bootstrapDb');
const { ensureMenuSeed, ensureMenuAliases } = require('./src/config/menuSeed');
const { ensureMenuPhotos } = require('./src/config/menuPhotos');
const productModel = require('./src/models/productModel');
const backupService = require('./src/services/backupService');
const webhookGuard = require('./src/services/zalo/webhookGuard');
const payonService = require('./src/services/payon/payonService');
const logger = require('./src/utils/logger');
const routes = require('./src/routes');
const adminRoutes = require('./src/routes/adminRoutes');
const mediaRoutes = require('./src/routes/mediaRoutes');
const downloadRoutes = require('./src/routes/downloadRoutes');
const kyThuatRoutes = require('./src/routes/kyThuatRoutes');
const signupRoutes = require('./src/routes/signupRoutes');
const accountDeletionRoutes = require('./src/routes/accountDeletionRoutes');
const installRoutes = require('./src/routes/installRoutes');
const { installGate } = require('./src/middlewares/installGate');
const { tenantResolver } = require('./src/middlewares/tenant');
const viewHelpers = require('./src/utils/viewHelpers');
const { adminSecurity } = require('./src/middlewares/adminSecurity');
const appRelease = require('./src/services/appRelease');
const { notFound, errorHandler } = require('./src/middlewares/errorHandler');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
Object.assign(app.locals, viewHelpers);          // icon, money, pct, num, badge, ui, safeJson, ... available in every template
app.disable('x-powered-by');
app.set('trust proxy', 1);                     // Apache/LiteSpeed in front of Passenger
app.use(helmet());

// Multi-shop mode (TENANT_BASE_DOMAIN set): <slug>.<base domain> runs inside that shop's own database. Otherwise a no-op.
app.use(tenantResolver);

// JSON for Zalo webhooks + POS API. `verify` keeps the untouched body string: the
// X-ZEvent-Signature hash is computed over the raw bytes, not over re-serialized JSON.
app.use(express.json({
  limit: '1mb',
  type: ['application/json', 'application/*+json', 'text/json'],
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

// Express 5 leaves req.body undefined when there is no body; controllers expect an object.
app.use((req, _res, next) => { if (req.body === undefined) req.body = {}; next(); });

// First-run setup: while the database has no account, everything but /cai-dat, /health and the static assets leads there.
app.use(installGate);
app.use('/cai-dat', installRoutes);

// Photos uploaded from the admin (stored in MySQL, see services/imageStore.js).
app.use('/media', mediaRoutes);

// Static files: receipt images served to Zalo + Zalo domain-verification file (drop it into /public).
app.use(express.static(path.join(__dirname, 'public'), { index: false, redirect: false, dotfiles: 'ignore', maxAge: '1h' }));

// The domain root is what people type: send them to the Web Admin (it redirects to login when signed out).
// Machine checks use /health.
// On the sign-up platform (TENANT_BASE_DOMAIN set) the main host's front door is the shop sign-up page.
app.get('/', (req, res) => res.redirect(302, require('./src/services/tenantService').enabled() && !req.tenant ? '/dang-ky' : '/admin/dashboard'));
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch (err) {
    logger.error('Health check: database down', err);
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

// Apps for staff phones (public; see routes/downloadRoutes.js): Android landing page, APK, manifest and QR code;
// iOS landing page (/download/ios -> TestFlight / App Store link) and its QR code.
app.use('/download', downloadRoutes);

// Shop sign-up (main site only; needs TENANT_BASE_DOMAIN): /dang-ky.
app.use('/dang-ky', signupRoutes);

// Account deletion (public; its URL is declared in the Google Play Console): explains the in-app path and takes requests.
app.use('/xoa-tai-khoan', accountDeletionRoutes);

// Technical-service QR page (public): finished jobs + request form; printed QR codes point here (routes/kyThuatRoutes.js).
app.use('/ky-thuat', kyThuatRoutes);

// Product introduction page (public; linked from the login page "Xem thêm").
app.get('/gioi-thieu', adminSecurity, (_req, res) => res.render('landing', { shopName: env.business.shopName, appDownload: appRelease.loginCard(), contact: env.contact }));

// Privacy policy (public; store listings such as APKPure ask for its URL).
app.get('/privacy', (_req, res) => res.render('privacy', { shopName: env.business.shopName, phone: env.business.phone, address: env.business.address, contact: env.contact }));
// POS Tasotek (com.tasotek.fnb) privacy policy for the Google Play listing (public).
app.get('/private', (_req, res) => res.render('private', { contact: env.contact }));

app.use('/admin', adminRoutes);
app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

// A failed background job (e.g. Zalo reply) must never take the whole POS down.
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason instanceof Error ? reason : { reason }));

// Startup. Whichever loader the host uses (Passenger, LiteSpeed lsnode, or a plain `node app.js` with a
// PORT variable) the app must listen exactly once, so the only opt-out is the explicit test flag.
//  - Passenger: the global `PhusionPassenger` exists and listen()'s argument is ignored (socket injected).
//  - Otherwise: PORT from the host's environment; 3000 only matters for `npm start` on your own machine.
async function start() {
  // SKIP_BOOT_TASKS=true: run the UI on your own machine against a live database without any of the write-y boot
  // steps below (schema/menu/photos/backups, Zalo webhook re-registration, PayOn recovery).
  const skipBoot = /^(1|true|yes)$/i.test(process.env.SKIP_BOOT_TASKS || '');
  await require('./src/services/publicUrl').load();       // address saved in Cài đặt (wins over PUBLIC_BASE_URL); read-only, never throws
  require('./src/services/publicUrl').startRefresh();
  await require('./src/services/heli/heliConfig').load();   // ChatGPT key / model saved in Cài đặt (wins over OPENAI_*); read-only, never throws
  require('./src/services/heli/heliConfig').startRefresh();
  await require('./src/services/demoState').load();      // demo switch kept in the database (scripts/demo-mode.js), read-only; never throws
  require('./src/services/demoState').startRefresh();
  await require('./src/services/shopProfile').apply();   // shop name / address / phone saved in Cài đặt (read-only; also with SKIP_BOOT_TASKS)
  let bootstrap = 'skipped';
  if (!skipBoot) {
    bootstrap = await bootstrapIfEmpty();               // never throws; logs its own outcome
    if (bootstrap === 'applied') productModel.invalidateCatalog();
    await ensureSchemaUpgrades();                       // additive tables for older databases; never throws
    if (require('./src/services/tenantService').enabled()) await require('./src/models/tenantModel').ensureMasterSchema().catch((err) => logger.error('Tenant registry tables failed', err));   // shops + their databases (main DB only)
    await ensureDemoAccount();                          // DEMO_MODE only; never throws
    await ensureFirstAdmin();                           // empty users table + BOOTSTRAP_ADMIN_PASSWORD: the first admin account; never throws
    if (env.db.seedMenu && await require('./src/services/installService').isInstalled()) {   // before the setup wizard has run, the owner still chooses blank or sample data
    await ensureMenuSeed();                             // printed menu, once per database; never throws
    await ensureMenuAliases();                          // how customers really order it ("đen đá", "cf muối"), once; never throws
    await ensureMenuPhotos();                           // shipped public/menu photos for items without one; never throws
    }
    require('./src/services/taxExportService').startWorker();   // builds the tax books queued from the web / app, one at a time
    require('./src/services/rollupService').startScheduler();   // 02:30 rebuild of the last days' revenue / expense rollups (fallback to the hPanel cron job)
    require('./src/services/backupMailService').startScheduler();   // 02:00 database backup by e-mail (needs SMTP_*); never throws
    require('./src/services/cloudSyncService').startScheduler();   // local box -> Hostinger copy (CLOUD_SYNC_ENABLED); never throws
    backupService.startScheduler();                     // automatic database backups (Admin > Sao lưu); never throws
    webhookGuard.ensure().catch(() => {});              // Zalo Bot Platform: re-register the webhook when its URL / secret changed; never throws, not awaited
    payonService.startRecovery();                       // PayOn: finishes claims a dead process left half-applied; never throws
    require('./src/services/accountDeletion').startScheduler();   // purges shops whose owner asked for deletion, after the grace period; never throws
  }

  const isPassenger = typeof PhusionPassenger !== 'undefined'; // eslint-disable-line no-undef
  const port = process.env.PORT || 3000;
  app.listen(isPassenger ? 'passenger' : port, (err) => {
    if (err) { logger.error('Startup failed: could not listen', err); process.exit(1); }   // Express 5 passes listen errors here
    logger.info(`CoCoffee API up (${env.nodeEnv}, ${isPassenger ? 'passenger' : `port ${port}`}, bootstrap=${bootstrap})`);
  });
}

if (!process.env.FNB_NO_LISTEN) {
  start().catch((err) => { logger.error('Startup failed', err); process.exit(1); });
}

module.exports = app;
