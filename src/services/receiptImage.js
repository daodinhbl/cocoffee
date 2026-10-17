const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const env = require('../config/env');
const logger = require('../utils/logger');
const { formatVnd, formatShopTime } = require('../utils/text');

/**
 * PNG receipt for 80 mm thermal paper, drawn on the server in pure JS (`pureimage`, no native libraries, so it runs
 * on shared hosting). 80 mm paper prints 72 mm = 576 dots at 203 dpi, which is the width of the picture; the height
 * follows the content. Used by the Zalo chatbot: when a customer confirms an order the bot sends this picture.
 *
 * Font: DejaVu Sans Condensed (npm package `dejavu-fonts-ttf`, free licence, full Vietnamese coverage); a font at
 * RECEIPT_FONT_PATH wins when it exists. Returns null (never throws) when the picture cannot be drawn.
 */
const WIDTH = 576;
const MARGIN = 20;
const FONT_FAMILY = 'ReceiptRegular';
const FONT_BOLD_FAMILY = 'ReceiptBold';

let PImage = null;
let fontsReady = null;

function fontFiles() {
  const explicit = env.receiptImage.fontPath;
  if (explicit && fs.existsSync(explicit) && process.env.RECEIPT_FONT_PATH) return { regular: explicit, bold: explicit };
  try {
    const dir = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
    return { regular: path.join(dir, 'DejaVuSansCondensed.ttf'), bold: path.join(dir, 'DejaVuSansCondensed-Bold.ttf') };
  } catch (_) {
    return null;
  }
}

/** Loads pureimage and registers the fonts once. */
function setup() {
  if (fontsReady !== null) return fontsReady;
  fontsReady = false;
  try {
    PImage = require('pureimage');
    const files = fontFiles();
    if (!files || !fs.existsSync(files.regular) || !fs.existsSync(files.bold)) throw new Error('receipt font not found (npm install dejavu-fonts-ttf)');
    PImage.registerFont(files.regular, FONT_FAMILY).loadSync();
    PImage.registerFont(files.bold, FONT_BOLD_FAMILY).loadSync();
    fontsReady = true;
  } catch (err) {
    logger.warn(`Receipt image unavailable: ${err.message}`);
  }
  return fontsReady;
}

const font = (size, bold) => `${size}px ${bold ? FONT_BOLD_FAMILY : FONT_FAMILY}`;

/** Greedy word wrap with the real glyph widths. A word wider than the line is cut. */
function wrap(ctx, text, maxWidth, fontSpec) {
  ctx.font = fontSpec;
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth) { line = next; continue; }
      if (line) lines.push(line);
      let rest = word;
      while (ctx.measureText(rest).width > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > maxWidth) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Lays the receipt out as drawing operations; `ctx` is only used to measure text.
 * @returns {{ ops: object[], height: number }}
 */
function layout(ctx, { order, items, shop, printer, paid, logo }) {
  const ops = [];
  const inner = WIDTH - 2 * MARGIN;
  let y = 28;
  if (logo) {                                              // shop logo, centred above the name
    ops.push({ t: 'image', img: logo.img, x: Math.round((WIDTH - logo.w) / 2), y, w: logo.w, h: logo.h });
    y += logo.h + 12;
  }
  const center = (text, size, { bold = false, gap = 6 } = {}) => {
    for (const line of wrap(ctx, text, inner, font(size, bold))) {
      ops.push({ t: 'text', x: WIDTH / 2, y: y + size, text: line, size, bold, align: 'center' });
      y += size + gap;
    }
  };
  const row = (left, right, size, { bold = false, gap = 6 } = {}) => {
    ctx.font = font(size, bold);
    const rightWidth = right ? ctx.measureText(right).width + 12 : 0;
    const lines = wrap(ctx, left, inner - rightWidth, font(size, bold));
    lines.forEach((line, i) => {
      ops.push({ t: 'text', x: MARGIN, y: y + size, text: line, size, bold, align: 'left' });
      if (i === 0 && right) ops.push({ t: 'text', x: WIDTH - MARGIN, y: y + size, text: right, size, bold, align: 'right' });
      y += size + gap;
    });
  };
  const rule = (dashed = true) => { y += 6; ops.push({ t: 'rule', y, dashed }); y += 14; };

  center(shop.name.toUpperCase(), 36, { bold: true, gap: 8 });
  if (printer.legalName && printer.legalName.toLowerCase() !== shop.name.toLowerCase()) center(printer.legalName, 20);
  if (printer.shopAddress) center(printer.shopAddress, 20);
  if (printer.shopPhone) center(`ĐT: ${printer.shopPhone}`, 20);
  if (printer.taxCode) center(`MST: ${printer.taxCode}`, 20);
  y += 6;
  rule(false);
  center('HÓA ĐƠN', 30, { bold: true, gap: 8 });
  center(order.order_code, 24, { bold: true });
  center(formatShopTime(order.completed_at || order.created_at), 20);
  if (order.table_name || order.table_code) center(`Bàn: ${order.table_name || order.table_code}`, 20);
  else if (order.source === 'zalo') center('Đặt qua Zalo', 20);
  rule();

  for (const i of items) {
    row(i.product_name, `${formatVnd(i.line_total)}đ`, 24, { bold: true, gap: 4 });
    row(`   ${i.quantity} x ${formatVnd(i.unit_price)}đ${i.note ? `  (${i.note})` : ''}`, '', 20, { gap: 8 });
  }
  rule();

  if (Number(order.discount) > 0) {
    row('Tạm tính', `${formatVnd(order.subtotal)}đ`, 22);
    row('Giảm giá', `-${formatVnd(order.discount)}đ`, 22);
  }
  row('TỔNG CỘNG', `${formatVnd(order.total)}đ`, 28, { bold: true, gap: 10 });
  if (printer.showVat && printer.vatRate > 0) {
    const vat = Number(order.total) - Number(order.total) / (1 + printer.vatRate / 100);
    row(`Trong đó VAT (${printer.vatRate}%)`, `${formatVnd(Math.round(vat))}đ`, 20);
  }
  y += 4;
  center(paid ? 'ĐÃ THANH TOÁN' : 'CHƯA THANH TOÁN', 24, { bold: true, gap: 8 });
  rule();
  const footer = printer.footer || '';
  if (footer) center(footer, 20);
  if (printer.wifiName) {
    y += 4;
    center(`Wi-Fi: ${printer.wifiName}`, 22, { bold: true, gap: 4 });
    if (printer.wifiPassword) center(`Mật khẩu: ${printer.wifiPassword}`, 22, { bold: true });
  }
  if (!/cảm ơn/i.test(footer)) center('Cảm ơn quý khách!', 22, { bold: true });
  return { ops, height: y + 24 };
}

