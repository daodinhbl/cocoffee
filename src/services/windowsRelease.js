const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');

/**
 * The Windows installer (POS Tasotek Server, desktop/installer) offered on the login page and at /download/windows/<file>.
 * `releases/windows/` holds ONE POS-Tasotek-Server-Setup-<version>.exe (git-ignored; scripts/package-deploy.js adds it to the deploy
 * archive, like the APK). Version and size come from the file; the SHA-256 is computed once per file version and cached by mtime.
 */
const DIR = path.resolve(env.rootDir, process.env.WINDOWS_RELEASE_DIR || 'releases/windows');
const FILE_RE = /^POS-Tasotek-Server-Setup-(\d+(?:\.\d+)+)\.exe$/i;
const EXE_MIME = 'application/vnd.microsoft.portable-executable';
const ROUTE = '/download/windows';

let cache = null;     // { key, release }

const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n = fs.readSync(fd, buf, 0, buf.length, null); n; n = fs.readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/** @returns {{ file: string, path: string, version: string, size: number, sha256: string, builtAt: Date } | null} */
function current() {
  let names;
  try { names = fs.readdirSync(DIR); } catch (_) { return null; }
  const best = names.map((f) => ({ f, m: FILE_RE.exec(f) })).filter((e) => e.m).sort((a, b) => cmp(b.m[1], a.m[1]))[0];
  if (!best) return null;
  const full = path.join(DIR, best.f);
  let st;
  try { st = fs.statSync(full); } catch (_) { return null; }
  if (!st.isFile()) return null;
  const key = `${best.f}:${st.size}:${st.mtimeMs}`;
  if (!cache || cache.key !== key) {
    cache = { key, release: { file: best.f, path: full, version: best.m[1], size: st.size, sha256: sha256Of(full), builtAt: st.mtime } };
  }
  return cache.release;
}

const sizeLabel = (n) => `${Math.round(n / 1048576)} MB`;
const urlOf = (r) => `${ROUTE}/${encodeURIComponent(r.file)}?v=${r.sha256.slice(0, 12)}`;

/** What the login page shows, or null when no installer is published. */
function loginCard() {
  const r = current();
  return r ? { version: r.version, size: sizeLabel(r.size), url: urlOf(r), file: r.file } : null;
}

module.exports = { current, loginCard, EXE_MIME, ROUTE, DIR };
