const express = require('express');
const controller = require('./zaloWebhookController');

const router = express.Router();

// Mounted at /api/zalo  =>  POST https://cocoffee.tasotek-giaiphapso.com/api/zalo/webhook
router.post('/webhook', controller.handle);
router.get('/webhook', controller.ping);

module.exports = router;
