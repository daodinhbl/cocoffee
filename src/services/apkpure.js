const fs = require('fs');
const path = require('path');
const env = require('../config/env');

/**
 * The app's public page on APKPure (Google Play package com.tasotek.fnb), shown as a QR card on the login page
 * (views/login.ejs) and served as an SVG at /download/apkpure/qr.svg (routes/downloadRoutes.js).
 * APKPURE_URL in the environment may replace it, but only with an https apkpure.com address: the login page must
 * never become a link to somewhere else.
 *
 * The APKPure logo is the owner's to supply (trademark; the site blocks automated downloads): drop it in
 * public/brand/apkpure.svg (or .png) and the card shows it, until then the card shows the name as text.
 */
const DEFAULT_URL = 'https://apkpure.com/p/com.tasotek.fnb';
const LOGOS = ['apkpure.svg', 'apkpure.png'];

function safeUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && !u.username && !u.password && (host === 'apkpure.com' || host === 'www.apkpure.com') && u.href.length <= 200) return u.href;
  } catch (_) { /* fall through */ }
  return null;
}

const url = () => safeUrl(env.apkpureUrl) || DEFAULT_URL;

/** Public path of the APKPure logo file, or null while none was dropped into public/brand/. */
function logo() {
  const dir = path.join(env.rootDir, 'public', 'brand');
  const f = LOGOS.find((name) => fs.existsSync(path.join(dir, name)));
  return f ? `/brand/${f}` : null;
}

/** What the login page needs. */
const card = () => ({ url: url(), logo: logo(), appIcon: '/brand/co-coffee.png', packageName: 'com.tasotek.fnb' });

module.exports = { url, logo, card, safeUrl, DEFAULT_URL };
