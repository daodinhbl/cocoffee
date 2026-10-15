const { formatVnd, formatShopTime } = require('./text');
const { ago } = require('./shopTime');

/**
 * Helpers exposed to every EJS template (app.locals). Everything here returns either plain text
 * (templates escape it with <%= %>) or trusted static SVG markup (templates print it with <%- %>).
 */

// 24x24 stroke icons, hand-written so the admin has no icon-font / CDN dependency.
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  table: '<rect x="3" y="9" width="18" height="4"/><path d="M6 13v7M18 13v7"/>',
  cart: '<path d="M3 7h18l-2 11H5L3 7z"/><path d="M8 7V5a4 4 0 0 1 8 0v2"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  cup: '<path d="M5 8h12v6a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z"/><path d="M17 10h2a2 2 0 0 1 0 4h-2"/><path d="M8 3v2M12 3v2"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chevrons: '<path d="M11 6l-6 6 6 6M19 6l-6 6 6 6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pencil: '<path d="M4 20l4-1 11-11-3-3L5 16z"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  logout: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
};

/** icon('grid', 'h-5 w-5') -> trusted <svg> markup (print with <%- %>). Unknown names render nothing. */
function icon(name, cls = 'h-5 w-5') {
  const body = ICONS[name];
  if (!body) return '';
  const safeCls = String(cls).replace(/[^a-zA-Z0-9\s:_/.\-[\]]/g, '');
  return `<svg class="${safeCls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** 25000 -> "25.000đ" */
const money = (n) => `${formatVnd(n)}đ`;

/** 66.6 -> "66,6%" (Vietnamese decimal comma) */
const pct = (n, digits = 1) => `${Number(n).toFixed(digits).replace('.', ',')}%`;

/** Margin band used for the colour of the profit badge (thresholds from docs/UI-UX-SPEC.md). */
function marginTone(margin) {
  if (margin >= 65) return 'good';
  if (margin >= 55) return 'warn';
  return 'bad';
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** 1234.5 -> "1.234,5"; trailing zeros dropped (quantities like 18 g, 0,5 l). */
function num(n, digits = 3) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const [int, frac = ''] = Math.abs(v).toFixed(digits).split('.');
  const trimmed = frac.replace(/0+$/, '');
  const sign = v < 0 && (Number(int) > 0 || trimmed) ? '-' : '';
  return sign + formatVnd(Number(int)) + (trimmed ? `,${trimmed}` : '');
}

const BADGE = {
  good: 'border-green-200 bg-green-50 text-green-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  bad: 'border-red-200 bg-red-50 text-red-700',
  info: 'border-sky-200 bg-sky-50 text-sky-700',
  neutral: 'border-gray-200 bg-gray-50 text-gray-700',
};
/** badge('Đã thu', 'good') -> trusted <span> markup (text is escaped). */
const badge = (text, tone = 'neutral') =>
  `<span class="inline-flex items-center whitespace-nowrap rounded-sm border px-2 py-0.5 text-xs font-medium ${BADGE[tone] || BADGE.neutral}">${esc(text)}</span>`;

const ORDER_STATUS = { draft: ['Chờ khách xác nhận', 'warn'], open: ['Đang phục vụ', 'info'], completed: ['Hoàn tất', 'good'], cancelled: ['Đã hủy', 'neutral'] };
/** Status pill for an order row: completed orders also say whether the money was collected. */
function orderStatusBadge(o) {
  if (o.status === 'completed' && o.payment_status === 'unpaid') return badge('Chờ thu tiền', 'warn');
  const [label, tone] = ORDER_STATUS[o.status] || [o.status, 'neutral'];
  return badge(label, tone);
}
const sourceBadge = (source) => (source === 'zalo' ? badge('Zalo', 'info') : badge('POS', 'neutral'));
const METHOD_LABEL = { cash: 'Tiền mặt', transfer: 'Chuyển khoản', card: 'Thẻ', other: 'Khác', unpaid: 'Chưa thu' };

/** Shared Tailwind class strings so every admin form/table looks the same. */
const ui = {
  input: 'h-10 w-full rounded border border-gray-300 bg-white px-3 text-sm placeholder:text-gray-400 focus:border-navy-accent focus:outline-none focus:ring-1 focus:ring-navy-accent',
  label: 'mb-1 block text-sm font-medium',
  btnPrimary: 'inline-flex h-10 items-center justify-center gap-2 rounded bg-amber-400 px-4 text-sm font-semibold text-ink-900 hover:bg-amber-500 active:bg-amber-600',
  btnSecondary: 'inline-flex h-10 items-center justify-center gap-2 rounded border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 hover:bg-gray-50',
  btnDanger: 'inline-flex h-10 items-center justify-center gap-2 rounded bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700',
  btnGhost: 'icon-btn inline-flex h-9 w-9 items-center justify-center rounded text-gray-500 hover:bg-blue-50 hover:text-navy-accent',
  card: 'rounded-xl border border-milk-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,.04)]',
  th: 'px-4 py-3',
  thead: 'border-b border-milk-200 bg-milk-50 text-xs font-semibold uppercase tracking-wide text-milk-500',
  // <dialog> is a bottom sheet on phones, a centred modal from sm up
  sheet: 'w-[calc(100vw-2rem)] rounded border border-gray-200 bg-white text-gray-900 max-sm:m-0 max-sm:mt-auto max-sm:max-h-[100dvh] max-sm:w-full max-sm:max-w-full max-sm:rounded-b-none max-sm:border-x-0',
  grabber: '<div class="mx-auto mt-2 h-1 w-10 rounded-full bg-gray-300 sm:hidden" aria-hidden="true"></div>',
};

/** JSON that is safe inside an HTML attribute / <script type="application/json"> */
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/**
 * Stock level of an inventory item against its minimum: bar width in % (full at 3x the minimum), bar colour,
 * badge tone and text. Shared by the inventory list and the item page so both say the same thing.
 */
function stockLevel(i) {
  const q = Number(i.quantity_on_hand), m = Number(i.min_stock);
  if (!i.is_active) return { pct: 0, cls: 'bg-milk-300', tone: 'neutral', text: 'Ngừng dùng' };
  if (q <= 0) return { pct: 0, cls: 'bg-red-600', tone: 'bad', text: 'Hết hàng' };
  if (m > 0 && q <= m) return { pct: Math.max(4, Math.round((q / (m * 3)) * 100)), cls: 'bg-amber-500', tone: 'warn', text: 'Sắp hết' };
  return { pct: m > 0 ? Math.min(100, Math.round((q / (m * 3)) * 100)) : 100, cls: 'bg-emerald-500', tone: 'good', text: 'Đủ' };
}

module.exports = {
  icon, money, pct, marginTone, ICONS, esc, num, badge, orderStatusBadge, sourceBadge, METHOD_LABEL, ui, safeJson, stockLevel,
  fmtTime: (d) => (d ? formatShopTime(d) : '—'), ago,
};
