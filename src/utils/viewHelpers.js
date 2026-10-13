const { formatVnd } = require('./text');

/**
 * Helpers exposed to every EJS template (app.locals). Everything here returns either plain text
 * (templates escape it with <%= %>) or trusted static SVG markup (templates print it with <%- %>).
 */

// 24x24 stroke icons, hand-written so the admin has no icon-font / CDN dependency.
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  table: '<rect x="3" y="9" width="18" height="4"/><path d="M6 13v7M18 13v7"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  cup: '<path d="M5 8h12v6a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z"/><path d="M17 10h2a2 2 0 0 1 0 4h-2"/><path d="M8 3v2M12 3v2"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
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

module.exports = { icon, money, pct, marginTone, ICONS };
