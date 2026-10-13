/**
 * Entry point (startup file: app.js). Works under Phusion Passenger / LiteSpeed (socket injected into
 * listen(), no port to configure) and as a plain `node app.js` (PORT from the environment).
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');

const env = require('./src/config/env');
const { pool } = require('./src/config/db');
const { bootstrapIfEmpty } = require('./src/config/bootstrapDb');
const productModel = require('./src/models/productModel');
const logger = require('./src/utils/logger');
const routes = require('./src/routes');
const adminRoutes = require('./src/routes/adminRoutes');
const viewHelpers = require('./src/utils/viewHelpers');
const { notFound, errorHandler } = require('./src/middlewares/errorHandler');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.icon = viewHelpers.icon;
app.locals.money = viewHelpers.money;
app.locals.pct = viewHelpers.pct;
app.locals.marginTone = viewHelpers.marginTone;
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

// Static files: receipt images served to Zalo + Zalo domain-verification file (drop it into /public).
app.use(express.static(path.join(__dirname, 'public'), { index: false, redirect: false, dotfiles: 'ignore', maxAge: '1h' }));

app.get('/', (_req, res) => res.json({ service: 'cocoffee-fnb', status: 'ok' }));
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch (err) {
    logger.error('Health check: database down', err);
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

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

  const isPassenger = typeof PhusionPassenger !== 'undefined'; // eslint-disable-line no-undef
  const port = process.env.PORT || 3000;
  app.listen(isPassenger ? 'passenger' : port, () => {
    logger.info(`CoCoffee API up (${env.nodeEnv}, ${isPassenger ? 'passenger' : `port ${port}`}, bootstrap=${bootstrap})`);
  });
}

if (!process.env.FNB_NO_LISTEN) {
  start().catch((err) => { logger.error('Startup failed', err); process.exit(1); });
}

module.exports = app;
