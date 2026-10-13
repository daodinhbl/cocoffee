const path = require('path');

// Local dev reads .env; on cPanel the same keys come from "Setup Node.js App" environment variables.
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

module.exports = {
  nodeEnv: optional('NODE_ENV', 'development'),
  rootDir: path.resolve(__dirname, '../..'),
  publicBaseUrl: optional('PUBLIC_BASE_URL').replace(/\/+$/, ''),

  db: {
    host: optional('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3306),
    name: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    poolLimit: int('DB_POOL_LIMIT', 5),
    timezone: optional('DB_TIMEZONE', '+07:00'),
  },

  jwt: {
    secret: required('JWT_SECRET'),
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
  },

  receiptImage: {
    enabled: bool('RECEIPT_IMAGE_ENABLED', false),
    fontPath: path.resolve(path.resolve(__dirname, '../..'), optional('RECEIPT_FONT_PATH', 'assets/fonts/Roboto-Regular.ttf')),
  },
};
