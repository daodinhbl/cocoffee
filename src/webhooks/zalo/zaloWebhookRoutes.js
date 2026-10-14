const express = require('express');
const rateLimit = require('../../middlewares/rateLimit');
const zaloConfig = require('../../services/zalo/zaloConfig');
const debtQr = require('../../services/zalo/debtQr');
const billMedia = require('../../services/zalo/billMedia');
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

// VietQR picture of a "check nợ" answer (signed, expiring link: see services/zalo/debtQr.js). Zalo fetches it.
router.get('/qr/:file', rateLimit({ windowMs: 60 * 1000, max: 60 }), async (req, res, next) => {
  try {
    const m = /^(.+)\.png$/.exec(req.params.file);
    const data = m ? debtQr.verify(m[1]) : null;
    const buf = data ? await debtQr.png(data) : null;
    if (!buf) return res.status(404).json({ ok: false, error: 'not_found' });   // bad/expired link or no bank account
    res.set({
      'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600', 'Content-Length': String(buf.length),
      'Cross-Origin-Resource-Policy': 'cross-origin',            // helmet's same-origin default would block Zalo Web
    });
    return res.end(buf);
  } catch (err) {
    return next(err);
  }
});

// Receipt PNG (80 mm) and payment VietQR of a confirmed order (signed, expiring links: services/zalo/billMedia.js).
const png = (kind) => async (req, res, next) => {
  try {
    const m = /^(.+).png$/.exec(req.params.file);
    const data = m ? billMedia.verify(m[1]) : null;
    const buf = data && data.kind === kind ? await billMedia.pngFor(data) : null;
    if (!buf) return res.status(404).json({ ok: false, error: 'not_found' });
    res.set({
      'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600', 'Content-Length': String(buf.length),
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    return res.end(buf);
  } catch (err) {
    return next(err);
  }
};
router.get('/receipt/:file', rateLimit({ windowMs: 60 * 1000, max: 60 }), png('receipt'));
router.get('/pay-qr/:file', rateLimit({ windowMs: 60 * 1000, max: 60 }), png('payQr'));

module.exports = router;
