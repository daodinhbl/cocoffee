#!/usr/bin/env node
/**
 * Publishes a built Android APK for download: copies it into releases/android/ (one release at a time) and writes
 * manifest.json next to it, which /download serves (see src/services/appRelease.js).
 *
 *   node scripts/publish-apk.js [path/to/app-release.apk] [--dir releases/android]
 *
 * Default source: mobile/build/app/outputs/flutter-apk/app-release.apk (what `flutter build apk --release` writes;
 * scripts/build-apk.ps1 runs both steps). Metadata is read from the APK itself with the Android SDK's `aapt` when
 * one can be found (ANDROID_HOME, ANDROID_SDK_ROOT or %LOCALAPPDATA%\Android\Sdk); otherwise from mobile/pubspec.yaml,
 * AndroidManifest.xml and build.gradle.kts. Both output files are git-ignored: scripts/package-deploy.js adds them to
 * the deploy archive, because a Hostinger deploy replaces every file on the host.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SRC = path.join(ROOT, 'mobile', 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
const DEFAULTS = { app_name: 'Tasotek FnB', package: 'com.tasotek.cocoffee_mobile', min_sdk: 24 };

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; } };

/** Newest aapt binary of an installed Android SDK, or null. */
function findAapt() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')].filter(Boolean);
  for (const root of roots) {
    const bt = path.join(root, 'build-tools');
    let versions;
    try { versions = fs.readdirSync(bt); } catch (_) { continue; }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      for (const bin of ['aapt.exe', 'aapt']) {
        const p = path.join(bt, v, bin);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/** `aapt dump badging` -> { package, version_code, version_name, min_sdk, app_name }, or null when aapt is unavailable or fails. */
function metaFromAapt(apk, aapt = findAapt()) {
  if (!aapt) return null;
  let out;
  try {
    out = execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 << 20 });
  } catch (_) { return null; }
  const pkg = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m.exec(out);
  if (!pkg) return null;
  const sdk = /^sdkVersion:'(\d+)'/m.exec(out);
  const label = /^application-label(?:-vi)?:'([^']*)'/m.exec(out);
  return {
    package: pkg[1],
    version_code: Number(pkg[2]),
    version_name: pkg[3],
    min_sdk: sdk ? Number(sdk[1]) : DEFAULTS.min_sdk,
    app_name: label ? label[1] : DEFAULTS.app_name,
    source: path.basename(aapt),
  };
}

/** Fallback: the Flutter project's own files. */
function metaFromProject(mobileDir) {
  const pubspec = /^version:\s*([0-9][0-9A-Za-z.-]*?)(?:\+(\d+))?\s*$/m.exec(read(path.join(mobileDir, 'pubspec.yaml')));
  const manifest = /android:label="([^"]+)"/.exec(read(path.join(mobileDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')));
  const gradle = read(path.join(mobileDir, 'android', 'app', 'build.gradle.kts')) || read(path.join(mobileDir, 'android', 'app', 'build.gradle'));
  const appId = /applicationId\s*=?\s*"([^"]+)"/.exec(gradle);
  const minSdk = /minSdk(?:Version)?\s*=?\s*(\d+)/.exec(gradle);
  return {
    package: appId ? appId[1] : DEFAULTS.package,
    version_code: pubspec && pubspec[2] ? Number(pubspec[2]) : 1,
    version_name: pubspec ? pubspec[1] : '0.0.0',
    min_sdk: minSdk ? Number(minSdk[1]) : DEFAULTS.min_sdk,
    app_name: manifest ? manifest[1] : DEFAULTS.app_name,
    source: 'pubspec.yaml',
  };
}

/**
 * Copy `src` into `dir` as cocoffee-<version>-<code>.apk (removing other .apk files there) and write manifest.json.
 * Returns the manifest. `aapt: false` skips the SDK lookup; a string names the aapt binary to use.
 */
function publish({ src = DEFAULT_SRC, dir = path.join(ROOT, 'releases', 'android'), mobileDir = path.join(ROOT, 'mobile'), aapt = true, now = new Date() } = {}) {
  if (!fs.existsSync(src)) throw new Error(`APK not found: ${src}\nBuild it first: scripts/build-apk.ps1 (or flutter build apk --release in mobile/)`);
  const meta = (aapt ? metaFromAapt(src, typeof aapt === 'string' ? aapt : undefined) : null) || metaFromProject(mobileDir);
  const file = `cocoffee-${meta.version_name.replace(/[^0-9A-Za-z.]/g, '')}-${meta.version_code}.apk`;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/\.apk$/i.test(f) && f !== file) fs.unlinkSync(path.join(dir, f));
  const dest = path.join(dir, file);
  fs.copyFileSync(src, dest);
  const manifest = {
    file,
    app_name: meta.app_name,
    package: meta.package,
    version_name: meta.version_name,
    version_code: meta.version_code,
    min_sdk: meta.min_sdk,
    size: fs.statSync(dest).size,
    sha256: sha256(dest),
    built_at: now.toISOString(),
    metadata_source: meta.source,
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
    console.log(`Published ${m.file}: ${m.app_name} ${m.version_name} (${m.version_code}), ${(m.size / 1048576).toFixed(1)} MB, minSdk ${m.min_sdk}, sha256 ${m.sha256.slice(0, 16)}... [${m.metadata_source}]`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { publish, metaFromAapt, metaFromProject, findAapt, DEFAULT_SRC };
