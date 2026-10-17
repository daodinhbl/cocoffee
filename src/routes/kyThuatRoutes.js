const express = require('express');
const rateLimit = require('../middlewares/rateLimit');
const leadModel = require('../models/leadModel');
const appRelease = require('../services/appRelease');
const congTrinh = require('../services/congTrinh');
const { notifyOwner } = require('../services/zalo/ownerNotice');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Public QR landing page for the technical-service side of the shop (electrics, plumbing, camera, smart home, solar).
 * Printed QR codes on tables / menu / bills point here; ?src=<where> tells which one was scanned.
 *   GET  /ky-thuat            page: services, finished jobs, request form
 *   POST /ky-thuat/lead       form submit: saves the lead and tells the owner on Zalo
 *   GET  /ky-thuat/qr.svg     QR code of the page (?src= is carried into the code)
 *   GET  /ky-thuat/bang-ban   printable A5 "bàn tư vấn kỹ thuật" sign (?src= for the QR it carries)
 */
const router = express.Router();
const pageLimit = rateLimit({ windowMs: 60 * 1000, max: 120 });
const leadLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 8 });     // per address; the shop's own wifi shares one

const NEEDS = {
  dien: 'Điện dân dụng / công nghiệp',
  nuoc: 'Điện nước, sửa chữa',
  camera: 'Camera an ninh',
  smarthome: 'Nhà thông minh',
  solar: 'Năng lượng mặt trời',
  baotri: 'Gói bảo trì định kỳ',
  khac: 'Khác',
};
const SOURCE_RE = /^[a-z0-9-]{1,30}$/;
const cleanSource = (v) => (SOURCE_RE.test(String(v ?? '')) ? String(v) : 'qr');
const cleanPhone = (v) => {
  const p = String(v ?? '').replace(/[\s.\-()]/g, '').replace(/^\+84/, '0');
  return /^0\d{9}$/.test(p) ? p : null;
};
const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const common = (req) => ({
  shopName: env.business.shopName,
  contact: env.contact,
  needs: NEEDS,
  projects: congTrinh.list(),
  src: cleanSource(req.query.src ?? req.body?.src),
});

router.get('/', pageLimit, (req, res) => res.render('ky-thuat', { ...common(req), sent: req.query.ok === '1', error: null, form: {} }));

router.post('/lead', leadLimit, express.urlencoded({ extended: false, limit: '8kb' }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const base = common(req);
    if (b.website) return res.redirect(303, '/ky-thuat?ok=1');          // honeypot field: a bot filled it, pretend success
    const form = { name: oneLine(b.name, 120), phone: oneLine(b.phone, 20), need: NEEDS[b.need] ? b.need : 'khac', note: oneLine(b.note, 500) };
    const phone = cleanPhone(b.phone);
    if (!form.name || !phone) {
      return res.status(400).render('ky-thuat', { ...base, sent: false, form, error: 'Vui lòng nhập họ tên và số điện thoại hợp lệ (10 số, bắt đầu bằng 0).' });
    }
    if (!(await leadModel.recentByPhone(phone))) {
      await leadModel.create({ name: form.name, phone, need: NEEDS[form.need], source: base.src, note: form.note });
      // Courtesy to the owner; a Zalo hiccup must not make the customer's request look failed.
      notifyOwner(`🔧 Khách mới cần dịch vụ kỹ thuật\n${form.name} · ${phone}\nNhu cầu: ${NEEDS[form.need]}${form.note ? `\nGhi chú: ${form.note}` : ''}\nNguồn QR: ${base.src}`)
        .catch((err) => logger.warn('Lead notice failed', err));
    }
    return res.redirect(303, `/ky-thuat?ok=1&src=${encodeURIComponent(base.src)}`);
  } catch (err) { return next(err); }
});

async function sendQr(req, res, next) {
  try {
    const src = cleanSource(req.query.src);
    const svg = await appRelease.qrSvg(`${appRelease.baseUrl(req)}/ky-thuat?src=${src}`);
    res.set({
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.send(svg);
  } catch (err) { next(err); }
}
router.get('/qr.svg', pageLimit, sendQr);

router.get('/bang-ban', pageLimit, (req, res) => {
  const src = cleanSource(req.query.src ?? 'ban-tu-van');
  res.render('ky-thuat-bang-ban', { shopName: env.business.shopName, contact: env.contact, src, host: appRelease.baseUrl(req).replace(/^https?:\/\//, '') });
});

module.exports = router;
