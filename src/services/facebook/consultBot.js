/**
 * Consultation answers for the Messenger bot. Pure: text in, { text, quickReplies, phone?, wantsHuman? } out, so it can be
 * tested without Facebook. Deliberately states NO prices: a job is quoted after a survey (the shop sets the numbers).
 */
const env = require('../../config/env');

const MENU = [
  { title: 'Điện nước', payload: 'dien_nuoc' },
  { title: 'Camera', payload: 'camera' },
  { title: 'Nhà thông minh', payload: 'smarthome' },
  { title: 'Điện mặt trời', payload: 'solar' },
  { title: 'Gói bảo trì', payload: 'baotri' },
  { title: 'Gặp nhân viên', payload: 'human' },
];

/** Lower-case, no accents, đ -> d: "Báo giá" and "bao gia" match the same rule. */
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

const PHONE_RE = /(?:\+?84|0)[\s.\-]?\d(?:[\s.\-]?\d){8}\b/;
function findPhone(text) {
  const m = PHONE_RE.exec(String(text || ''));
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '').replace(/^84/, '0');
  return /^0\d{9}$/.test(digits) ? digits : null;
}

const pageUrl = (req) => `${req}/ky-thuat?src=facebook`;

// Order matters: first matching rule wins.
const RULES = [
  { id: 'human', test: (t, p) => p === 'human' || /gap (nhan vien|nguoi|ky thuat)|nguoi that|tu van truc tiep|goi lai|lien he lai/.test(t) },
  { id: 'hours', test: (t) => /dia chi|o dau|gio (mo|lam)|may gio|mo cua|duong nao/.test(t) },
  { id: 'price', test: (t) => /bao gia|gia (bao nhieu|ca|tien)|bao nhieu tien|chi phi|\bgia\b/.test(t) },
  { id: 'free', test: (t) => /mien phi|kiem tra (dien|nuoc)|khao sat/.test(t) },
  { id: 'camera', test: (t, p) => p === 'camera' || /camera|giam sat|an ninh|chong trom/.test(t) },
  { id: 'smarthome', test: (t, p) => p === 'smarthome' || /thong minh|smart ?home|cong tac|den (thong minh|tu dong)/.test(t) },
  { id: 'solar', test: (t, p) => p === 'solar' || /mat troi|solar|pin nang luong|nang luong/.test(t) },
  { id: 'baotri', test: (t, p) => p === 'baotri' || /bao tri|dinh ky|hop dong|nha thau|xuong|homestay|khach san/.test(t) },
  { id: 'dien_nuoc', test: (t, p) => p === 'dien_nuoc' || /dien|nuoc|ong nuoc|ro (dien|nuoc)|chap|nhay (cb|aptomat)|aptomat|may bom|tac|ngat dien|mat dien|hong|su co/.test(t) },
  { id: 'greet', test: (t) => /^(hi|hello|alo|xin chao|chao|co ai|shop|ad|admin)\b|bat dau|menu|get_started/.test(t) },
];

const ANSWERS = {
  dien_nuoc: 'Bên mình sửa chữa, bảo trì, lắp đặt điện nước dân dụng và công nghiệp (chập điện, rò điện, nhảy aptomat, ống nước rò rỉ, bơm nước, tủ điện). Anh/chị mô tả sự cố hoặc để lại số điện thoại, kỹ thuật sẽ gọi tư vấn và hẹn lịch kiểm tra.',
  camera: 'Bên mình thi công camera an ninh cho nhà ở, cửa hàng, xưởng: khảo sát vị trí, lắp đặt, cài xem từ điện thoại. Anh/chị cho biết số điểm cần lắp, hoặc để lại số điện thoại để kỹ thuật qua khảo sát.',
  smarthome: 'Bên mình lắp nhà thông minh: đèn, công tắc, rèm, cảnh sáng điều khiển bằng điện thoại. Tại quán có hệ thống mẫu, anh/chị ghé xem trực tiếp được ạ.',
  solar: 'Bên mình khảo sát, thiết kế, lắp đặt và bảo trì điện mặt trời cho nhà ở và cơ sở kinh doanh. Để tư vấn đúng công suất, kỹ thuật cần xem hóa đơn điện và mặt bằng mái. Anh/chị để lại số điện thoại giúp em nhé.',
  baotri: 'Gói bảo trì định kỳ dành cho hộ gia đình, homestay, xưởng, nhà thầu: kiểm tra điện nước theo lịch, ưu tiên xử lý khi có sự cố. Anh/chị để lại số điện thoại, bên mình gửi chi tiết gói phù hợp.',
  price: 'Mỗi công trình khác nhau nên bên mình báo giá sau khi kỹ thuật xem thực tế (khảo sát miễn phí). Anh/chị để lại số điện thoại hoặc mô tả sự cố, bên mình báo giá sớm nhất.',
  free: 'Bên mình kiểm tra điện nước miễn phí cho khách (đo rò điện, kiểm tra áp lực nước, tủ điện), chỉ tính phí khi anh/chị đồng ý sửa chữa. Anh/chị để lại số điện thoại để hẹn lịch nhé.',
};

/**
 * @param {string} text what the person typed
 * @param {{ payload?: string, base?: string }} [opts] payload of a tapped quick reply / button; base = public site origin
 */
function reply(text, { payload = '', base = '' } = {}) {
  const phone = findPhone(text);
  if (phone) {
    return {
      phone,
      text: `Em đã nhận số ${phone}. Kỹ thuật sẽ gọi hoặc nhắn lại anh/chị sớm nhất. Anh/chị cần thêm thông tin gì cứ nhắn tiếp ạ.`,
      quickReplies: MENU.slice(0, 5),
    };
  }
  const t = fold(text);
  const p = String(payload || '').toLowerCase();
  const rule = RULES.find((r) => r.test(t, p)) || { id: 'fallback' };

  if (rule.id === 'human') {
    return {
      wantsHuman: true,
      text: `Em đã báo nhân viên. Anh/chị để lại số điện thoại để kỹ thuật gọi lại nhanh nhất${env.contact.phone ? `, hoặc gọi ngay ${env.contact.phone}` : ''} ạ.`,
      quickReplies: [],
    };
  }
  if (rule.id === 'hours') {
    const parts = [env.contact.address && `Địa chỉ: ${env.contact.address}`, env.contact.hours && `Giờ mở cửa: ${env.contact.hours}`, env.contact.phone && `Điện thoại: ${env.contact.phone}`].filter(Boolean);
    return { text: parts.length ? parts.join('\n') : 'Anh/chị để lại số điện thoại, bên mình gửi địa chỉ và giờ làm việc ạ.', quickReplies: MENU };
  }
  if (ANSWERS[rule.id]) {
    return { text: `${ANSWERS[rule.id]}${base ? `\n\nXem công trình đã làm: ${pageUrl(base)}` : ''}`, quickReplies: [{ title: 'Gặp nhân viên', payload: 'human' }, ...MENU.filter((m) => m.payload !== rule.id && m.payload !== 'human').slice(0, 4)] };
  }
  const name = env.contact.name || env.business.shopName;
  return {
    text: rule.id === 'greet'
      ? `Chào anh/chị, ${name} xin nghe ạ. Bên mình nhận sửa chữa, bảo trì điện nước và lắp camera, nhà thông minh, điện mặt trời. Anh/chị cần tư vấn mảng nào?`
      : 'Em chưa hiểu rõ ý anh/chị. Anh/chị chọn mục bên dưới, hoặc để lại số điện thoại để kỹ thuật gọi tư vấn nhé.',
    quickReplies: MENU,
  };
}

module.exports = { reply, findPhone, fold };
