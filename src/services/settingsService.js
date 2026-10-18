const env = require('../config/env');

/** Read-only system configuration shown on Web Admin > Cài đặt and by GET /api/admin/settings (no secrets). */
function systemConfig() {
  return {
    publicBaseUrl: env.publicBaseUrl || '',
    publicBaseUrlSource: env.publicUrlOverride.value ? 'settings' : (env.publicUrlEnv ? 'env' : ''),   // who set it: the saved setting wins over PUBLIC_BASE_URL
    publicBaseUrlEnv: env.publicUrlEnv || '',
    allowNegativeStock: env.business.allowNegativeStock,
    draftTtlMinutes: env.zalo.draftTtlMinutes,
    verifySignature: env.zalo.verifySignature,
    receiptImage: env.receiptImage.enabled,
    timezone: env.db.timezone,
    sessionHours: env.jwt.expiresIn,
  };
}

module.exports = { systemConfig };
