const express = require('express');
const { adminSecurity, pageRenderer } = require('../middlewares/adminSecurity');
const { flash, loadSession, requireStaff, requireAdmin, requireCsrf, requireCsrfHeader } = require('../middlewares/adminAuth');
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
const pos = require('../controllers/admin/pos');
const suppliers = require('../controllers/admin/suppliers');
const receipts = require('../controllers/admin/receipts');
const expenses = require('../controllers/admin/expenses');
const tax = require('../controllers/admin/tax');
const tenants = require('../controllers/admin/tenants');
const customers = require('../controllers/admin/customers');
const payon = require('../controllers/admin/payon');
const backup = require('../controllers/admin/backup');
const backupService = require('../services/backupService');

const router = express.Router();

// Server-rendered Web Admin (EJS + Tailwind CDN + vanilla JS). Every page except /login needs an admin session;
// every POST needs the session's CSRF token (see middlewares/adminAuth.js).
router.use(adminSecurity, pageRenderer, express.urlencoded({ extended: false, limit: '1mb' }), flash, loadSession);

router.get('/login', auth.loginForm);
router.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }), rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: rateLimit.accountKey }), auth.login);
router.get('/forgot', auth.forgotForm);
router.post('/forgot', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), auth.forgot);

// POS screen: admins and cashiers. JSON endpoints echo the session CSRF token in the body (_csrf).
router.post('/logout', requireStaff, requireCsrf, auth.logout);
router.get('/pos', requireStaff, pos.page);
router.get('/pos/orders/:id', requireStaff, pos.openOrder);
router.get('/pos/transfer-qr', requireStaff, pos.transferQr);
router.get('/pos/history', requireStaff, pos.history);
router.get('/pos/history/:id', requireStaff, pos.historyOrder);
router.get('/pos/shift', requireStaff, pos.json(pos.shiftPreview));
router.post('/pos/shift/close', requireStaff, requireCsrf, pos.json(pos.shiftClose));
router.get('/pos/shift/:id/print', requireStaff, pos.shiftPrint);
router.get('/pos/receipt/sample', requireStaff, pos.sampleReceipt);
router.get('/pos/receipt/:id', requireStaff, pos.receipt);
router.post('/pos/checkout', requireStaff, requireCsrf, pos.json(pos.checkout));
router.post('/pos/hold', requireStaff, requireCsrf, pos.json(pos.hold));
router.post('/pos/cancel', requireStaff, requireCsrf, pos.json(pos.cancelOrder));
router.post('/pos/prepay', requireStaff, requireCsrf, pos.json(pos.prepay));
router.post('/pos/tables/merge', requireStaff, requireCsrf, pos.json(pos.mergeTables));
router.post('/pos/tables/unmerge', requireStaff, requireCsrf, pos.json(pos.unmergeTable));
router.post('/pos/split', requireStaff, requireCsrf, pos.json(pos.splitOrder));

// Backup upload: the body is the file itself (raw), so the CSRF token comes in a header instead of a form field.
const rawBackup = express.raw({ type: () => true, limit: backupService.MAX_UPLOAD_BYTES });
router.post('/backup/upload', requireAdmin, requireCsrfHeader, (req, res, next) => rawBackup(req, res, (err) => (
  err ? res.status(err.status === 413 ? 413 : 400).json({ ok: false, error: err.status === 413 ? 'File quá lớn.' : 'Không đọc được file tải lên.' }) : next()
)), backup.upload);

// Excel import of the ingredient list: raw .xlsx body, CSRF in a header (same scheme as the backup upload).
const rawXlsx = express.raw({ type: () => true, limit: '5mb' });
router.post('/inventory/import', requireAdmin, requireCsrfHeader, (req, res, next) => rawXlsx(req, res, (err) => (
  err ? res.status(err.status === 413 ? 413 : 400).json({ ok: false, error: err.status === 413 ? 'File quá lớn (tối đa 5 MB).' : 'Không đọc được file tải lên.' }) : next()
)), inventory.importXlsx);

router.post('/tables/layout', requireAdmin, requireCsrfHeader, tables.saveLayout);   // floor-plan drag & drop: JSON body, CSRF in a header

router.use(requireAdmin, requireCsrf);
router.use((req, res, next) => { res.locals.tenantAdmin = require('../services/tenantService').enabled() && !req.tenant; next(); });   // sidebar: "Đăng ký quán" on the main shop only

router.get('/', (_req, res) => res.redirect(302, '/admin/dashboard'));
router.get('/dashboard', dashboard.dashboard);

router.get('/tables', tables.page);
router.get('/tables/map', tables.mapPage);
router.post('/tables', act(tables.create));
router.post('/tables/:id', act(tables.update));

router.get('/orders', orders.list);
router.get('/orders/:id', orders.detail);
router.post('/orders/:id/cancel', act(orders.cancel));
router.post('/orders/:id/pay', act(orders.pay));
router.post('/orders/:id/record-debt', act(orders.recordDebt));
router.post('/orders/:id/payon-qr', act(payon.createOrderQr));
router.get('/payon', payon.listPage);
router.post('/payon/:id/refresh', act(payon.refresh));
router.post('/payon/:id/apply', act(payon.applyAgain));
router.post('/payon/:id/resolve', act(payon.resolveManual));
router.get('/payon/:id/status', payon.status);
router.post('/orders/:id/resend-receipt', act(orders.resendReceipt));

