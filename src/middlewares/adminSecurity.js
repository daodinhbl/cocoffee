const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');

// Cache-busting for page scripts. Static files are cached for an hour, while the HTML is never cached,
// so after a deploy fresh markup could otherwise run against a stale script. The URL carries a content hash.
const hashes = new Map();
function versionOf(relPath) {
  const file = path.join(env.rootDir, 'public', relPath);
  const known = hashes.get(file) || { mtime: 0, v: '0' };
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime !== known.mtime) hashes.set(file, { mtime, v: crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 10) });
  } catch (_) { /* file missing: keep the last value */ }
  return (hashes.get(file) || known).v;
}
const assetVersion = () => versionOf('admin/admin.js');

/**
 * Per-request CSP nonce + headers for the server-rendered admin pages.
 * The admin shell uses Tailwind's Play CDN (system fonts only), plus two small inline scripts (Tailwind
 * theme config, sidebar-state restore). Those inline scripts carry the nonce; there are no inline
 * event handlers, so 'unsafe-inline' is NOT granted for scripts. Overrides helmet's default CSP.
 */
function adminSecurity(_req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.nonce = nonce;
  res.locals.assetV = assetVersion();
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://cdn.tailwindcss.com`,
    "style-src 'self' 'unsafe-inline'",                                // Tailwind CDN injects <style> at runtime
    "font-src 'self'",                                                 // Times New Roman is a system font
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/** res.page('dashboard', locals): render views/pages/<name>.ejs and wrap it in views/layout.ejs as `body`. */
function pageRenderer(req, res, next) {
  res.page = (name, locals = {}) => {
    res.render(`pages/${name}`, locals, (err, body) => {
      if (err) return next(err);
      return res.render('layout', { ...locals, body });
    });
  };
  next();
}

module.exports = { adminSecurity, pageRenderer, versionOf };
