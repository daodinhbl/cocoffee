const env = require('../../config/env');
const { tokenModel } = require('../../models/zaloModel');
const inventoryModel = require('../../models/inventoryModel');
const adminModel = require('../../models/adminModel');
const { AppError } = require('../../utils/httpError');
const { safeBack } = require('../../middlewares/adminAuth');
const { ago } = require('../../utils/shopTime');
const logger = require('../../utils/logger');

/**
 * Header indicator. Honest by construction: green only when the OA is configured AND an OAuth
 * token pair is stored; anything else says why it is not green.
 * @returns {Promise<{state:'ok'|'warn'|'off'|'unknown', label:string}>}
 */
async function zaloStatus() {
  if (env.zalo.mode !== 'oa') {
    if (!env.zalo.botWebhookSecret || (env.zalo.mode === 'platform' && !env.zalo.botToken)) return { state: 'off', label: 'Zalo bot: chưa cấu hình' };
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

/** Real alerts for the bell: low stock, bills waiting to be collected, Zalo receipts that failed to send. */
async function notifications() {
  try {
    const [low, counts, failed] = await Promise.all([inventoryModel.list({ lowStockOnly: true }), adminModel.queueCounts(), adminModel.receiptErrors(3)]);
    const out = [];
    for (const e of failed) out.push({ text: `Bill Zalo gửi lỗi — ${e.order_code}`, time: ago(e.completed_at), tone: 'bad', href: `/admin/orders/${e.id}` });
    if (counts.drafts > 0) out.push({ text: `${counts.drafts} đơn Zalo chờ khách xác nhận`, time: '', tone: 'info', href: '/admin/orders?status=draft' });
    if (counts.unpaid > 0) out.push({ text: `${counts.unpaid} đơn chờ thu tiền`, time: '', tone: 'warn', href: '/admin/orders?status=completed&payment=unpaid' });
    for (const i of low.slice(0, 5)) out.push({ text: `${i.name} dưới mức tồn tối thiểu`, time: '', tone: 'warn', href: '/admin/inventory?low=1' });
    return out;
  } catch (err) {
    logger.warn('Admin header: could not load notifications', err);
    return [];
  }
}

/** Locals every admin page needs (layout + header + sidebar). */
async function shell({ title, activeMenu, breadcrumbs }) {
  const [zalo, notes] = await Promise.all([zaloStatus(), notifications()]);
  return { title, activeMenu, breadcrumbs, zalo, notifications: notes, shopName: env.business.shopName };
}

/** res.page(...) with the shell locals merged in. */
async function render(res, view, meta, locals = {}) {
  res.page(view, { ...(await shell(meta)), ...locals });
}

/** Friendly Vietnamese text for the database errors a form can realistically trigger. */
function describeError(err) {
  if (err instanceof AppError) {
    if (err.code === 'INSUFFICIENT_STOCK') return `Không đủ tồn kho: ${(err.details?.short || []).map((s) => `${s.name} (cần ${s.needed}, còn ${s.available} ${s.unit || ''})`).join('; ')}`;
    return err.message;
  }
  if (err && err.errno === 1062) return 'Giá trị này đã tồn tại (mã, tên hoặc từ khóa bị trùng).';
  if (err && (err.errno === 1451 || err.errno === 1452)) return 'Bản ghi đang được dùng ở nơi khác nên không thể thay đổi.';
  return null;
}

/**
 * POST wrapper (Post/Redirect/Get). `fn(req, res)` returns { message, to? } on success. A user-facing failure
 * (validation, business rule, duplicate key) becomes a flash error and bounces back; anything else is a real
 * bug and propagates to the error page.
 */
const act = (fn) => async (req, res) => {
  const back = safeBack(req.body?._back, '/admin/dashboard');
  try {
    const result = await fn(req, res);
    res.flash('success', result?.message || 'Đã lưu.');
    return res.redirect(303, safeBack(result?.to, back));
  } catch (err) {
    const text = describeError(err);
    if (!text) throw err;
    res.flash('error', text);
    return res.redirect(303, back);
  }
};

/** Checkbox pair (hidden "0" + checkbox "1"): undefined when absent, otherwise boolean. */
const formBool = (v) => {
  const x = Array.isArray(v) ? v[v.length - 1] : v;
  return x === undefined || x === null || x === '' ? undefined : ['1', 'on', 'true'].includes(String(x));
};
const formFlag = (v) => { const b = formBool(v); return b === undefined ? undefined : (b ? 1 : 0); };

/** Optional text input: '' -> undefined (so v.str(required:false) and COALESCE leave the column alone). */
const optional = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

module.exports = { zaloStatus, shell, render, act, describeError, formBool, formFlag, optional };