const LOGO_MM = { s: 22, m: 32, l: 44 };
const logoCache = new Map();   // url -> decoded bitmap (a logo URL never changes content: each upload gets a new id)

/** The shop logo (Cài đặt > Máy in hóa đơn) decoded and scaled for the 576 px receipt, or null. Never throws. */
async function loadLogo(printer) {
  const url = printer && printer.logoUrl;
  if (!url) return null;
  try {
    let img = logoCache.get(url);
    if (!img) {
      const id = require('./imageStore').mediaIdOf(url);
      const row = id ? await require('../models/mediaModel').get(id) : null;
      if (!row) return null;
      const stream = () => require('stream').Readable.from(row.bytes);
      img = row.mime === 'image/png' ? await PImage.decodePNGFromStream(stream()) : await PImage.decodeJPEGFromStream(stream());
      if (logoCache.size > 8) logoCache.clear();
      logoCache.set(url, img);
    }
    const width = Math.round(((LOGO_MM[printer.logoSize] || 32) / 72) * WIDTH);          // 72 mm printable = 576 px
    const k = Math.min(width / img.width, 170 / img.height);
    return { img, w: Math.max(1, Math.round(img.width * k)), h: Math.max(1, Math.round(img.height * k)) };
  } catch (err) {
    logger.warn(`Receipt logo skipped: ${err.message}`);
    return null;
  }
}

/** Draws a receipt and returns the PNG bytes, or null when the font / pureimage is not available. */
async function render({ order, items, printer = {}, shopName = env.business.shopName, raw = false }) {
  if (!setup()) return null;
  const measure = PImage.make(8, 8).getContext('2d');
  const paid = order.payment_status === 'paid';
  const logo = await loadLogo(printer);
  const { ops, height } = layout(measure, { order, items, shop: { name: shopName }, printer, paid, logo });

  const img = PImage.make(WIDTH, height);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = '#000000';
  for (const op of ops) {
    if (op.t === 'image') { ctx.drawImage(op.img, op.x, op.y, op.w, op.h); continue; }
    if (op.t === 'rule') {
      if (!op.dashed) { ctx.fillRect(MARGIN, op.y, WIDTH - 2 * MARGIN, 2); continue; }
      for (let x = MARGIN; x < WIDTH - MARGIN; x += 10) ctx.fillRect(x, op.y, 5, 2);
      continue;
    }
    ctx.font = font(op.size, op.bold);
    const w = ctx.measureText(op.text).width;
    const x = op.align === 'center' ? op.x - w / 2 : op.align === 'right' ? op.x - w : op.x;
    ctx.fillText(op.text, x, op.y);
  }

  if (raw) {                                              // PDF: opaque RGB pixels (the picture is drawn on white)
    const rgb = Buffer.alloc(WIDTH * height * 3);
    for (let i = 0, o = 0; i < WIDTH * height * 4; i += 4, o += 3) { rgb[o] = img.data[i]; rgb[o + 1] = img.data[i + 1]; rgb[o + 2] = img.data[i + 2]; }
    return { width: WIDTH, height, rgb };
  }
  return toPng(img);
}

