const path = require('path');
const crypto = require('crypto');

// Local dev reads .env; on Hostinger the same keys come from the app's environment variables.
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const required = (key) => {
  const value = process.env[key];
  if (value === undefined || value === '') throw new Error(`Missing required environment variable: ${key}`);
  return value;
};
const optional = (key, fallback = '') => (process.env[key] === undefined || process.env[key] === '' ? fallback : process.env[key]);
const bool = (key, fallback = false) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const int = (key, fallback) => {
  const n = parseInt(process.env[key], 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * JWT signing key. An explicit JWT_SECRET always wins. When it is not set (e.g. Hostinger's
 * "Setup website database" injects a platform-generated DB_PASSWORD that nobody ever sees) the key is
 * derived from DB_PASSWORD with HMAC-SHA256 under a fixed context label, so no human-chosen or
 * pasted secret is needed. Rotating the DB password therefore also invalidates issued tokens.
 */
const jwtSecret = () => {
  const explicit = optional('JWT_SECRET');
  if (explicit) return explicit;
  return crypto.createHmac('sha256', required('DB_PASSWORD')).update('cocoffee-fnb:jwt:v1').digest('hex');
};

module.exports = {
  nodeEnv: optional('NODE_ENV', 'development'),
  rootDir: path.resolve(__dirname, '../..'),
  publicBaseUrl: optional('PUBLIC_BASE_URL').replace(/\/+$/, ''),

  db: {
    // Hostinger writes DB_HOST=localhost, which Node may resolve to ::1 (no grant there): force IPv4 loopback.
    host: optional('DB_HOST', '127.0.0.1') === 'localhost' ? '127.0.0.1' : optional('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3306),
    name: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    poolLimit: int('DB_POOL_LIMIT', 5),
    timezone: optional('DB_TIMEZONE', '+07:00'),
    // First-boot setup for hosts without SQL import (see src/config/bootstrapDb.js). Both default off.
    autoBootstrap: bool('AUTO_BOOTSTRAP_DB', false),
    seedDemo: bool('SEED_DEMO', false),
    // Replaces the factory admin/admin password during the first-boot seed, so a public site is never
    // reachable with a known password. Only read while bootstrapping an EMPTY database; remove it afterwards.
    bootstrapAdminPassword: optional('BOOTSTRAP_ADMIN_PASSWORD'),
  },

  // Public demo: the login page shows these credentials, the account is (re)set to them at startup and
  // cannot be locked, renamed away from its password or forced to change it. Anyone can sign in: demo data only.
  demo: {
    enabled: bool('DEMO_MODE', false),
    username: optional('DEMO_USERNAME', 'admin'),
    password: optional('DEMO_PASSWORD', 'admin'),
  },

  jwt: {
    secret: jwtSecret(),
    expiresIn: optional('JWT_EXPIRES_IN', '12h'),
  },

  zalo: {
    appId: optional('ZALO_APP_ID'),
    oaSecretKey: optional('ZALO_OA_SECRET_KEY'),
    appSecretKey: optional('ZALO_APP_SECRET_KEY'),
    bootstrapRefreshToken: optional('ZALO_BOOTSTRAP_REFRESH_TOKEN'),
    verifySignature: bool('ZALO_VERIFY_SIGNATURE', true),
    draftTtlMinutes: int('ZALO_DRAFT_TTL_MINUTES', 30),
    apiBase: 'https://openapi.zalo.me',
    oauthUrl: 'https://oauth.zaloapp.com/v4/oa/access_token',
  },

  business: {
    allowNegativeStock: bool('ALLOW_NEGATIVE_STOCK', false),
    shopName: optional('SHOP_NAME', 'CoCoffee'),
    paymentNote: optional('SHOP_PAYMENT_NOTE'),
    address: optional('SHOP_ADDRESS'),
    phone: optional('SHOP_PHONE'),
  },

  // Printed receipt (thermal printer). 80mm paper prints ~72mm wide; 58mm prints ~48mm.
  receiptPaper: {
    widthMm: [58, 80].includes(int('RECEIPT_PAPER_MM', 80)) ? int('RECEIPT_PAPER_MM', 80) : 80,
  },

  receiptImage: {
    enabled: bool('RECEIPT_IMAGE_ENABLED', false),
    fontPath: path.resolve(path.resolve(__dirname, '../..'), optional('RECEIPT_FONT_PATH', 'assets/fonts/Roboto-Regular.ttf')),
  },
};
