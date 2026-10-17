const express = require('express');
const idempotency = require('../middlewares/idempotency');
const finance = require('../controllers/api/financeApi');

/**
 * Expense book, tax estimate and tax-book exports for the app. Every route is admin-only: the guard is passed in
 * (routes/index.js mounts this router WITHOUT a blanket guard, so it cannot lock the routes mounted after it).
 */
module.exports = (admin) => {
  const router = express.Router();

  router.get('/expense-categories', admin, finance.categories);
  router.get('/expenses', admin, finance.listExpenses);
  router.post('/expenses', admin, idempotency(), finance.createExpense);              // replayed by the app's offline queue
  router.get('/expenses/:id/receipt', admin, finance.receipt);                       // before /expenses/:id
  router.put('/expenses/:id', admin, idempotency(), finance.updateExpense);
  router.post('/expenses/:id/void', admin, idempotency(), finance.voidExpense);

  router.get('/finance/dashboard', admin, finance.dashboard);
  router.get('/tax/rates', admin, finance.rates);
  router.post('/tax/periods/lock', admin, finance.lockPeriod);
  router.post('/tax/periods/unlock', admin, finance.unlockPeriod);
  router.post('/tax/periods/filed', admin, finance.markFiled);
  router.post('/tax/exports', admin, finance.createExport);
  router.get('/tax/exports', admin, finance.listExports);
  router.get('/tax/exports/:id', admin, finance.getExport);
  router.get('/tax/exports/:id/file', admin, finance.exportFile);
  return router;
};
