const express = require('express');
const { adminSecurity } = require('../middlewares/adminSecurity');
const rateLimit = require('../middlewares/rateLimit');
const appRelease = require('../services/appRelease');
const iosApp = require('../services/iosApp');
const apkpure = require('../services/apkpure');
const iosRelease = require('../services/iosRelease');
const windowsRelease = require('../services/windowsRelease');
const env = require('../config/env');
const { formatShopTime } = require('../utils/text');

/**
 * Public download point for the Android app (no sign-in: staff open it on their phone from the QR code on the
 * login page). The APK and its manifest live in releases/android/ (see services/appRelease.js).
 *   GET /download                landing page: version, size, install steps, the QR code to share
 *   GET /download/cocoffee.apk   the APK (stable URL; the saved file name carries the version)
 *   GET /download/manifest.json  version/size/sha256 for an in-app update check
 *   GET /download/qr.svg         QR code of the landing page URL (printed on the login page)
 *
 * The iOS app cannot be sideloaded by the public, so its page links out (services/iosApp.js) and, for registered test
 * devices, offers the ad-hoc build in releases/ios/ over the air (services/iosRelease.js):
 *   GET /download/ios                landing page for iPhone/iPad: direct install when a build is published, else the link
 *   GET /download/ios/qr.svg         QR code of that page (the iOS row of the login page while no link is set)
 *   GET /download/ios/app-qr.svg     QR code of the TestFlight / App Store link (the iOS row once the link is set)
 *   GET /download/ios/manifest.plist what Apple's installer reads (itms-services); names the .ipa URL
 *   GET /download/ios/app.ipa        the ad-hoc build (stable URL; the saved file name carries the version)
 */
const router = express.Router();
const APK_PATH = '/download/cocoffee.apk';
// Public and unauthenticated: the 60 MB file is the expensive one (a download manager resumes with a few Range requests).
const pageLimit = rateLimit({ windowMs: 60 * 1000, max: 120 });
const apkLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });
const ipaLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

const describe = (req, r) => ({
  ...r,
  downloadName: appRelease.downloadName(r),
  sizeLabel: appRelease.sizeLabel(r.size),
  android: appRelease.androidLabel(r.min_sdk),
  apkUrl: `${APK_PATH}?v=${r.sha256.slice(0, 12)}`,     // a new build gets a new URL: no stale browser cache
  builtAtLabel: formatShopTime(r.built_at),
});

router.get('/', pageLimit, adminSecurity, (req, res) => {
  const release = appRelease.current();
  const base = appRelease.baseUrl(req);
  res.render('download', {
    shopName: env.business.shopName,
    release: release ? describe(req, release) : null,
    pageUrl: `${base}/download`,
    host: base.replace(/^https?:\/\//, ''),
  });
});

router.get('/manifest.json', pageLimit, (req, res) => {
  const r = appRelease.current();
  if (!r) return res.status(404).json({ error: { code: 'NO_RELEASE', message: 'Chưa có bản cài đặt nào.' } });
  const base = appRelease.baseUrl(req);
  res.set('Cache-Control', 'no-cache');
  return res.json({
    app_name: r.app_name,
    package: r.package,
    version_name: r.version_name,
    version_code: r.version_code,
    min_sdk: r.min_sdk,
    size: r.size,
    sha256: r.sha256,
    built_at: r.built_at,
    file: appRelease.downloadName(r),
    url: `${base}${APK_PATH}`,
    page: `${base}/download`,
  });
});

router.get('/cocoffee.apk', apkLimit, (req, res, next) => {
  const r = appRelease.current();
  if (!r) return res.status(404).type('text').send('Chưa có bản cài đặt nào.');
  res.set({ 'Cache-Control': 'no-cache', 'X-Checksum-SHA256': r.sha256, 'X-Content-Type-Options': 'nosniff' });
  // send() keeps a Content-Type that is already set, handles HEAD, Range and conditional requests.
  return res.download(r.path, appRelease.downloadName(r), { headers: { 'Content-Type': appRelease.APK_MIME }, cacheControl: false, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) next(err);
  });
});

