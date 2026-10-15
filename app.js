/**
 * Entry point (startup file: app.js). Works under Phusion Passenger / LiteSpeed (socket injected into
 * listen(), no port to configure) and as a plain `node app.js` (PORT from the environment).
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');

const env = require('./src/config/env');
const { pool } = require('./src/config/db');
const { bootstrapIfEmpty, ensureDemoAccount, ensureSchemaUpgrades } = require('./src/config/bootstrapDb');
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

// JSON for Zalo webhooks + POS API. `verify` keeps the untouched body string: the
// X-ZEvent-Signature hash is computed over the raw bytes, not over re-serialized JSON.
app.use(express.json({
  limit: '1mb',
  type: ['application/json', 'application/*+json', 'text/json'],
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

// Express 5 leaves req.body undefined when there is no body; controllers expect an object.
app.use((req, _res, next) => { if (req.body === undefined) req.body = {}; next(); });

// Photos uploaded from the admin (stored in MySQL, see services/imageStore.js).
app.use('/media', mediaRoutes);

// Static files: receipt images served to Zalo + Zalo domain-verification file (drop it into /public).
app.use(express.static(path.join(__dirname, 'public'), { index: false, redirect: false, dotfiles: 'ignore', maxAge: '1h' }));

// The domain root is what people type: send them to the Web Admin (it redirects to login when signed out).
// Machine checks use /health.
app.get('/', (_req, res) => res.redirect(302, '/admin/dashboard'));
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch (err) {
    logger.error('Health check: database down', err);
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

// Android app for staff phones: landing page, APK, manifest, QR code (public; see routes/downloadRoutes.js).
app.use('/download', downloadRoutes);

// Product introduction page (public; linked from the login page "Xem thêm").
app.get('/gioi-thieu', adminSecurity, (_req, res) => res.render('landing', { shopName: env.business.shopName, appDownload: appRelease.loginCard() }));

// Privacy policy (public; store listings such as APKPure ask for its URL).
app.get('/privacy', (_req, res) => res.render('privacy', { shopName: env.business.shopName, phone: env.business.phone, address: env.business.address }));

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
  const bootstrap = await bootstrapIfEmpty();           // never throws; logs its own outcome
  if (bootstrap === 'applied') productModel.invalidateCatalog();
  await ensureSchemaUpgrades();                         // additive tables for older databases; never throws
  await ensureMenuSeed();                               // printed menu, once per database; never throws
  await ensureMenuAliases();                            // how customers really order it ("đen đá", "cf muối"), once; never throws
  await ensureMenuPhotos();                             // shipped public/menu photos for items without one; never throws
  await ensureDemoAccount();                            // DEMO_MODE only; never throws
  backupService.startScheduler();                       // automatic database backups (Admin > Sao lưu); never throws
  webhookGuard.ensure().catch(() => {});                // Zalo Bot Platform: re-register the webhook when its URL / secret changed; never throws, not awaited
  payonService.startRecovery();                         // PayOn: finishes claims a dead process left half-applied; never throws

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
