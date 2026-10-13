const express = require('express');
const env = require('../../config/env');
const rateLimit = require('../../middlewares/rateLimit');
const bot = require('./botWebhookController');
const platform = require('./platformWebhookController');
const oa = require('./zaloWebhookController');

const router = express.Router();

// Mounted at /api/zalo  =>  POST https://cocoffee.tasotek-giaiphapso.com/api/zalo/webhook
// platform: official Zalo Bot Platform (ZALO_BOT_TOKEN) | bot: personal-account Bot Client | oa: legacy OA.
const controller = { platform, bot, oa }[env.zalo.mode];
router.post('/webhook', ...(env.zalo.mode === 'oa' ? [] : [rateLimit({ windowMs: 60 * 1000, max: 120 })]), controller.handle);
router.get('/webhook', controller.ping);

module.exports = router;
