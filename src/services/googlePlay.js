const env = require('../config/env');

/**
 * The app's Google Play page (package com.tasotek.fnb), shown as a QR card on the login page (views/login.ejs) and
 * served as an SVG at /download/play/qr.svg (routes/downloadRoutes.js). While the app is in Play testing only the
 * invited testers' Google accounts can install from it.
 * GOOGLE_PLAY_URL in the environment may replace it (e.g. the testers' opt-in link), but only with an https
 * play.google.com address: the login page must never become a link to somewhere else.
 */
const PACKAGE_NAME = 'com.tasotek.fnb';
const DEFAULT_URL = `https://play.google.com/store/apps/details?id=${PACKAGE_NAME}`;

function safeUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (u.protocol === 'https:' && !u.username && !u.password && u.hostname.toLowerCase() === 'play.google.com' && u.href.length <= 200) return u.href;
  } catch (_) { /* fall through */ }
  return null;
}

const url = () => safeUrl(env.googlePlayUrl) || DEFAULT_URL;

/** What the login page needs. */
const card = () => ({ url: url(), appIcon: '/brand/co-coffee.png', packageName: PACKAGE_NAME });

module.exports = { url, card, safeUrl, DEFAULT_URL };
