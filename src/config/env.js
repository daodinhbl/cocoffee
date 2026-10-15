const path = require('path');
const crypto = require('crypto');
const { jwtSecretProblems } = require('./jwtSecretCheck');

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
  if (bool('REQUIRE_JWT_SECRET', false)) {
    const problems = jwtSecretProblems(explicit);
    if (problems.length) {
      const bar = '='.repeat(78);
      const list = problems.map((p) => `   - ${p}`).join('\n');
      console.error(`\n${bar}\n  FATAL: REQUIRE_JWT_SECRET is on and JWT_SECRET is not acceptable:\n${list}\n  Generate one:  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"\n${bar}\n`);
      process.exit(1);
    }
  }
  if (explicit) return explicit;
  if (optional('NODE_ENV', 'development') === 'production') {
    console.warn('[warn] JWT_SECRET is not set: the signing key is derived from DB_PASSWORD. Set JWT_SECRET (and REQUIRE_JWT_SECRET=1) so a leaked database password cannot forge tokens.');
  }
  return crypto.createHmac('sha256', required('DB_PASSWORD')).update('cocoffee-fnb:jwt:v1').digest('hex');
};

module.exports = {
  nodeEnv: optional('NODE_ENV', 'development'),
  rootDir: path.resolve(__dirname, '../..'),
  publicBaseUrl: optional('PUBLIC_BASE_URL').replace(/\/+$/, ''),
  // iOS app for staff iPhones/iPads: TestFlight public link or App Store page, used while nothing is set in
  // Web Admin > Cài đặt > Ứng dụng iOS (see services/iosApp.js).
  iosAppUrl: optional('IOS_APP_URL'),
  // Where Web Admin > Sao lưu keeps its .sql.gz files. A redeploy replaces the app folder, so the default is a
  // sibling folder OUTSIDE it (<app>/../cocoffee-backups); backupService falls back to <app>/backups (with a
  // warning) when that folder cannot be created. Set BACKUP_DIR to choose another place.
  backupDir: path.resolve(optional('BACKUP_DIR', path.resolve(__dirname, '../../../cocoffee-backups'))),
  backupDirFallback: path.resolve(__dirname, '../../backups'),

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
    // 'platform': official Zalo Bot Platform (ZALO_BOT_TOKEN; Zalo calls our webhook, we answer with sendMessage).
    // 'bot': personal account driven by an external Bot Client that POSTs messages and relays our replies.
    // 'oa': legacy Official Account. Default: 'platform' when ZALO_BOT_TOKEN is set, otherwise 'bot'.
    mode: ['platform', 'bot', 'oa'].includes(optional('ZALO_MODE')) ? optional('ZALO_MODE') : (optional('ZALO_BOT_TOKEN') ? 'platform' : 'bot'),
    botToken: optional('ZALO_BOT_TOKEN'),
    // platform: the secret_token given to setWebhook (8-256 chars, sent back in X-Bot-Api-Secret-Token);
    // bot: the Bearer token of the Bot Client.
    botWebhookSecret: optional('BOT_WEBHOOK_SECRET'),
    // legacy OA settings (ZALO_MODE=oa only)
    appId: optional('ZALO_APP_ID'),
    oaSecretKey: optional('ZALO_OA_SECRET_KEY'),
    appSecretKey: optional('ZALO_APP_SECRET_KEY'),
    bootstrapRefreshToken: optional('ZALO_BOOTSTRAP_REFRESH_TOKEN'),
    verifySignature: bool('ZALO_VERIFY_SIGNATURE', true),
    draftTtlMinutes: int('ZALO_DRAFT_TTL_MINUTES', 30),
    apiBase: 'https://openapi.zalo.me',
    oauthUrl: 'https://oauth.zaloapp.com/v4/oa/access_token',
  },

  // PayOn (NextPay) QR payments: every value can also be entered in Web Admin > Cài đặt; the environment wins.
  payon: {
    env: optional('PAYON_ENV'),                    // 'sandbox' | 'production'
    appId: optional('PAYON_APP_ID'),
    merchantId: optional('PAYON_MERCHANT_ID'),
    authUser: optional('PAYON_AUTH_USER'),
    authPass: optional('PAYON_AUTH_PASS'),
    secretKey: optional('PAYON_SECRET_KEY'),
  },

  // "Liên hệ" block of the public introduction page (/gioi-thieu). Public details, overridable per site; a blank value hides its row.
  contact: {
    name: optional('CONTACT_NAME', 'Cò Coffee'),
    address: optional('CONTACT_ADDRESS', 'TDP 20, phường 2, Bảo Lộc'),
    phone: optional('CONTACT_PHONE', '0383 966 336'),
    email: optional('CONTACT_EMAIL', 'dinhxuandaodc.435@gmail.com'),
    zalo: optional('CONTACT_ZALO'),
    hours: optional('CONTACT_HOURS'),
  },

  business: {
    allowNegativeStock: bool('ALLOW_NEGATIVE_STOCK', false),
    // Largest discount (% of the order subtotal) a cashier may give; an admin has no limit.
    maxCashierDiscountPct: Math.min(100, Math.max(0, int('MAX_CASHIER_DISCOUNT_PCT', 20))),
    shopName: optional('SHOP_NAME', 'CoCoffee'),
    paymentNote: optional('SHOP_PAYMENT_NOTE'),
    address: optional('SHOP_ADDRESS'),
    phone: optional('SHOP_PHONE'),
    // Shown in the "Liên hệ" block of the public introduction page (/gioi-thieu); blank entries are hidden.
    email: optional('SHOP_EMAIL'),
    zalo: optional('SHOP_ZALO'),
    hours: optional('SHOP_HOURS'),
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
