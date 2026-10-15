const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * The iOS build offered for direct ("over-the-air") installation at /download/ios, the way /download offers the APK.
 *
 * `releases/ios/` holds ONE .ipa plus the manifest.json that scripts/publish-ipa.js copies next to it (the GitHub
 * workflow writes both: bundle id, version, build number, size, SHA-256). Both are git-ignored build artifacts that
 * scripts/package-deploy.js adds to the deploy archive, so a deploy replaces them along with everything else.
 * Without a manifest the newest .ipa in the directory is described from its name (POS-Tasotek-1.4.0-12.ipa).
 *
 * Only an ad-hoc ("release-testing") signed build installs this way, and only on iPhones/iPads whose UDID was
 * registered in the Apple Developer portal before the build (at most 100 per year). Everyone else uses the
 * TestFlight / App Store link (services/iosApp.js). Apple installs through Safari: the page offers an
 * itms-services:// link that points at /download/ios/manifest.plist, which in turn names the .ipa URL; both must
 * be https on the public origin, hence baseUrl() from appRelease.
 */
const DIR = path.resolve(env.rootDir, process.env.IOS_RELEASE_DIR || 'releases/ios');
const MANIFEST = 'manifest.json';
const IPA_MIME = 'application/octet-stream';
const IPA_PATH = '/download/ios/app.ipa';
const PLIST_PATH = '/download/ios/manifest.plist';
const DEFAULTS = { app_name: 'POS Tasotek', bundle_id: 'com.tasotek.fnb', min_ios: '15.0' };

let warnedManifest = 0;
let cache = null;   // { key, release }

const statOrNull = (file) => { try { return fs.statSync(file); } catch (_) { return null; } };
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : '');
const int = (v) => (v !== '' && v !== null && v !== undefined && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
const validDate = (v) => { const d = new Date(v); return typeof v === 'string' && Number.isFinite(d.getTime()) ? d.toISOString() : null; };

function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/** "POS-Tasotek-1.4.0-12.ipa" -> { name: '1.4.0', code: 12 }; anything else -> { name: '', code: null }. */
function versionFromName(file) {
  const m = /-(\d+(?:\.\d+)+)(?:[-+](\d+))?\.ipa$/i.exec(file);
  return m ? { name: m[1], code: m[2] ? Number(m[2]) : null } : { name: '', code: null };
}

function newestIpa() {
  let entries;
  try { entries = fs.readdirSync(DIR); } catch (_) { return null; }
  const ipas = entries
    .filter((f) => /\.ipa$/i.test(f))
    .map((f) => ({ f, stat: statOrNull(path.join(DIR, f)) }))
    .filter((e) => e.stat && e.stat.isFile());
  ipas.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return ipas.length ? ipas[0].f : null;
}

function readManifest() {
  const file = path.join(DIR, MANIFEST);
  const stat = statOrNull(file);
  if (!stat) return { stat: null, data: null };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { stat, data: data && typeof data === 'object' && !Array.isArray(data) ? data : null };
  } catch (err) {
    if (warnedManifest !== stat.mtimeMs) {
      warnedManifest = stat.mtimeMs;
      logger.warn(`${MANIFEST} in ${DIR} is not valid JSON; describing the .ipa from the file instead`, err);
    }
    return { stat, data: null };
  }
}

/** The iOS build currently in DIR, or null when there is none. */
function current() {
  const manifest = readManifest();
  const m = manifest.data || {};
  const named = typeof m.file === 'string' && /^[A-Za-z0-9._-]+\.ipa$/.test(m.file) ? m.file : null;   // a plain file name, never a path
  const file = (named && statOrNull(path.join(DIR, named))) ? named : newestIpa();
  if (!file) { cache = null; return null; }
  const ipaPath = path.join(DIR, file);
  const stat = statOrNull(ipaPath);
  if (!stat || !stat.isFile()) { cache = null; return null; }

  const key = `${file}|${stat.size}|${stat.mtimeMs}|${manifest.stat ? manifest.stat.mtimeMs : 0}`;
  if (cache && cache.key === key) return cache.release;

  const described = m.file === file ? m : {};
  const sizeMatches = Number(described.size) === stat.size;
  if (described.size !== undefined && !sizeMatches) logger.warn(`releases/ios: ${MANIFEST} says ${described.size} bytes but ${file} has ${stat.size}; recomputing its checksum`);
  const fromName = versionFromName(file);
  const bundleId = str(described.bundle_id);
  const release = {
    file,
    path: ipaPath,
    size: stat.size,
    sha256: sizeMatches && /^[0-9a-f]{64}$/.test(String(described.sha256 || '')) ? described.sha256 : sha256Of(ipaPath),
    version_name: str(described.version_name) || fromName.name || '0.0.0',
    version_code: int(described.version_code) ?? fromName.code ?? 0,
    app_name: str(described.app_name) || DEFAULTS.app_name,
    bundle_id: /^[A-Za-z0-9.-]+$/.test(bundleId) ? bundleId : DEFAULTS.bundle_id,
    min_ios: /^\d+(\.\d+)?$/.test(str(described.min_ios)) ? str(described.min_ios) : DEFAULTS.min_ios,
    built_at: validDate(described.built_at) || stat.mtime.toISOString(),
  };
  cache = { key, release };
  return release;
}

/** File name the browser saves: ASCII only, e.g. "POS-Tasotek-1.4.0.ipa". */
function downloadName(release) {
  const app = release.app_name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  return `${app}-${release.version_name.replace(/[^0-9A-Za-z.]/g, '')}.ipa`;
}

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * The manifest Apple's installer reads (itms-services). `base` is the public https origin; the .ipa URL carries
 * the checksum prefix so a new build is never served from a stale cache.
 */
function manifestPlist(release, base) {
  const ipaUrl = `${base}${IPA_PATH}?v=${release.sha256.slice(0, 12)}`;
  const icon = `${base}/brand/apple-touch-icon.png`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict><key>kind</key><string>software-package</string><key>url</key><string>${xml(ipaUrl)}</string></dict>
        <dict><key>kind</key><string>display-image</string><key>url</key><string>${xml(icon)}</string></dict>
        <dict><key>kind</key><string>full-size-image</string><key>url</key><string>${xml(icon)}</string></dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${xml(release.bundle_id)}</string>
        <key>bundle-version</key><string>${xml(release.version_name)}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${xml(release.app_name)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

/** The link Safari turns into the "Install" prompt. */
const installUrl = (base) => `itms-services://?action=download-manifest&url=${encodeURIComponent(`${base}${PLIST_PATH}`)}`;

/** 25 500 000 -> "24,3 MB" (Vietnamese decimal comma); 10 MB and up without decimals. */
function sizeLabel(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1).replace('.', ',')} MB`;
}

/** What the login page shows on the iOS row while an ad-hoc build is published, or null. */
function loginCard() {
  const r = current();
  return r ? { version_name: r.version_name, version_code: r.version_code, sizeLabel: sizeLabel(r.size) } : null;
}

/** Tests only: forget cached metadata. */
const invalidate = () => { cache = null; };

module.exports = { DIR, IPA_MIME, IPA_PATH, PLIST_PATH, DEFAULTS, current, downloadName, manifestPlist, installUrl, sizeLabel, loginCard, versionFromName, invalidate };
