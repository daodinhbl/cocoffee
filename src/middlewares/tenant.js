const tenantContext = require('../config/tenantContext');
const tenantService = require('../services/tenantService');
const logger = require('../utils/logger');

const PAGE = (title, text) => `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;background:#FAF8F5;color:#1f1f1f;font:16px/1.6 Georgia,serif;display:grid;place-items:center;min-height:100vh}main{max-width:30rem;padding:2rem;text-align:center}h1{color:#172554;font-size:1.4rem}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

/**
 * Picks the shop for the request from its Host header (<slug>.<TENANT_BASE_DOMAIN>). The main site, an unrelated host
 * (localhost, the hosting provider's temporary domain) and every install without TENANT_BASE_DOMAIN stay on the default
 * database. From here on, everything the request does (db.js, per-shop caches, tokens) runs inside that shop.
 */
async function tenantResolver(req, res, next) {
  const slug = tenantService.slugOfHost(req.hostname);
  if (!slug || slug === require('../config/env').tenancy.defaultSlug) return next();
  let t;
  try {
    t = await tenantService.resolve(slug);
  } catch (err) {
    logger.error('Tenant lookup failed', err);
    return res.status(503).type('html').send(PAGE('Hệ thống đang bận', 'Vui lòng thử lại sau ít phút.'));
  }
  if (!t) return res.status(404).type('html').send(PAGE('Không tìm thấy quán', 'Địa chỉ này chưa được đăng ký. Kiểm tra lại tên miền phụ hoặc đăng ký quán mới.'));
  if (t === 'pending') return res.status(503).type('html').send(PAGE('Quán đang được chuẩn bị', 'Tài khoản đã đăng ký và đang chờ cấp cơ sở dữ liệu. Chúng tôi sẽ liên hệ khi sẵn sàng.'));
  if (t === 'deleting') return res.status(410).type('html').send(PAGE('Quán đã yêu cầu xóa', 'Chủ quán đã yêu cầu xóa tài khoản và toàn bộ dữ liệu của quán này. Dữ liệu sẽ bị xóa vĩnh viễn khi hết thời hạn chờ.'));
  if (t === 'suspended') return res.status(403).type('html').send(PAGE('Quán tạm ngưng', 'Quán này đang tạm ngưng hoạt động. Vui lòng liên hệ quản trị hệ thống.'));
  req.tenant = t;
  return tenantContext.run(t, () => next());
}

module.exports = { tenantResolver };
