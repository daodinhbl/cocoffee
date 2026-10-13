const express = require('express');
const { adminSecurity, pageRenderer } = require('../middlewares/adminSecurity');
const { flash, loadSession, requireAdmin, requireCsrf } = require('../middlewares/adminAuth');
const rateLimit = require('../middlewares/rateLimit');
const { AppError } = require('../utils/httpError');
const logger = require('../utils/logger');
const env = require('../config/env');
const { shell, describeError, act } = require('../controllers/admin/common');

const auth = require('../controllers/admin/authPages');
const dashboard = require('../controllers/admin/dashboard');
const tables = require('../controllers/admin/tables');
const orders = require('../controllers/admin/orders');
const menu = require('../controllers/admin/menu');
const inventory = require('../controllers/admin/inventory');
const bom = require('../controllers/admin/bom');
const reports = require('../controllers/admin/reports');
const zalo = require('../controllers/admin/zalo');
const settings = require('../controllers/admin/settings');

const router = express.Router();

// Server-rendered Web Admin (EJS + Tailwind CDN + vanilla JS). Every page except /login needs an admin session;
// every POST needs the session's CSRF token (see middlewares/adminAuth.js).
router.use(adminSecurity, pageRenderer, express.urlencoded({ extended: false, limit: '200kb' }), flash, loadSession);

router.get('/login', auth.loginForm);
router.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), auth.login);

router.use(requireAdmin, requireCsrf);
router.post('/logout', auth.logout);

router.get('/', (_req, res) => res.redirect(302, '/admin/dashboard'));
router.get('/dashboard', dashboard.dashboard);

router.get('/tables', tables.page);
router.post('/tables', act(tables.create));
router.post('/tables/:id', act(tables.update));

router.get('/orders', orders.list);
router.get('/orders/:id', orders.detail);
router.post('/orders/:id/cancel', act(orders.cancel));
router.post('/orders/:id/pay', act(orders.pay));
router.post('/orders/:id/resend-receipt', act(orders.resendReceipt));

router.get('/menu', menu.page);
router.post('/menu/categories', act(menu.createCategory));
router.post('/menu/categories/:id', act(menu.updateCategory));
router.post('/menu/products', act(menu.createProduct));
router.post('/menu/products/:id', act(menu.updateProduct));

router.get('/inventory', inventory.page);
router.post('/inventory', act(inventory.create));
router.get('/inventory/:id', inventory.detail);
router.post('/inventory/:id', act(inventory.update));
router.post('/inventory/:id/adjust', act(inventory.adjust));

router.get('/receiving', inventory.receivingPage);
router.post('/receiving', act(inventory.receive));

router.get('/bom-recipes', bom.page);
router.post('/bom-recipes', act(bom.create));
router.post('/bom-recipes/:id', act(bom.update));
router.post('/bom-recipes/:id/delete', act(bom.remove));

router.get('/reports', reports.page);

router.get('/zalo', zalo.page);
router.post('/zalo/orders/:id/resend-receipt', act(zalo.resendReceipt));

router.get('/settings', settings.page);
router.get('/settings/password', settings.page);
router.post('/settings/password', act(auth.changeOwnPassword));
router.post('/settings/users', act(settings.createUser));
router.post('/settings/users/:id/password', act(settings.resetPassword));
router.post('/settings/users/:id/active', act(settings.setActive));

router.use((req, _res, next) => next(new AppError(404, 'NOT_FOUND', `Không tìm thấy trang ${req.path}`)));

// HTML error pages for the admin (the JSON handler in app.js only serves /api).
// eslint-disable-next-line no-unused-vars
router.use(async (err, req, res, _next) => {
  const known = describeError(err) || (err.type === 'entity.too.large' ? 'Dữ liệu gửi lên quá lớn.' : null);
  const status = err instanceof AppError ? err.status : (err.status >= 400 && err.status < 500 ? err.status : (known ? 400 : 500));
  if (!known) logger.error(`Admin error on ${req.method} ${req.originalUrl}`, err);
  const message = known || 'Đã có lỗi hệ thống. Vui lòng thử lại sau.';
  if (res.headersSent) return undefined;
  if (req.adminErrorRendered) return res.status(status).type('text').send(message);   // the error page itself failed
  req.adminErrorRendered = true;
  if (!req.user) {
    if (req.path === '/login' && req.method === 'POST') {
      return res.status(status).render('login', { shopName: env.business.shopName, error: status === 429 ? 'Thử đăng nhập quá nhiều lần. Hãy đợi 15 phút.' : message, username: '', next: '' });
    }
    return res.status(status).type('text').send(message);
  }
  try {
    return res.status(status).page('error', {
      ...(await shell({ title: 'Có lỗi xảy ra', activeMenu: '', breadcrumbs: [{ label: 'Lỗi' }] })),
      status, message,
    });
  } catch (renderErr) {
    logger.error('Admin error page failed to render', renderErr);
    return res.status(status).type('text').send(message);
  }
});

module.exports = router;
