const env = require('../config/env');
const { tokenModel } = require('../models/zaloModel');
const logger = require('../utils/logger');
const sample = require('../data/adminSample');

/**
 * Header indicator. Honest by construction: green only when the OA is configured AND an OAuth
 * token pair is stored; anything else says why it is not green.
 * @returns {Promise<{state:'ok'|'warn'|'off'|'unknown', label:string}>}
 */
async function zaloStatus() {
  if (!env.zalo.appId || !env.zalo.oaSecretKey) return { state: 'off', label: 'Zalo: chưa cấu hình' };
  try {
    const row = await tokenModel.get(null);
    return row ? { state: 'ok', label: 'Zalo OK' } : { state: 'warn', label: 'Zalo: chưa cấp quyền' };
  } catch (err) {
    logger.warn('Admin header: could not read Zalo token state', err);
    return { state: 'unknown', label: 'Zalo: không rõ' };
  }
}

/** Locals every admin page needs (layout + header + sidebar). */
async function shell({ title, activeMenu, breadcrumbs }) {
  return {
    title, activeMenu, breadcrumbs,
    zalo: await zaloStatus(),
    notifications: sample.notifications,
    isSample: true,
    shopName: env.business.shopName,
  };
}

const toDashboard = (_req, res) => res.redirect(302, '/admin/dashboard');

async function dashboard(_req, res) {
  res.page('dashboard', {
    ...(await shell({ title: 'Tổng quan', activeMenu: 'dashboard', breadcrumbs: [{ label: 'Tổng quan' }] })),
    data: sample.dashboard,
  });
}

async function bomRecipes(_req, res) {
  res.page('bom_recipes', {
    ...(await shell({
      title: 'Quản lý định mức (BOM)',
      activeMenu: 'bom',
      breadcrumbs: [{ label: 'Kho & Định mức', href: '#' }, { label: 'Công thức (BOM)' }],
    })),
    drinks: sample.drinks,
    combos: sample.combos,
    stats: sample.stats,
    catalog: sample.catalog,
  });
}

module.exports = { toDashboard, dashboard, bomRecipes, zaloStatus };