router.get('/customers', customers.list);
router.get('/customers/new', customers.newForm);
router.get('/customers/reconciliation', customers.reconciliation);
router.get('/customers/:id/statement', customers.statementPage);
router.post('/customers', act(customers.create));
router.get('/customers/:id', customers.detail);
router.get('/customers/:id/edit', customers.editForm);
router.post('/customers/:id', act(customers.update));
router.post('/customers/:id/zalo', act(customers.linkZalo));
router.post('/customers/:id/collect', act(customers.collect));
router.post('/customers/:id/adjust', act(customers.adjust));


router.get('/menu', menu.page);
router.post('/menu/categories', act(menu.createCategory));
router.post('/menu/categories/:id', act(menu.updateCategory));
router.post('/menu/products', act(menu.createProduct));
router.post('/menu/products/:id', act(menu.updateProduct));

router.get('/inventory', inventory.page);
router.post('/inventory', act(inventory.create));
router.get('/inventory/export.xlsx', inventory.exportXlsx);
router.get('/inventory/template.xlsx', inventory.templateXlsx);
router.get('/inventory/:id', inventory.detail);
router.post('/inventory/:id', act(inventory.update));
router.post('/inventory/:id/adjust', act(inventory.adjust));

router.get('/receiving', inventory.receivingPage);
router.post('/receiving', act(inventory.receive));
router.get('/tax', tax.page);
router.post('/tax/lock', act(tax.lock));
router.post('/tax/unlock', act(tax.unlock));
router.post('/tax/filed', act(tax.filed));
router.post('/tax/config', act(tax.saveConfig));
router.post('/tax/rates', act(tax.addRate));
router.post('/tax/exports', act(tax.createExport));
router.get('/tax/exports.json', tax.exportsJson);
router.get('/tax/exports/:id/file', tax.download);
router.get('/expenses', expenses.list);
router.post('/expenses', act(expenses.create));
router.get('/expenses/:id/receipt', expenses.receipt);
router.post('/expenses/:id', act(expenses.update));
router.post('/expenses/:id/void', act(expenses.voidOne));
router.get('/expense-categories', expenses.categories);
router.post('/expense-categories', act(expenses.createCategory));
router.post('/expense-categories/:id', act(expenses.updateCategory));
router.get('/receipts', receipts.list);
router.get('/receipts/:id', receipts.detail);
router.post('/receipts/:id/pay', act(receipts.pay));
router.get('/tenants', tenants.page);
router.post('/tenants/databases', act(tenants.addDb));
router.post('/tenants/:id/provision', act(tenants.provision));
router.post('/tenants/:id/status', act(tenants.setStatus));
router.get('/suppliers', suppliers.page);
router.post('/suppliers', act(suppliers.create));
router.get('/suppliers/:id', suppliers.detail);
router.post('/suppliers/:id', act(suppliers.update));
router.post('/suppliers/:id/pay', act(suppliers.pay));

router.get('/bom-recipes', bom.page);
router.post('/bom-recipes', act(bom.create));
router.post('/bom-recipes/:id', act(bom.update));
router.post('/bom-recipes/:id/delete', act(bom.remove));

router.get('/reports', reports.page);

router.get('/zalo', zalo.page);
router.post('/zalo/orders/:id/resend-receipt', act(zalo.resendReceipt));
router.post('/zalo/register-webhook', act(zalo.registerWebhook));
router.post('/zalo/bot-token', act(zalo.saveBotToken));
router.post('/zalo/debt-recipient', act(zalo.saveDebtRecipient));
router.post('/zalo/chatbot-info', act(zalo.saveChatbotInfo));

router.get('/settings', settings.page);
router.get('/settings/password', settings.page);
router.post('/settings/password', act(auth.changeOwnPassword));
router.post('/settings/recovery-code', auth.newRecoveryCode);
router.post('/settings/printer', act(settings.savePrinter));
router.post('/settings/shop', act(settings.saveShop));
router.post('/settings/public-url', act(settings.savePublicUrl));
router.post('/settings/heli', act(settings.saveHeli));
const dbConnLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
router.post('/settings/db/test', dbConnLimit, act(settings.testDb));
router.post('/settings/db/save', dbConnLimit, act(settings.saveDb));
router.post('/settings/db/reset', dbConnLimit, act(settings.resetDb));
router.post('/settings/db/restart', dbConnLimit, act(settings.restartApp));
router.post('/settings/heli/test', act(settings.testHeli));
router.post('/settings/ios-app', act(settings.saveIosApp));
router.post('/settings/payon', act(payon.saveSettings));
router.post('/settings/payon/test', act(payon.testConnection));
router.post('/settings/payon/ip', act(payon.showServerIp));
router.post('/settings/users', act(settings.createUser));
router.post('/settings/users/:id/password', act(settings.resetPassword));
router.post('/settings/users/:id/active', act(settings.setActive));

router.get('/backup', backup.page);
router.post('/backup/create', act(backup.create));
router.get('/backup/download', backup.downloadNow);
router.get('/backup/files/:name', backup.downloadFile);
router.post('/backup/settings', act(backup.saveSettings));
router.post('/backup/mail', act(backup.saveMail));
router.post('/backup/mail/test', act(backup.testMail));
router.post('/backup/files/:name/delete', act(backup.remove));
router.post('/backup/files/:name/restore', act(backup.restore));

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
