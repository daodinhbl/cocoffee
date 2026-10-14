const env = require('../../config/env');
const { tokenModel } = require('../../models/zaloModel');
const adminModel = require('../../models/adminModel');
const logger = require('../../utils/logger');
const zaloConfig = require('./zaloConfig');

/**
 * Header indicator (Web Admin header, POS screen, GET /api/zalo/status). Honest by construction: green only when
 * the chatbot is configured AND actually working (bot: an event in the last 24 h; OA: an OAuth token pair stored);
 * anything else says why it is not green.
 * @returns {Promise<{state:'ok'|'warn'|'off'|'unknown', label:string}>}
 */
async function zaloStatus() {
  const zcfg = await zaloConfig.get();
  if (zcfg.mode !== 'oa') {
    if (!zcfg.botWebhookSecret || (zcfg.mode === 'platform' && !zcfg.botToken)) return { state: 'off', label: 'Zalo bot: chưa cấu hình' };
    try {
      const { lastEventAt } = await adminModel.zaloEventStats(24);
      const fresh = lastEventAt && Date.now() - new Date(lastEventAt).getTime() < 24 * 3600 * 1000;
      return fresh ? { state: 'ok', label: 'Zalo bot OK' } : { state: 'warn', label: 'Zalo bot: chưa nhận tin' };
    } catch (err) {
      logger.warn('Admin header: could not read Zalo bot state', err);
      return { state: 'unknown', label: 'Zalo bot: không rõ' };
    }
  }
  if (!env.zalo.appId || !env.zalo.oaSecretKey) return { state: 'off', label: 'Zalo: chưa cấu hình' };
  try {
    const row = await tokenModel.get(null);
    return row ? { state: 'ok', label: 'Zalo OK' } : { state: 'warn', label: 'Zalo: chưa cấp quyền' };
  } catch (err) {
    logger.warn('Admin header: could not read Zalo token state', err);
    return { state: 'unknown', label: 'Zalo: không rõ' };
  }
}

module.exports = { zaloStatus };
