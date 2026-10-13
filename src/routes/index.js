const express = require('express');
const { requireAuth, requireRole } = require('../middlewares/auth');
const rateLimit = require('../middlewares/rateLimit');
const zaloWebhookRoutes = require('../webhooks/zalo/zaloWebhookRoutes');

const auth = require('../controllers/authController');
const tables = require('../controllers/tableController');
const menu = require('../controllers/menuController');
const inventory = require('../controllers/inventoryController');
const orders = require('../controllers/orderController');

const router = express.Router();
const admin = requireRole('admin');

// ---- public ---------------------------------------------------------------
router.use('/zalo', zaloWebhookRoutes);                                   // POST /api/zalo/webhook (signature-verified, no JWT)
router.post('/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), auth.login);

// ---- everything below needs a bearer token ----------------------------------
router.use(requireAuth);
router.get('/auth/me', auth.me);
router.post('/auth/change-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => `pw:${req.user.id}` }), auth.changePassword);

router.get('/tables', tables.list);
router.post('/tables', admin, tables.create);
router.put('/tables/:id', admin, tables.update);

router.get('/categories', menu.listCategories);
router.post('/categories', admin, menu.createCategory);
router.put('/categories/:id', admin, menu.updateCategory);
router.get('/products', menu.listProducts);
router.get('/products/:id', menu.getProduct);
router.post('/products', admin, menu.createProduct);
router.put('/products/:id', admin, menu.updateProduct);

router.get('/inventory', inventory.list);
router.post('/inventory', admin, inventory.create);
router.put('/inventory/:id', admin, inventory.update);
router.post('/inventory/:id/receive', admin, inventory.receive);
router.post('/inventory/:id/adjust', admin, inventory.adjust);
router.get('/inventory/:id/movements', admin, inventory.movements);

router.get('/orders/summary', admin, orders.summary);                    // before /orders/:id
router.get('/orders', orders.list);
router.post('/orders', orders.create);
router.get('/orders/:id', orders.get);
router.put('/orders/:id/items', orders.replaceItems);
router.post('/orders/:id/pay', orders.pay);
router.post('/orders/:id/cancel', orders.cancel);
router.post('/orders/:id/resend-receipt', orders.resendReceipt);

module.exports = router;
