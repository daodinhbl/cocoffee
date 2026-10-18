const express = require('express');
const env = require('../config/env');
const rateLimit = require('../middlewares/rateLimit');
const installService = require('../services/installService');
const logger = require('../utils/logger');

/** /cai-dat: the first-run setup page (blank shop or sample data). Closed (redirects to the login) once an account exists. */
const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '20kb' }));

const machineId = require('../services/machineId');

const page = async (res, values = {}, error = null, field = null, status = 200, extra = {}) =>
  res.status(status).render('install', { values, error, field, needsToken: Boolean(env.db.installToken), noTables: false, machineId: await machineId.read(), ...extra });

router.use(async (_req, res, next) => (await installService.isInstalled() ? res.redirect(302, '/admin/login') : next()));

router.get('/', async (_req, res) => page(res, { data: 'blank' }, null, null, 200, { noTables: !(await installService.hasTables()) }));

router.post('/', rateLimit({ windowMs: 60 * 60 * 1000, max: 20 }), async (req, res) => {
  const b = req.body || {};
  const keep = { shopName: b.shopName, fullName: b.fullName, username: b.username, email: b.email, data: b.data === 'sample' ? 'sample' : 'blank' };
  try {
    const r = await installService.install(b);
    res.set('Cache-Control', 'no-store');
    res.render('install_done', { shopName: r.shopName, sample: r.sample, recoveryCode: r.recoveryCode });
  } catch (err) {
    if (err.status && err.status < 500) return page(res, keep, err.message, err.field || null, err.status === 409 ? 409 : 400);
    logger.error('Install failed', err);
    page(res, keep, 'Cài đặt gặp lỗi, xem nhật ký máy chủ rồi thử lại.', null, 500);
  }
});

module.exports = router;
