const express = require('express');
const env = require('../config/env');
const rateLimit = require('../middlewares/rateLimit');
const accountDeletion = require('../services/accountDeletion');
const tenantService = require('../services/tenantService');
const logger = require('../utils/logger');

/**
 * /xoa-tai-khoan: the public "delete your account" page Google Play asks for (its URL goes into the Play Console's
 * Data safety form). It explains the in-app path (Cài đặt > Xóa tài khoản và dữ liệu) and, for a shop created by
 * sign-up, takes the request itself: sub-domain + admin username + password. Other installs get the contact details.
 */
const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '10kb' }));

const page = (req, res, { status = 200, values = {}, error = null, done = null } = {}) =>
  res.status(status).render('delete_account', {
    signupShops: tenantService.enabled(),
    baseDomain: env.tenancy.baseDomain,
    graceDays: accountDeletion.GRACE_DAYS,
    contact: env.contact,
    values: { slug: req.tenant?.slug || '', ...values },
    error,
    done,
  });

router.get('/', (req, res) => page(req, res));

router.post('/', rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }), async (req, res) => {
  const b = req.body || {};
  const values = { slug: String(b.slug || '').trim().toLowerCase().slice(0, 30), username: String(b.username || '').trim().slice(0, 50) };
  if (b.website) return res.redirect(303, '/xoa-tai-khoan');            // honeypot: real people never fill this field
  if (!tenantService.enabled()) {
    return page(req, res, { status: 404, values, error: 'Máy chủ này không nhận yêu cầu xóa trực tuyến. Vui lòng liên hệ theo thông tin bên dưới.' });
  }
  if (b.agree !== '1') return page(req, res, { status: 400, values, error: 'Hãy đánh dấu ô xác nhận rằng bạn hiểu dữ liệu sẽ bị xóa vĩnh viễn.' });
  try {
    const row = await accountDeletion.verifyOwner(values.slug, values.username, b.password);
    const r = await accountDeletion.request(row.id);
    return page(req, res, { done: { slug: r.slug, deleteAfter: r.delete_after ? new Date(r.delete_after) : null } });
  } catch (err) {
    if (err.status === 401) return page(req, res, { status: 401, values, error: 'Sai tên miền phụ, tên đăng nhập hoặc mật khẩu (cần tài khoản quản trị của quán).' });
    logger.error('Account deletion request failed', err);
    return page(req, res, { status: 500, values, error: 'Hệ thống đang bận, vui lòng thử lại sau ít phút.' });
  }
});

module.exports = router;
