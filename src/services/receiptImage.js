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
function layout(ctx, { order, items, shop, printer, paid }) {
  const ops = [];
  const inner = WIDTH - 2 * MARGIN;
  let y = 28;
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
  if (printer.shopAddress) center(printer.shopAddress, 20);
  if (printer.shopPhone) center(`ĐT: ${printer.shopPhone}`, 20);
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
  row('TỔNG CỘNG', `${formatVnd(order.total)}đ`, 34, { bold: true, gap: 10 });
  if (printer.showVat && printer.vatRate > 0) {
    const vat = Number(order.total) - Number(order.total) / (1 + printer.vatRate / 100);
    row(`Trong đó VAT (${printer.vatRate}%)`, `${formatVnd(Math.round(vat))}đ`, 20);
  }
  y += 4;
  center(paid ? 'ĐÃ THANH TOÁN' : 'CHƯA THANH TOÁN', 24, { bold: true, gap: 8 });
  rule();
  const footer = printer.footer || '';
  if (footer) center(footer, 20);
  if (!/cảm ơn/i.test(footer)) center('Cảm ơn quý khách!', 22, { bold: true });
  return { ops, height: y + 24 };
}

/** Draws a receipt and returns the PNG bytes, or null when the font / pureimage is not available. */
async function render({ order, items, printer = {}, shopName = env.business.shopName }) {
  if (!setup()) return null;
  const measure = PImage.make(8, 8).getContext('2d');
  const paid = order.payment_status === 'paid';
  const { ops, height } = layout(measure, { order, items, shop: { name: shopName }, printer, paid });

  const img = PImage.make(WIDTH, height);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = '#000000';
  for (const op of ops) {
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

  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { sink.on('end', resolve); sink.on('error', reject); });
  await PImage.encodePNGToStream(img, sink);
  sink.end();
  await done;
  return Buffer.concat(chunks);
}

module.exports = { render, WIDTH, wrap, layout, setup };
