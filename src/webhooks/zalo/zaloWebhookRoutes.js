const express = require('express');
const rateLimit = require('../../middlewares/rateLimit');
const zaloConfig = require('../../services/zalo/zaloConfig');
const bot = require('./botWebhookController');
const platform = require('./platformWebhookController');
const oa = require('./zaloWebhookController');

const router = express.Router();
const controllers = { platform, bot, oa };

// Mounted at /api/zalo  =>  POST https://cocoffee.tasotek-giaiphapso.com/api/zalo/webhook
// platform: official Zalo Bot Platform | bot: personal-account Bot Client | oa: legacy OA.
// Chosen per request because the bot token can be entered in the Web Admin while the app runs.
const dispatch = (name) => async (req, res, next) => {
  try {
    const { mode } = await zaloConfig.get();
    return controllers[mode][name](req, res, next);
  } catch (err) {
    return next(err);
  }
};

router.post('/webhook', rateLimit({ windowMs: 60 * 1000, max: 120 }), dispatch('handle'));
router.get('/webhook', dispatch('ping'));

module.exports = router;