async function toPng(img) {
  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { sink.on('end', resolve); sink.on('error', reject); });
  await PImage.encodePNGToStream(img, sink);
  sink.end();
  await done;
  return Buffer.concat(chunks);
}

/**
 * A titled table as a PNG (debt statements). spec:
 *   width (default 720), shopName, title, lines: string[] (centered, under the title),
 *   columns: [{ label, w (relative width), align: 'left'|'right'|'center' }],
 *   rows: [{ cells: string[], bold?, shade? }]  (cells wrap inside their column; at most maxRows rows are drawn: the first ones,
 *     or with keepLast the LAST ones after a "… N dòng trước đó" row — a statement is read from the bottom),
 *   notes: string[] (small print under the table), fontSize (default 19).
 * Returns null when the picture cannot be drawn (font / pureimage missing).
 */
async function renderTable(spec) {
  if (!setup()) return null;
  const W = spec.width || 720;
  const M = 20;
  const FS = spec.fontSize || 19;
  const LH = FS + 6;
  const PAD = 7;
  const inner = W - 2 * M;
  const weight = spec.columns.reduce((t, c) => t + c.w, 0);
  const colW = spec.columns.map((c) => Math.floor((inner * c.w) / weight));
  colW[colW.length - 1] += inner - colW.reduce((a, b) => a + b, 0);
  const colX = colW.map((_, i) => M + colW.slice(0, i).reduce((a, b) => a + b, 0));
  const measure = PImage.make(8, 8).getContext('2d');
  const ops = [];
  let y = 26;

  const center = (text, size, bold, gap) => {
    for (const line of wrap(measure, text, inner, font(size, bold))) {
      ops.push({ t: 'text', x: W / 2, y: y + size, text: line, size, bold, align: 'center' });
      y += size + gap;
    }
  };
  if (spec.shopName) center(String(spec.shopName).toUpperCase(), 32, true, 8);
  if (spec.title) center(spec.title, 26, true, 8);
  for (const line of spec.lines || []) center(line, 19, false, 5);
  y += 10;

  const tableTop = y;
  const addRow = (cells, { bold = false, shade = null } = {}) => {
    const lines = cells.map((c, i) => wrap(measure, String(c ?? ''), colW[i] - 2 * PAD, font(FS, bold)));
    const h = Math.max(...lines.map((l) => l.length)) * LH + 2 * PAD - 4;
    if (shade) ops.push({ t: 'rect', x: M, y, w: inner, h, color: shade });
    lines.forEach((ls, i) => ls.forEach((line, k) => {
      ops.push({ t: 'text', x: spec.columns[i].align === 'right' ? colX[i] + colW[i] - PAD : spec.columns[i].align === 'center' ? colX[i] + colW[i] / 2 : colX[i] + PAD, y: y + PAD + FS + k * LH - 2, text: line, size: FS, bold, align: spec.columns[i].align || 'left' });
    }));
    y += h;
    ops.push({ t: 'hline', y });
  };
  addRow(spec.columns.map((c) => c.label), { bold: true, shade: '#e5e7eb' });
  const maxRows = spec.maxRows || 80;
  const rows = spec.rows || [];
  const hidden = Math.max(0, rows.length - maxRows);
  if (hidden && spec.keepLast) addRow([`… ${hidden} dòng trước đó`, ...spec.columns.slice(1).map(() => '')], {});
  (spec.keepLast ? rows.slice(hidden) : rows.slice(0, maxRows)).forEach((r) => addRow(r.cells, { bold: r.bold, shade: r.shade }));
  if (hidden && !spec.keepLast) addRow([`… và ${hidden} dòng nữa`, ...spec.columns.slice(1).map(() => '')], {});
  const tableBottom = y;
  y += 14;
  for (const note of spec.notes || []) {
    for (const line of wrap(measure, note, inner, font(17, false))) { ops.push({ t: 'text', x: M, y: y + 17, text: line, size: 17, bold: false, align: 'left', gray: true }); y += 23; }
  }
  const H = y + 20;

  const img = PImage.make(W, H);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  for (const op of ops) {
    if (op.t === 'rect') { ctx.fillStyle = op.color; ctx.fillRect(op.x, op.y, op.w, op.h); }
  }
  ctx.fillStyle = '#000000';
  ctx.fillRect(M, tableTop, inner, 2);
  for (const op of ops) if (op.t === 'hline') ctx.fillRect(M, op.y, inner, 1);
  for (const x of [...colX, M + inner]) ctx.fillRect(x, tableTop, 1, tableBottom - tableTop);
  for (const op of ops) {
    if (op.t !== 'text') continue;
    ctx.fillStyle = op.gray ? '#4b5563' : '#000000';
    ctx.font = font(op.size, op.bold);
    const w = ctx.measureText(op.text).width;
    ctx.fillText(op.text, op.align === 'center' ? op.x - w / 2 : op.align === 'right' ? op.x - w : op.x, op.y);
  }
  return toPng(img);
}

module.exports = { render, renderTable, WIDTH, wrap, layout, setup };
