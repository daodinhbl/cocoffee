const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * The Android app build offered at /download.
 *
 * `releases/android/` holds ONE .apk plus the manifest.json that scripts/publish-apk.js writes next to it
 * (version, size, SHA-256, package). Both are git-ignored build artifacts that scripts/package-deploy.js adds to
 * the deploy archive: a deploy replaces every file on the host, so the APK has to travel with every deploy.
 * Without a manifest the newest .apk in the directory is described from the file itself (version from its name,
 * SHA-256 computed once). Everything is read synchronously and cached by mtime: two small stat() calls per request.
 */
const DIR = path.resolve(env.rootDir, process.env.APP_RELEASE_DIR || 'releases/android');
const MANIFEST = 'manifest.json';
const APK_MIME = 'application/vnd.android.package-archive';
const DEFAULTS = { app_name: 'Tasotek FnB', package: 'com.tasotek.cocoffee_mobile', min_sdk: 24 };
// Android API level -> marketing version, for "Android 7.0 trở lên".
const ANDROID = { 21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16' };

let cache = null;                  // { key, release } for the current file + manifest mtimes
const qrCache = new Map();         // url -> svg (bounded: the Host header is attacker-controlled when PUBLIC_BASE_URL is unset)
const QR_CACHE_MAX = 8;

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

/** "cocoffee-1.2.0-7.apk" -> { name: '1.2.0', code: 7 }; anything else -> { name: '', code: null }. */
function versionFromName(file) {
  const m = /-(\d+(?:\.\d+)+)(?:[-+](\d+))?\.apk$/i.exec(file);
  return m ? { name: m[1], code: m[2] ? Number(m[2]) : null } : { name: '', code: null };
}

function newestApk() {
  let entries;
  try { entries = fs.readdirSync(DIR); } catch (_) { return null; }
  const apks = entries
    .filter((f) => /\.apk$/i.test(f))
    .map((f) => ({ f, stat: statOrNull(path.join(DIR, f)) }))
    .filter((e) => e.stat && e.stat.isFile());
  apks.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return apks.length ? apks[0].f : null;
}

function readManifest() {
  const file = path.join(DIR, MANIFEST);
  const stat = statOrNull(file);
  if (!stat) return { stat: null, data: null };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { stat, data: data && typeof data === 'object' && !Array.isArray(data) ? data : null };
  } catch (err) {
    logger.warn(`${MANIFEST} in ${DIR} is not valid JSON; describing the APK from the file instead`, err);
    return { stat, data: null };
  }
}

/** The release currently in DIR, or null when there is none. */
function current() {
  const manifest = readManifest();
  const m = manifest.data || {};
  const named = typeof m.file === 'string' && /^[A-Za-z0-9._-]+\.apk$/.test(m.file) ? m.file : null;   // a plain file name, never a path
  const file = (named && statOrNull(path.join(DIR, named))) ? named : newestApk();
  if (!file) { cache = null; return null; }
  const apkPath = path.join(DIR, file);
  const stat = statOrNull(apkPath);
  if (!stat || !stat.isFile()) { cache = null; return null; }

  const key = `${file}|${stat.size}|${stat.mtimeMs}|${manifest.stat ? manifest.stat.mtimeMs : 0}`;
  if (cache && cache.key === key) return cache.release;

  const described = m.file === file ? m : {};                         // a manifest for another file says nothing about this one
  const sizeMatches = Number(described.size) === stat.size;
  if (described.size !== undefined && !sizeMatches) logger.warn(`releases/android: ${MANIFEST} says ${described.size} bytes but ${file} has ${stat.size}; recomputing its checksum`);
  const fromName = versionFromName(file);
  const release = {
    file,
    path: apkPath,
    size: stat.size,
    sha256: sizeMatches && /^[0-9a-f]{64}$/.test(String(described.sha256 || '')) ? described.sha256 : sha256Of(apkPath),
    version_name: str(described.version_name) || fromName.name || '0.0.0',
    version_code: int(described.version_code) ?? fromName.code ?? 0,
    app_name: str(described.app_name) || DEFAULTS.app_name,
    package: str(described.package) || DEFAULTS.package,
    min_sdk: int(described.min_sdk) ?? DEFAULTS.min_sdk,
    built_at: validDate(described.built_at) || stat.mtime.toISOString(),
  };
  cache = { key, release };
  return release;
}

/** File name the browser saves: ASCII only, e.g. "Tasotek-FnB-1.0.0.apk". */
function downloadName(release) {
  const app = release.app_name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  return `${app}-${release.version_name.replace(/[^0-9A-Za-z.]/g, '')}.apk`;
}

/** 25 500 000 -> "24,3 MB" (Vietnamese decimal comma); 10 MB and up without decimals. */
function sizeLabel(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1).replace('.', ',')} MB`;
}

/** 24 -> "Android 7.0 trở lên" */
const androidLabel = (minSdk) => `Android ${ANDROID[minSdk] || `API ${minSdk}`} trở lên`;

/**
 * Absolute origin for links that leave the page (QR code, manifest URLs). PUBLIC_BASE_URL wins; without it the
 * request's own origin is used (trust proxy is on, so the scheme is the one the visitor used).
 */
function baseUrl(req) {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  const host = String(req.get('host') || '');
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(host)) return 'http://localhost';
  return `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
}

/** QR code (SVG markup) pointing at `text`; cached per text. */
async function qrSvg(text) {
  const hit = qrCache.get(text);
  if (hit) return hit;
  const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  if (qrCache.size >= QR_CACHE_MAX) qrCache.delete(qrCache.keys().next().value);
  qrCache.set(text, svg);
  return svg;
}

/** What the login page shows next to the QR code, or null when nothing can be downloaded. */
function loginCard() {
  const r = current();
  return r ? { app_name: r.app_name, version_name: r.version_name, sizeLabel: sizeLabel(r.size) } : null;
}

/** Tests only: forget cached metadata. */
const invalidate = () => { cache = null; qrCache.clear(); };

module.exports = { DIR, APK_MIME, current, downloadName, sizeLabel, androidLabel, baseUrl, qrSvg, loginCard, versionFromName, invalidate };
