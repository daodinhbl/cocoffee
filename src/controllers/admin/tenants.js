const tenantModel = require('../../models/tenantModel');
const tenantService = require('../../services/tenantService');
const env = require('../../config/env');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');
const { render } = require('./common');

const STATUS = { pending: ['Chờ cấp DB', 'warn'], active: ['Đang hoạt động', 'good'], suspended: ['Tạm ngưng', 'bad'] };

/** Only the main shop runs the registry, and only when TENANT_BASE_DOMAIN is set. */
function guard(req) {
  if (!tenantService.enabled() || req.tenant) throw new AppError(404, 'NOT_FOUND', 'Trang này không tồn tại.');
}

/** Admin > Đăng ký quán: every registered shop with its status and database, the pool of spare databases, and the actions. */
async function page(req, res) {
  guard(req);
  const [shops, dbs] = await Promise.all([tenantModel.list(), tenantModel.listDbs()]);
  const free = dbs.filter((d) => !d.tenant_id).length;
  const count = (s) => shops.filter((t) => t.status === s).length;
  await render(res, 'tenants', {
    title: 'Đăng ký quán', activeMenu: 'tenants', breadcrumbs: [{ label: 'Hệ thống', href: '#' }, { label: 'Đăng ký quán' }],
  }, {
    shops, dbs, free, statusText: STATUS, base: env.tenancy.baseDomain, signupOpen: env.tenancy.signupOpen,
    counts: { total: shops.length, pending: count('pending'), active: count('active'), suspended: count('suspended') },
    urlOf: tenantService.urlOf,
  });
}

/** Registers an empty spare database, then finishes any waiting sign-up with it. The password is never echoed or logged. */
async function addDb(req) {
  guard(req);
  const b = req.body;
  await tenantService.addDatabase({
    host: v.str(b.host, 'Máy chủ DB', { max: 120 }), port: v.num(b.port || 3306, 'Cổng', { min: 1, max: 65535, integer: true }),
    name: v.str(b.name, 'Tên database', { max: 64 }), user: v.str(b.user, 'Người dùng DB', { max: 64 }),
    password: v.str(b.password, 'Mật khẩu DB', { max: 200 }), note: v.str(b.note, 'Ghi chú', { max: 120, required: false }),
  });
  const done = await tenantService.provisionPending();
  return { message: done ? `Đã thêm database và hoàn tất ${done} quán đang chờ.` : 'Đã thêm database trống.' };
}

async function provision(req) {
  guard(req);
  const t = await tenantModel.findById(v.id(req.params.id));
  if (!t) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy quán.');
  const r = await tenantService.provision(t.id);
  return { message: r === 'active' ? `Quán ${t.slug} đã sẵn sàng.` : `Quán ${t.slug} vẫn đang chờ${(await tenantModel.findById(t.id)).error ? ': xem cột lỗi' : ''}.` };
}

async function setStatus(req) {
  guard(req);
  const t = await tenantModel.findById(v.id(req.params.id));
  if (!t) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy quán.');
  const to = v.oneOf(req.body.status, 'Trạng thái', ['suspended', 'active']);
  if (to === 'active' && !t.db_id) throw new AppError(409, 'CONFLICT', 'Quán chưa có database nên chưa mở được: bấm “Cấp DB” trước.');
  await tenantModel.setStatus(t.id, to);
  tenantService.forget(t.slug);
  return { message: to === 'suspended' ? `Đã tạm ngưng ${t.slug}.` : `Đã mở lại ${t.slug}.` };
}

module.exports = { page, addDb, provision, setStatus };
