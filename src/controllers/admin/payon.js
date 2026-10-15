const axios = require('axios');
const QRCode = require('qrcode');
const env = require('../../config/env');
const settingsModel = require('../../models/settingsModel');
const payonModel = require('../../models/payonModel');
const payonConfig = require('../../services/payon/payonConfig');
const payonClient = require('../../services/payon/payonClient');
const payonService = require('../../services/payon/payonService');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/httpError');
const v = require('../../utils/validate');

/** Web Admin side of PayOn QR payments: the Settings section and the QR block of an order. */

const BANKS_KEY = 'payon.banks';

/** The bank list saved by the last "Kiểm tra kết nối". */
async function savedBanks() {
  try {
    const raw = (await settingsModel.getByPrefix(BANKS_KEY))[BANKS_KEY];
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((b) => b && typeof b.code === 'string') : [];
  } catch (_) {
    return [];
  }
}

/** Everything the Settings page needs for the PayOn section. */
async function settingsPanel() {
  return { config: await payonConfig.view(), banks: await savedBanks(), ipnUrl: env.publicBaseUrl ? `${env.publicBaseUrl}/api/payon/ipn` : '' };
}

async function saveSettings(req) {
  const body = { ...req.body };
  // the bank name is shown next to the code: take it from the saved list so a forged form cannot put text there
  const bank = (await savedBanks()).find((b) => b.code === body.bankCode);
  body.bankName = bank ? bank.name : '';
  if (body.bankCode && !bank) throw new AppError(400, 'VALIDATION', 'Ngân hàng QR không nằm trong danh sách PayOn. Bấm "Kiểm tra kết nối" để tải lại danh sách.');
  const cfg = await payonConfig.save(body, req.user.id);
  return { message: cfg.ready ? 'Đã lưu và bật thanh toán QR PayOn.' : 'Đã lưu cấu hình PayOn (chưa bật).', to: '/admin/settings' };
}

/** Calls PayOn with the saved settings: proves the keys, the checksum and the server IP are accepted, and loads the QR banks. */
async function testConnection(req) {
  const cfg = await payonConfig.get();
  if (!cfg.complete) throw new AppError(400, 'VALIDATION', 'Lưu đủ APP_ID, MC_ID, MC_AUTH_USER, MC_AUTH_PASS và MC_SECRET_KEY trước khi kiểm tra.');
  const banks = await payonClient.qrBanks(cfg);
  if (!banks.length) throw new AppError(502, 'PAYON_ERROR', 'Kết nối được PayOn nhưng không có ngân hàng nào hỗ trợ QR cho tài khoản này.');
  await settingsModel.setMany({ [BANKS_KEY]: JSON.stringify(banks) }, req.user.id);
  return { message: `Kết nối PayOn (${cfg.env === 'production' ? 'thật' : 'thử nghiệm'}) thành công: ${banks.length} ngân hàng hỗ trợ QR. Chọn ngân hàng nhận tiền rồi lưu.`, to: '/admin/settings' };
}

/** The address PayOn sees our calls come from (the one NextPay must declare). */
async function showServerIp() {
  let ip = '';
  try {
    const res = await axios.get('https://api.ipify.org?format=json', { timeout: 8000 });
    ip = String(res.data && res.data.ip || '');
  } catch (err) {
    logger.warn('Could not read the server IP', err);
  }
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw new AppError(502, 'IP_UNKNOWN', 'Không xác định được IP máy chủ lúc này. Thử lại sau.');
  return { message: `IP máy chủ gọi ra ngoài: ${ip}. Gửi địa chỉ này cho NextPay để khai báo (nếu PayOn báo lỗi 02).`, to: '/admin/settings' };
}

// ------------------------------------------------------------------------------------------------------- orders

/** Safe `src` for a base64 QR picture PayOn sent (digits, letters, + / = only), or ''. */
function imageSrc(b64) {
  const s = String(b64 || '').replace(/^data:image\/(png|jpeg|jpg);base64,/i, '').replace(/\s+/g, '');
  return s && /^[A-Za-z0-9+/]+={0,2}$/.test(s) ? `data:image/png;base64,${s}` : '';
}

/** The QR block of an order page: null when PayOn is off, else the latest payment and the QR to draw. */
async function orderPanel(orderId) {
  const cfg = await payonConfig.get();
  if (!cfg.ready) return { ready: false, configured: cfg.complete || cfg.enabled, payment: null };
  const rows = await payonModel.listForOrder(orderId, 1);
  const payment = payonService.publicView(rows[0] || null);
  let qrSvg = '';
  let qrSrc = '';
  if (payment && payment.open) {
    qrSrc = imageSrc(payment.qrImage);
    if (!qrSrc && payment.qrPay) qrSvg = await QRCode.toString(payment.qrPay, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' });
  }
  return { ready: true, configured: true, payment, qrSvg, qrSrc };
}

async function createOrderQr(req) {
  const id = v.id(req.params.id);
  await payonService.createOrderQr(id, { userId: req.user.id });
  return { message: 'Đã tạo mã QR PayOn. Khách quét để thanh toán; đơn tự được thu khi tiền về.', to: `/admin/orders/${id}` };
}

/** Asks PayOn about the payment and applies the answer. */
async function refresh(req) {
  const payment = await payonService.refresh(v.id(req.params.id));
  const row = await payonModel.getById(v.id(req.params.id));
  const to = row && row.order_id ? `/admin/orders/${row.order_id}` : '/admin/orders';
  const text = { paid: 'Đã nhận tiền và ghi nhận vào đơn.', pending: 'Chưa thấy khách thanh toán.', manual: 'Đã nhận tiền nhưng cần xử lý tay (xem ghi chú).', expired: 'QR đã hết hạn.', failed: 'Giao dịch thất bại.' };
  return { message: text[payment.status] || 'Đã kiểm tra.', to };
}

/** GET JSON for the order page's polling: PayOn is asked, so the page reloads itself the moment the money is applied. */
async function status(req, res) {
  const payment = await payonService.refresh(v.id(req.params.id));
  res.set('Cache-Control', 'no-store');
  res.json({ status: payment.status, open: payment.open });
}

module.exports = { settingsPanel, saveSettings, testConnection, showServerIp, orderPanel, createOrderQr, refresh, status, imageSrc };
