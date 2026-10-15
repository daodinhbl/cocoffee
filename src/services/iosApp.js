const env = require('../config/env');
const logger = require('../utils/logger');
const settingsModel = require('../models/settingsModel');
const { AppError } = require('../utils/httpError');

/**
 * Where iPhone/iPad users get the app: /download/ios and the iOS row of the app card on the login page
 * (routes/downloadRoutes.js, views/download-ios.ejs, views/login.ejs).
 *
 * iOS has no sideloading, so the server does not host a file the way /download hosts the APK: it points at the
 * TestFlight public link (beta builds, up to 10 000 testers, no device registration) or, once Apple has approved
 * the app, at its App Store page. The link is pasted in Web Admin > Cài đặt > "Ứng dụng iOS" and stored in
 * app_settings under "ios.app_url"; IOS_APP_URL in the environment is the fallback while nothing is stored.
 * Only https links on Apple's own hosts are accepted, so a compromised admin account cannot turn the login page
 * into a link to somewhere else. Cached for a minute: the login page must not cost a database query per visit.
 */
const KEY = 'ios.app_url';
const CACHE_MS = 60 * 1000;
// Mirrors the Flutter iOS target (mobile/ios/Runner/Info.plist, .github/workflows/ios-testflight.yml); the deploy
// archive carries no mobile/ sources to read these from.
const APP = { name: 'POS Tasotek', bundleId: 'com.tasotek.fnb', minIos: '15.0' };
const KINDS = [
  { kind: 'testflight', hosts: ['testflight.apple.com', 'beta.itunes.apple.com'], label: 'TestFlight', action: 'Mở trong TestFlight' },
  { kind: 'appstore', hosts: ['apps.apple.com', 'itunes.apple.com'], label: 'App Store', action: 'Tải trên App Store' },
];

let cache = null;   // { at, link }

/** { kind, label, action, url } for an https TestFlight / App Store link, or null for anything else. */
function classify(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 300) return null;
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const k = KINDS.find((x) => x.hosts.includes(u.hostname.toLowerCase()));
  return k ? { kind: k.kind, label: k.label, action: k.action, url: u.href } : null;
}

async function stored() {
  const raw = await settingsModel.getByPrefix(KEY);
  return typeof raw[KEY] === 'string' ? raw[KEY] : '';
}

/** The link in force (stored value, else IOS_APP_URL), or null while the iOS app is not available yet. */
async function get({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.link;
  let value;
  try {
    value = await stored();
  } catch (err) {
    logger.warn('iOS app link: app_settings unavailable, using the last known value', err);
    return cache ? cache.link : classify(env.iosAppUrl);
  }
  const link = classify(value) || classify(env.iosAppUrl);
  cache = { at: Date.now(), link };
  return link;
}

/** For the settings page: what is stored (the form value), what is in force, and the app's identity. */
async function view() {
  const url = await stored().catch(() => '');
  return { url, link: await get({ fresh: true }), fallback: classify(env.iosAppUrl), app: APP };
}

/** Save the admin form. An empty value clears the link (the IOS_APP_URL fallback, if any, applies again). */
async function save(body, userId) {
  const raw = typeof body.url === 'string' ? body.url.trim() : '';
  const link = classify(raw);
  if (raw && !link) throw new AppError(400, 'VALIDATION', 'Liên kết phải là địa chỉ https của TestFlight (testflight.apple.com/join/…) hoặc App Store (apps.apple.com/…).');
  await settingsModel.setMany({ [KEY]: link ? link.url : '' }, userId);
  cache = null;
  return link;
}

/** Tests only: forget the cached link. */
const invalidate = () => { cache = null; };

module.exports = { APP, KEY, classify, get, view, save, invalidate };
