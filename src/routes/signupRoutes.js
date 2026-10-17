const express = require('express');
const env = require('../config/env');
const rateLimit = require('../middlewares/rateLimit');
const tenantModel = require('../models/tenantModel');
const tenantService = require('../services/tenantService');
const logger = require('../utils/logger');

/**
 * Public shop sign-up on the main site: /dang-ky (form), POST /dang-ky (creates the shop + its admin account) and
 * /dang-ky/kiem-tra?slug= (is the sub-domain free?). Not available on a shop's own host or when tenancy is off.
 */
const router = express.Router();

router.use((req, res, next) => (tenantService.enabled() && !req.tenant ? next() : res.status(404).type('text').send('Not found')));
router.use(express.urlencoded({ extended: false, limit: '20kb' }));

const form = (res, values = {}, error = null, field = null, status = 200) =>
  res.status(status).render('signup', { baseDomain: env.tenancy.baseDomain, open: env.tenancy.signupOpen, values, error, field });

router.get('/', (_req, res) => form(res));

router.get('/kiem-tra', rateLimit({ windowMs: 60 * 1000, max: 30 }), async (req, res) => {
  const slug = String(req.query.slug || '').trim().toLowerCase();
  try {
    tenantService.validateSignup({ slug, name: 'xx', ownerName: 'xx', email: 'a@b.co', username: 'abc', password: '0123456789' });
    const taken = await tenantModel.slugTaken(slug);
    res.json({ ok: !taken, message: taken ? 'Tên này đã có người dùng.' : `Còn trống: ${slug}.${env.tenancy.baseDomain}` });
  } catch (err) {
    res.json({ ok: false, message: err.field === 'slug' ? err.message : 'Tên chưa hợp lệ.' });
  }
});

router.post('/', rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }), async (req, res) => {
  const b = req.body || {};
  const keep = { slug: b.slug, name: b.name, ownerName: b.ownerName, email: b.email, phone: b.phone, username: b.username };
  if (b.website) return res.redirect(303, '/dang-ky');                 // honeypot: real people never fill this field
  try {
    const r = await tenantService.signup(b);
    res.render('signup_done', { baseDomain: env.tenancy.baseDomain, shop: r, name: String(b.name).trim() });
  } catch (err) {
    if (err.status && err.status < 500) return form(res, keep, err.message, err.field || null, err.status === 409 ? 409 : 400);
    logger.error('Shop sign-up failed', err);
    form(res, keep, 'Hệ thống đang bận, vui lòng thử lại sau ít phút.', null, 500);
  }
});

module.exports = router;
