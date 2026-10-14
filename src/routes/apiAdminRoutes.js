const express = require('express');

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
router.get('/dashboard', analytics.dashboard);
router.get('/reports', analytics.reports);

router.get('/customers', customers.list);
router.post('/customers', customers.create);
router.get('/customers/reconciliation', customers.reconciliation);        // before /customers/:id
router.get('/customers/:id', customers.detail);
router.put('/customers/:id', customers.update);
router.get('/customers/:id/statement', customers.statement);
router.post('/customers/:id/collect', customers.collect);
router.post('/customers/:id/adjust', customers.adjust);

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

router.get('/settings', settings.get);
router.put('/settings/printer', settings.savePrinter);
router.get('/users', settings.listUsers);
router.post('/users', settings.createUser);
router.put('/users/:id/password', settings.resetPassword);
router.put('/users/:id/active', settings.setActive);

module.exports = router;
