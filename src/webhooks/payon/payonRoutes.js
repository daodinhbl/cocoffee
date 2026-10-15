const express = require('express');
const rateLimit = require('../../middlewares/rateLimit');
const logger = require('../../utils/logger');
const payonService = require('../../services/payon/payonService');

const router = express.Router();

// Mounted at /api/payon  =>  POST https://<domain>/api/payon/ipn is the "url_notify" given to PayOn for every QR.
// Public: authenticated by the checksum PayOn computes with the merchant secret (see payonCrypto.verifyNotification).
router.post('/ipn', rateLimit({ windowMs: 60 * 1000, max: 120 }), async (req, res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || !('checksum' in req.body)) {
      logger.warn(`PayOn notification without a JSON checksum (content-type ${req.get('content-type') || 'none'}, from ${req.ip})`);
      return res.status(400).json({ error_code: '05', error_message: 'Invalid body' });
    }
    const out = await payonService.handleNotification({ body: req.body, rawBody: req.rawBody, ip: req.ip });
    return res.status(out.status).json(out.body);
  } catch (err) {
    return next(err);
  }
});

// PayOn (or a person) opening the URL to see that it is reachable.
router.get('/ipn', (_req, res) => res.json({ ok: true }));

module.exports = router;
