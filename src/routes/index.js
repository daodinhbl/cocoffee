const express = require('express');
const { requireAuth, requireRole } = require('../middlewares/auth');
const rateLimit = require('../middlewares/rateLimit');
const idempotency = require('../middlewares/idempotency');
const zaloWebhookRoutes = require('../webhooks/zalo/zaloWebhookRoutes');
const facebookRoutes = require('../webhooks/facebook/facebookRoutes');
const payonRoutes =require('../webhooks/payon/payonRoutes');
const apiAdminRoutes = require('./apiAdminRoutes');
const apiFinanceRoutes = require('./apiFinanceRoutes');
const heliRoutes = require('./heliRoutes');

const auth = require('../controllers/authController');
const tables = require('../controllers/tableController');
const menu = require('../controllers/menuController');
const inventory = require('../controllers/inventoryController');
const orders = require('../controllers/orderController');
const shell = require('../controllers/api/shellApi');
const account = require('../controllers/api/accountApi');
const signupApiRoutes = require('./signupApiRoutes');
const pos = require('../controllers/api/posApi');

const router = express.Router();
const admin = requireRole('admin');

// ---- public ---------------------------------------------------------------
router.use('/payon', payonRoutes);                                          // POST /api/payon/ipn (PayOn notification, checksum-verified, no JWT)
router.use('/facebook', facebookRoutes);                                  // /api/facebook/webhook (Messenger bot; signature-verified, no JWT)
router.use('/zalo', zaloWebhookRoutes);                                  // POST /api/zalo/webhook (signature-verified, no JWT)
// Windows installs ask for their own ngrok domain + tunnel token here (licence-checked, see services/ngrokBroker.js). Body: { machine, code, shopName? }.
router.post('/ngrok/claim', rateLimit({ windowMs: 60 * 60 * 1000, max: 20 }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await require('../services/ngrokBroker').claim({ machine: String(b.machine || '').slice(0, 60), code: String(b.code || '').slice(0, 2000), shopName: typeof b.shopName === 'string' ? b.shopName.slice(0, 60) : undefined });
    res.set('Cache-Control', 'no-store');
    return res.json({ domain: r.domain, authtoken: r.authtoken });
  } catch (err) { return next(err); }
});
router.use('/signup', signupApiRoutes);                                  // the app's "Tạo quán mới" (main site, multi-shop mode only)
router.post('/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }), rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: rateLimit.accountKey }), auth.login);

// ---- everything below needs a bearer token ----------------------------------
// (a token flagged "must change password" only reaches /auth/me and /auth/change-password: see middlewares/auth.js)
router.use(requireAuth);
router.get('/auth/me', auth.me);
router.post('/auth/change-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => `pw:${req.user.id}` }), auth.changePassword);
router.get('/account', account.info);                                      // Cài đặt > Xóa tài khoản (shops created by sign-up)
router.post('/account/delete', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, key: (req) => `del:${req.user.id}` }), account.remove);

// app shell + POS (any staff). /zalo/status and /zalo/drafts fall through the public webhook router above.
router.get('/zalo/status', shell.status);
router.get('/zalo/drafts', shell.drafts);
router.get('/pos/bootstrap', pos.bootstrap);
router.get('/sync/snapshot', shell.snapshot);
router.post('/pos/checkout', idempotency(), pos.checkout);
router.post('/pos/hold', idempotency(), pos.hold);
router.get('/settings/printer', pos.printer);

router.get('/tables', tables.list);                                       // ?all=1 is admin-only (checked inside)
router.post('/tables', admin, tables.create);
router.put('/tables/:id', admin, tables.update);

router.get('/categories', menu.listCategories);
router.post('/categories', admin, menu.createCategory);
router.put('/categories/:id', admin, menu.updateCategory);
router.get('/products', menu.listProducts);
router.get('/products/:id', menu.getProduct);
router.post('/products', admin, menu.createProduct);
router.put('/products/:id', admin, menu.updateProduct);

router.get('/inventory', inventory.list);                                 // ?all=1 is admin-only (checked inside)
router.post('/inventory', admin, inventory.create);
router.get('/inventory/purchases', admin, inventory.purchases);           // before /inventory/:id
router.get('/inventory/:id', admin, inventory.get);
router.put('/inventory/:id', admin, inventory.update);
router.post('/inventory/:id/receive', admin, idempotency(), inventory.receive);     // replayed by the app's offline queue
router.post('/inventory/:id/adjust', admin, idempotency(), inventory.adjust);
router.get('/inventory/:id/movements', admin, inventory.movements);

router.get('/orders/summary', admin, orders.summary);                    // before /orders/:id
router.get('/orders', orders.list);
router.post('/orders', idempotency(), orders.create);
router.get('/orders/:id', orders.get);
router.get('/orders/:id/receipt', orders.receipt);
router.put('/orders/:id/items', orders.replaceItems);
router.post('/orders/:id/pay', idempotency(), orders.pay);                              // debt settlement: admin only (orderService)
router.post('/orders/:id/cancel', idempotency(), orders.cancel);
router.post('/orders/:id/resend-receipt', orders.resendReceipt);

router.use(apiFinanceRoutes(admin));                                      // /expenses, /expense-categories, /finance/dashboard, /tax/*: admin only (guard per route)

router.use('/heli', heliRoutes);                                          // voice assistant; the database tool is admin-only inside services/heli/agent.js

// ---- management screens: admins only, guarded once ----------------------------
router.use('/admin', admin, apiAdminRoutes);

module.exports = router;
