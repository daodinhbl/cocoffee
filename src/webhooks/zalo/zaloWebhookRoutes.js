const express = require('express');
const env = require('../../config/env');
const rateLimit = require('../../middlewares/rateLimit');
const bot = require('./botWebhookController');
const oa = require('./zaloWebhookController');

const router = express.Router();

// Mounted at /api/zalo  =>  POST https://cocoffee.tasotek-giaiphapso.com/api/zalo/webhook
// Default: personal-account Bot Client (BOT_WEBHOOK_SECRET). ZALO_MODE=oa keeps the legacy OA receiver.
const controller = env.zalo.mode === 'oa' ? oa : bot;
router.post('/webhook', ...(env.zalo.mode === 'oa' ? [] : [rateLimit({ windowMs: 60 * 1000, max: 120 })]), controller.handle);
router.get('/webhook', controller.ping);

module.exports = router;
