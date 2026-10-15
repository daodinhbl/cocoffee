const bcrypt = require('bcryptjs');
const env = require('../../config/env');
const userModel = require('../../models/userModel');
const backupService = require('../../services/backupService');
const { AppError } = require('../../utils/httpError');
const logger = require('../../utils/logger');
const { render } = require('./common');

async function page(_req, res) {
  const [files, config] = await Promise.all([backupService.list(), backupService.getSettings()]);
  await render(res, 'backup', {
    title: 'Sao lưu & khôi phục', activeMenu: 'backup',
    breadcrumbs: [{ label: 'Hệ thống', href: '#' }, { label: 'Sao lưu & khôi phục' }],
  }, {
    files: files.map((f) => ({ ...f, when: f.createdAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }), mb: (f.size / 1048576).toFixed(2) })),
    config,
    autoWhen: backupService.lastAuto.at ? backupService.lastAuto.at.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) : '',
    kinds: backupService.KINDS,
    intervals: backupService.INTERVALS,
    totalSize: files.reduce((s, f) => s + f.size, 0),
    busy: backupService.isBusy(),
    lastAuto: backupService.lastAuto,
    backupDir: env.backupDir,
    maxUploadMb: Math.round(backupService.MAX_UPLOAD_BYTES / 1024 / 1024),
  });
}

async function create() {
  const b = await backupService.createStored('manual');
  return { message: `Đã tạo bản sao lưu ${b.name} (${b.tables} bảng, ${b.rows} dòng).`, to: '/admin/backup' };
}

/** Fresh dump straight to the browser; nothing is kept on the server. */
async function downloadNow(_req, res, next) {
  let tmp;
  try {
    tmp = await backupService.createTemp();
  } catch (err) {
    if (err instanceof AppError) { res.flash('error', err.message); return res.redirect(303, '/admin/backup'); }
    return next(err);
  }
  return res.download(tmp.file, tmp.name, (err) => {
    tmp.cleanup();
    if (err && !res.headersSent) next(err);
  });
}

function downloadFile(req, res, next) {
  try {
    const file = backupService.pathOf(req.params.name);
    return res.download(file, req.params.name, (err) => { if (err && !res.headersSent) next(err.code === 'ENOENT' ? new AppError(404, 'NOT_FOUND', 'Không tìm thấy bản sao lưu này.') : err); });
  } catch (err) { return next(err); }
}

async function saveSettings(req) {
  await backupService.saveSettings(req.body, req.user.id);
  return { message: 'Đã lưu cấu hình sao lưu tự động.', to: '/admin/backup' };
}

async function remove(req) {
  await backupService.remove(req.params.name);
  return { message: 'Đã xóa bản sao lưu.', to: '/admin/backup' };
}

async function restore(req) {
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 200) : '';
  const me = await userModel.findByUsername(req.user.username);
  if (!me || !password || !(await bcrypt.compare(password, me.password_hash))) throw new AppError(400, 'VALIDATION', 'Mật khẩu xác nhận không đúng.');
  const r = await backupService.restore(req.params.name);
  const extra = r.untouched.length ? ` Giữ nguyên các bảng không có trong bản sao lưu: ${r.untouched.join(', ')}.` : '';
  return { message: `Đã khôi phục ${r.tables} bảng. Bản trước khi khôi phục được lưu là ${r.snapshot}.${extra}`, to: '/admin/backup' };
}

/** POST raw body (the file). Answers JSON because the page uploads it with fetch(). */
async function upload(req, res) {
  try {
    const name = await backupService.storeUpload(Buffer.isBuffer(req.body) ? req.body : null);
    res.flash('success', `Đã nhận file và kiểm tra hợp lệ: ${name}. Bấm "Khôi phục" ở danh sách để áp dụng.`);
    return res.json({ ok: true, name });
  } catch (err) {
    if (!(err instanceof AppError)) logger.error('Backup upload failed', err);
    return res.status(err instanceof AppError ? err.status : 500).json({ ok: false, error: err instanceof AppError ? err.message : 'Không xử lý được file.' });
  }
}

module.exports = { page, create, downloadNow, downloadFile, saveSettings, remove, restore, upload };
