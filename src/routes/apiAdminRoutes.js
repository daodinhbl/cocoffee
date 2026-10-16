const express = require('express');
const idempotency = require('../middlewares/idempotency');

const shell = require('../controllers/api/shellApi');
const analytics = require('../controllers/api/dashboardApi');
const customers = require('../controllers/api/customersApi');
const menu = require('../controllers/api/menuApi');
const zalo = require('../controllers/api/zaloApi');
const settings = require('../controllers/api/settingsApi');

/**
 * /api/admin/*: the management screens of the app. Mounted behind requireAuth + requireRole('admin') in routes/index.js,
 * so every route here is admin-only in one place.
 */
const router = express.Router();

router.get('/notifications', shell.notifications);
router.get('/new-orders', shell.newOrders);
router.get('/dashboard', analytics.dashboard);
router.get('/reports', analytics.reports);

router.get('/customers', customers.list);
router.post('/customers', idempotency(), customers.create);          // customers.* writes are replayed by the app's offline queue
router.get('/customers/reconciliation', customers.reconciliation);        // before /customers/:id
router.get('/customers/:id', customers.detail);
router.put('/customers/:id', idempotency(), customers.update);
router.get('/customers/:id/statement', customers.statement);
router.post('/customers/:id/collect', idempotency(), customers.collect);
router.post('/customers/:id/adjust', idempotency(), customers.adjust);
router.post('/orders/:id/record-debt', customers.recordOrderDebt);          // "Ghi công nợ" for a Zalo order

router.get('/menu', menu.menu);
router.get('/bom', menu.bom);
router.put('/products/:id/image', menu.setImage('products'));
router.delete('/products/:id/image', menu.removeImage('products'));
router.put('/inventory/:id/image', menu.setImage('inventory'));
router.delete('/inventory/:id/image', menu.removeImage('inventory'));

router.get('/zalo', zalo.overview);
router.get('/zalo/status', shell.status);
router.put('/zalo/debt-recipient', zalo.saveDebtRecipient);
router.put('/zalo/chatbot-info', zalo.saveChatbotInfo);
router.post('/zalo/register-webhook', zalo.registerWebhook);
router.put('/zalo/bot-token', zalo.saveBotToken);                                   // write-only secret: no idempotency() (it would store the response)

router.get('/settings', settings.get);
router.put('/settings/printer', settings.savePrinter);
router.put('/settings/ios-app', settings.saveIosApp);
router.put('/settings/payon', settings.savePayon);
router.post('/settings/payon/test', settings.testPayon);
router.post('/settings/payon/ip', settings.payonIp);
router.get('/users', settings.listUsers);
router.post('/users', settings.createUser);
router.put('/users/:id/password', settings.resetPassword);
router.put('/users/:id/active', settings.setActive);

module.exports = router;
