/**
 * Entry point for Phusion Passenger (cPanel > Setup Node.js App > Application startup file: app.js).
 * Passenger injects the real socket into listen(), so there is no port to configure on the host.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');

const env = require('./src/config/env');
const { pool } = require('./src/config/db');
const logger = require('./src/utils/logger');
const routes = require('./src/routes');
const { notFound, errorHandler } = require('./src/middlewares/errorHandler');

const app = express();
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
app.use(express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'ignore', maxAge: '1h' }));

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

app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

// A failed background job (e.g. Zalo reply) must never take the whole POS down.
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason instanceof Error ? reason : { reason }));

// Under Passenger the global `PhusionPassenger` exists, app.js is require()d by its loader (so
// require.main !== module) and the listen() argument is ignored: Passenger injects its own socket.
// The PORT fallback only matters when you run `npm start` on your own machine.
const isPassenger = typeof PhusionPassenger !== 'undefined'; // eslint-disable-line no-undef
if (isPassenger || require.main === module) {
  app.listen(isPassenger ? 'passenger' : process.env.PORT || 3000, () => {
    if (!isPassenger) logger.info(`Dev server listening on :${process.env.PORT || 3000} (${env.nodeEnv})`);
  });
}

module.exports = app;
