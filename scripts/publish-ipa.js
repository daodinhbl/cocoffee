#!/usr/bin/env node
/**
 * Publishes an ad-hoc iOS build for direct installation: copies the .ipa into releases/ios/ (one release at a
 * time) and writes manifest.json next to it, which /download/ios serves (see src/services/iosRelease.js).
 *
 *   node scripts/publish-ipa.js <folder-or-ipa> [--dir releases/ios]
 *
 * The source is the GitHub Actions artifact "pos-tasotek-ios-adhoc-<version>-<build>" (workflow "iOS TestFlight"
 * run with adhoc=true), downloaded with `gh run download <run-id> -n <artifact> -D <folder>`: it holds the .ipa
 * and the manifest.json the workflow wrote (bundle id, version, build number, size, sha256). A bare .ipa without
 * a manifest is described from its file name (POS-Tasotek-1.4.0-12.ipa) and the defaults below.
 * Both output files are git-ignored: scripts/package-deploy.js adds them to the deploy archive, because a
 * Hostinger deploy replaces every file on the host.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = { app_name: 'POS Tasotek', bundle_id: 'com.tasotek.fnb', min_ios: '15.0' };

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** "POS-Tasotek-1.4.0-12.ipa" -> { version_name: '1.4.0', version_code: 12 } (or '0.0.0' / 0 when the name says nothing). */
function metaFromName(file) {
  const m = /-(\d+(?:\.\d+)+)(?:[-+](\d+))?\.ipa$/i.exec(path.basename(file));
  return { version_name: m ? m[1] : '0.0.0', version_code: m && m[2] ? Number(m[2]) : 0 };
}

/** The .ipa (and the manifest next to it, if any) inside `src`, which is a folder or the .ipa itself. */
function locate(src) {
  const stat = fs.statSync(src);
  if (stat.isFile()) return { ipa: src, manifest: path.join(path.dirname(src), 'manifest.json') };
  const ipas = fs.readdirSync(src).filter((f) => /\.ipa$/i.test(f));
  if (!ipas.length) throw new Error(`No .ipa in ${src}`);
  if (ipas.length > 1) throw new Error(`More than one .ipa in ${src}: ${ipas.join(', ')}`);
  return { ipa: path.join(src, ipas[0]), manifest: path.join(src, 'manifest.json') };
}

/**
 * Copy the build into `dir` (removing other .ipa files there) and write manifest.json. Returns the manifest.
 * The workflow's manifest is trusted for names and versions only: size and checksum are always taken from the file.
 */
function publish({ src, dir = path.join(ROOT, 'releases', 'ios'), now = new Date() }) {
  if (!src || !fs.existsSync(src)) throw new Error(`Build not found: ${src || '(no path given)'}\nDownload it first: gh run download <run-id> -n pos-tasotek-ios-adhoc-<version>-<build> -D <folder>`);
  const { ipa, manifest: manifestPath } = locate(src);
  let given = {};
  if (fs.existsSync(manifestPath)) {
    try { given = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) || {}; } catch (err) { throw new Error(`${manifestPath} is not valid JSON: ${err.message}`); }
  }
  const fromName = metaFromName(ipa);
  const versionName = typeof given.version_name === 'string' && /^\d+(\.\d+)+$/.test(given.version_name) ? given.version_name : fromName.version_name;
  const versionCode = Number.isInteger(Number(given.version_code)) && Number(given.version_code) >= 0 ? Number(given.version_code) : fromName.version_code;
  const bundleId = typeof given.bundle_id === 'string' && /^[A-Za-z0-9.-]+$/.test(given.bundle_id) ? given.bundle_id : DEFAULTS.bundle_id;
  const appName = typeof given.app_name === 'string' && given.app_name.trim() ? given.app_name.trim().slice(0, 120) : DEFAULTS.app_name;
  const minIos = typeof given.min_ios === 'string' && /^\d+(\.\d+)?$/.test(given.min_ios) ? given.min_ios : DEFAULTS.min_ios;
  const file = `${appName.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app'}-${versionName}-${versionCode}.ipa`;

  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/\.ipa$/i.test(f) && f !== file) fs.unlinkSync(path.join(dir, f));
  const dest = path.join(dir, file);
  fs.copyFileSync(ipa, dest);
  const size = fs.statSync(dest).size;
  const sha = sha256(dest);
  if (given.size !== undefined && Number(given.size) !== size) throw new Error(`${path.basename(ipa)} is ${size} bytes but its manifest says ${given.size}: the download is incomplete`);
  if (given.sha256 && String(given.sha256).toLowerCase() !== sha) throw new Error(`${path.basename(ipa)} checksum ${sha.slice(0, 16)}… differs from its manifest: the download is corrupt`);
  const manifest = {
    file,
    app_name: appName,
    bundle_id: bundleId,
    version_name: versionName,
    version_code: versionCode,
    min_ios: minIos,
    size,
    sha256: sha,
    built_at: typeof given.built_at === 'string' && Number.isFinite(new Date(given.built_at).getTime()) ? new Date(given.built_at).toISOString() : now.toISOString(),
    method: typeof given.method === 'string' ? given.method : 'release-testing',
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const dir = opt('--dir');
  const src = args.find((a) => !a.startsWith('--'));
  try {
    const m = publish({ src: src ? path.resolve(src) : undefined, dir: dir ? path.resolve(dir) : undefined });
    console.log(`Published ${m.file}: ${m.app_name} ${m.version_name} (${m.version_code}), ${(m.size / 1048576).toFixed(1)} MB, ${m.bundle_id}, iOS ${m.min_ios}+, sha256 ${m.sha256.slice(0, 16)}...`);
    console.log('Next: node scripts/package-deploy.js, then upload and build on Hostinger; /download/ios offers the build to registered devices.');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { publish, metaFromName, DEFAULTS };
