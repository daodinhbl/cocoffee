#!/usr/bin/env node
/**
 * Builds the archive uploaded to Hostinger (Node.js app, source "archive"): the committed tree at HEAD minus the
 * paths marked export-ignore in .gitattributes (tests, docs, the Flutter sources), plus the git-ignored Android
 * release in releases/android/ (APK + manifest.json). The APK has to travel with every deploy because a deploy
 * replaces every file on the host.
 *
 *   node scripts/package-deploy.js [--out dist/app.zip] [--no-apk]
 *
 * Uncommitted changes are NOT in the archive (it is `git archive HEAD`): commit first.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'releases', 'android');

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const out = path.resolve(opt('--out') || path.join(ROOT, 'dist', 'app.zip'));
  const withApk = !args.includes('--no-apk');
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

  const dirty = git('status', '--porcelain').split('\n').filter(Boolean);
  if (dirty.length) console.warn(`WARNING: ${dirty.length} uncommitted change(s) are NOT in the archive (it is built from HEAD).`);

  const extra = [];
  if (withApk) {
    const manifestPath = path.join(RELEASE_DIR, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`No ${manifestPath}: run scripts/build-apk.ps1 first, or pass --no-apk to deploy without the Android app.`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const apk = path.join(RELEASE_DIR, String(manifest.file || ''));
    if (!manifest.file || !fs.existsSync(apk)) throw new Error(`manifest.json names "${manifest.file}" but it is not in ${RELEASE_DIR}`);
    const size = fs.statSync(apk).size;
    if (size !== manifest.size) throw new Error(`${manifest.file} is ${size} bytes but manifest.json says ${manifest.size}: re-run scripts/publish-apk.js`);
    extra.push('--prefix=releases/android/', `--add-file=${apk}`, `--add-file=${manifestPath}`, '--prefix=');
    console.log(`Android app: ${manifest.app_name} ${manifest.version_name} (${manifest.version_code}), ${(size / 1048576).toFixed(1)} MB`);
  } else {
    console.log('Android app: not included (--no-apk); /download will say there is no release.');
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  // --prefix applies to the --add-file entries after it and, with its last value, to the tree: hence the reset to "".
  execFileSync('git', ['archive', '--format=zip', '-9', '-o', out, ...extra, 'HEAD'], { cwd: ROOT, stdio: 'inherit' });
  const size = fs.statSync(out).size;
  console.log(`Wrote ${out} (${(size / 1048576).toFixed(1)} MB) from commit ${git('rev-parse', '--short', 'HEAD')}`);
}

try { main(); } catch (err) { console.error(err.message); process.exit(1); }
