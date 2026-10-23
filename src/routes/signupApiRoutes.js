const express = require('express');
const env = require('../config/env');
const rateLimit = require('../middlewares/rateLimit');
const tenantModel = require('../models/tenantModel');
const tenantService = require('../services/tenantService');
const { AppError } = require('../utils/httpError');

/**
 * Shop sign-up for the app's "Tạo quán mới" screen: the JSON twin of /dang-ky (routes/signupRoutes.js), same rules
 * (tenantService.validateSignup / signup), same limits. Only on the main site with the multi-shop mode on.
 *
 *   GET  /api/signup              -> { open, base_domain }
 *   GET  /api/signup/check?slug=  -> { ok, message, url? }            (is the sub-domain free?)
 *   POST /api/signup              -> 201 { slug, status: 'active'|'pending', url, base_domain, username }
 *   GET  /api/signup/status?slug= -> { status: 'active'|'pending'|'unknown' }   (a waiting sign-up got its database?)
 *
 * Errors use the API's shape; a field error carries `details.field` (slug, name, ownerName, email, phone, username,
 * password, password2) so the app can mark the input.
 */
const router = express.Router();

router.use((req, _res, next) => {
  if (!tenantService.enabled() || req.tenant) throw new AppError(404, 'NOT_FOUND', 'Sign-up is not available on this server');
  next();
});

router.get('/', (_req, res) => res.json({ open: env.tenancy.signupOpen, base_domain: env.tenancy.baseDomain }));

router.get('/check', rateLimit({ windowMs: 60 * 1000, max: 30 }), async (req, res) => {
  const slug = String(req.query.slug || '').trim().toLowerCase();
  try {
    tenantService.validateSignup({ slug, name: 'xx', ownerName: 'xx', email: 'a@b.co', username: 'abc', password: '0123456789' });
  } catch (err) {
    return res.json({ ok: false, message: err.field === 'slug' ? err.message : 'Tên chưa hợp lệ.' });
  }
  const taken = await tenantModel.slugTaken(slug);
  res.json(taken ? { ok: false, message: 'Tên này đã có người dùng.' } : { ok: true, message: `Còn trống: ${slug}.${env.tenancy.baseDomain}`, url: tenantService.urlOf(slug) });
});

router.get('/status', rateLimit({ windowMs: 60 * 1000, max: 30 }), async (req, res) => {
  const slug = String(req.query.slug || '').trim().toLowerCase();
  const row = slug ? await tenantModel.findBySlug(slug) : null;
  const status = !row || row.delete_after ? 'unknown' : row.status === 'active' && row.db_name ? 'active' : row.status === 'pending' ? 'pending' : 'unknown';
  res.json({ status });
});

router.post('/', rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }), async (req, res) => {
  const b = req.body || {};
  if (b.website) throw new AppError(400, 'VALIDATION', 'Dữ liệu chưa hợp lệ.');      // honeypot: the app never sends it
  try {
    const r = await tenantService.signup(b);
    res.status(201).json({ slug: r.slug, status: r.status, url: r.url, base_domain: env.tenancy.baseDomain, username: String(b.username).trim().toLowerCase() });
  } catch (err) {
    if (err instanceof AppError && err.field && !err.details) err.details = { field: err.field };
    throw err;
  }
});

module.exports = router;
