const bcrypt = require('bcryptjs');
const tenantContext = require('../../config/tenantContext');
const userModel = require('../../models/userModel');
const accountDeletion = require('../../services/accountDeletion');
const { AppError } = require('../../utils/httpError');
const { isDemoAccount } = require('../admin/authPages');

/**
 * The app's Cài đặt > "Xóa tài khoản" (Google Play: an app that creates accounts must let people delete them in the app).
 * Only a shop created by sign-up can be deleted this way, and only by an admin of that shop.
 */

/** GET /api/account -> { deletable, shop, grace_days, reason? } */
function info(req, res) {
  const shop = tenantContext.current();
  const admin = req.user.role === 'admin';
  res.json({
    deletable: Boolean(shop) && admin,
    shop: shop ? { slug: shop.slug, name: shop.name } : null,
    grace_days: accountDeletion.GRACE_DAYS,
    reason: !shop ? 'not_signup_shop' : admin ? null : 'not_admin',
  });
}

/** POST /api/account/delete { password, confirm: <slug> } -> { ok, slug, delete_after, grace_days } */
async function remove(req, res) {
  const shop = tenantContext.current();
  if (!shop) {
    throw new AppError(409, 'ACCOUNT_NOT_DELETABLE', 'This shop was not created by sign-up; its owner deletes the data on the server');
  }
  if (req.user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only an admin of the shop can delete it');
  const password = String(req.body?.password ?? '');
  if (String(req.body?.confirm ?? '').trim().toLowerCase() !== shop.slug) {
    throw new AppError(400, 'VALIDATION', `Gõ đúng "${shop.slug}" để xác nhận xóa quán.`, { field: 'confirm' });
  }
  const user = await userModel.findByUsername(req.user.username);
  if (!user || isDemoAccount(user)) throw new AppError(403, 'DEMO_ACCOUNT', 'The demo account cannot be deleted');
  if (!(await bcrypt.compare(password, user.password_hash))) throw new AppError(401, 'BAD_CREDENTIALS', 'Password is wrong');
  const r = await accountDeletion.request(shop.id);
  res.json({ ok: true, ...r });
}

module.exports = { info, remove };