/** QR code (SVG) pointing at `pagePath` on the public origin. */
async function sendQr(req, res, next, pagePath) {
  try {
    const svg = await appRelease.qrSvg(`${appRelease.baseUrl(req)}${pagePath}`);
    res.set({
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.send(svg);
  } catch (err) { next(err); }
}

router.get('/qr.svg', pageLimit, (req, res, next) => sendQr(req, res, next, '/download'));

// QR code of the app's APKPure page (a third row of the app card on the login page).
router.get('/apkpure/qr.svg', pageLimit, async (req, res, next) => {
  try {
    const svg = await appRelease.qrSvg(apkpure.url());
    res.set({
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.send(svg);
  } catch (err) { next(err); }
});

router.get('/ios', pageLimit, adminSecurity, async (req, res, next) => {
  try {
    const base = appRelease.baseUrl(req);
    const release = iosRelease.current();
    res.render('download-ios', {
      shopName: env.business.shopName,
      app: await iosApp.get(),
      meta: iosApp.APP,
      release: release ? { ...release, downloadName: iosRelease.downloadName(release), sizeLabel: iosRelease.sizeLabel(release.size), builtAtLabel: formatShopTime(release.built_at) } : null,
      installUrl: release ? iosRelease.installUrl(base) : null,
      pageUrl: `${base}/download/ios`,
      host: base.replace(/^https?:\/\//, ''),
    });
  } catch (err) { next(err); }
});

router.get('/ios/qr.svg', pageLimit, (req, res, next) => sendQr(req, res, next, '/download/ios'));

// QR code of the TestFlight / App Store link itself (the iOS row of the login page once the link is set): one scan,
// straight into TestFlight. 404 while no link is set.
router.get('/ios/app-qr.svg', pageLimit, async (req, res, next) => {
  try {
    const link = await iosApp.get();
    if (!link) return res.status(404).type('text/plain').send('Not found');
    const svg = await appRelease.qrSvg(link.url);
    res.set({
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    return res.send(svg);
  } catch (err) { return next(err); }
});

// In-app update check of the ad-hoc iOS build (the Android twin is /manifest.json): the app compares version_name and, on
// "Cập nhật", opens install_url in Safari's installer (itms-services), which replaces the app in place.
router.get('/ios/manifest.json', pageLimit, (req, res) => {
  const r = iosRelease.current();
  if (!r) return res.status(404).json({ error: { code: 'NO_RELEASE', message: 'Chưa có bản cài đặt iOS nào.' } });
  const base = appRelease.baseUrl(req);
  res.set('Cache-Control', 'no-cache');
  return res.json({
    app_name: r.app_name,
    bundle_id: r.bundle_id,
    version_name: r.version_name,
    version_code: r.version_code,
    min_ios: r.min_ios,
    size: r.size,
    sha256: r.sha256,
    built_at: r.built_at,
    install_url: iosRelease.installUrl(base),
    page: `${base}/download/ios`,
  });
});

router.get('/ios/manifest.plist', pageLimit, (req, res) => {
  const r = iosRelease.current();
  if (!r) return res.status(404).type('text').send('Chưa có bản cài đặt iOS nào.');
  res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  return res.send(iosRelease.manifestPlist(r, appRelease.baseUrl(req)));
});

router.get('/ios/app.ipa', ipaLimit, (req, res, next) => {
  const r = iosRelease.current();
  if (!r) return res.status(404).type('text').send('Chưa có bản cài đặt iOS nào.');
  res.set({ 'Cache-Control': 'no-cache', 'X-Checksum-SHA256': r.sha256, 'X-Content-Type-Options': 'nosniff' });
  return res.download(r.path, iosRelease.downloadName(r), { headers: { 'Content-Type': iosRelease.IPA_MIME }, cacheControl: false, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) next(err);
  });
});

// What the Windows manager's updater reads: version, size, SHA-256 and the file name (the app rebuilds the URL from its own server address).
router.get('/windows/manifest.json', pageLimit, (_req, res) => {
  const r = windowsRelease.current();
  if (!r) return res.status(404).json({ error: { code: 'NO_RELEASE', message: 'Chưa có bản cài Windows.' } });
  res.set('Cache-Control', 'no-cache');
  return res.json({ app_name: 'POS Tasotek Server', version_name: r.version, file: r.file, size: r.size, sha256: r.sha256, built_at: r.builtAt.toISOString() });
});

// Windows installer: /download/windows/POS-Tasotek-Server-Setup-<version>.exe (only the file the folder holds is served).
router.get('/windows/:file', ipaLimit, (req, res, next) => {
  const r = windowsRelease.current();
  if (!r || req.params.file !== r.file) return res.status(404).type('text').send('Không có bản cài đặt Windows này.');
  res.set({ 'Cache-Control': 'no-cache', 'X-Checksum-SHA256': r.sha256, 'X-Content-Type-Options': 'nosniff' });
  return res.download(r.path, r.file, { headers: { 'Content-Type': windowsRelease.EXE_MIME }, cacheControl: false, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) next(err);
  });
});

router.use((_req, res) => res.status(404).type('text').send('Không tìm thấy.'));

module.exports = router;
