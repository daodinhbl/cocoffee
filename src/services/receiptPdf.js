const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const orderModel = require('../models/orderModel');
const printerSettings = require('./printerSettings');
const receiptImage = require('./receiptImage');

/**
 * A PDF copy of every receipt paid at the POS, written to RECEIPT_PDF_DIR (default public/uploads/receipts):
 *   <dir>/<yyyy-mm>/<order code>_<token>.pdf
 * The page is 80 mm wide and as tall as the receipt; the content is the same picture the Zalo bot sends
 * (services/receiptImage.js, DejaVu font, full Vietnamese), embedded losslessly, so it needs no PDF library.
 * The token is an HMAC of the order code, so the file name cannot be guessed from the order number even though
 * public/uploads is served as static files. Never throws: a receipt that could not be filed must not fail a sale.
 */
const PAGE_WIDTH_PT = (80 / 25.4) * 72;                       // 80 mm
const KEY = crypto.createHmac('sha256', env.jwt.secret).update('cocoffee-fnb:receipt-pdf:v1').digest();

const token = (code) => crypto.createHmac('sha256', KEY).update(String(code)).digest('hex').slice(0, 12);

/** One-page PDF around an RGB picture (Flate-compressed, no alpha). */
function pdfOf({ width, height, rgb }, title) {
  const w = PAGE_WIDTH_PT;
  const h = (w * height) / width;
  const num = (n) => n.toFixed(2);
  const image = zlib.deflateSync(rgb, { level: 9 });
  const content = Buffer.from(`q ${num(w)} 0 0 ${num(h)} 0 0 cm /Im0 Do Q`, 'latin1');
  const safeTitle = String(title).replace(/[^A-Za-z0-9 _.-]/g, '');
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(w)} ${num(h)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`),
      image, Buffer.from('\nendstream'),
    ]),
    Buffer.from(`<< /Title (${safeTitle}) /Producer (CoCoffee POS) >>`),
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let size = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(size);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    size += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** Bytes of the PDF for an order with its items, or null when the picture cannot be drawn. */
async function build(order, printer) {
  const picture = await receiptImage.render({ order, items: order.items, printer, raw: true });
  return picture ? pdfOf(picture, `Hoa don ${order.order_code}`) : null;
}

/**
 * Writes the receipt PDF of a paid order. Returns the file path, or null (disabled, font missing, disk error).
 * Called after payment, not awaited by the sale.
 */
async function saveFor(orderId) {
  if (!env.receiptPdf.enabled) return null;
  try {
    const order = await orderModel.getById(orderId);
    if (!order || order.status === 'cancelled' || order.status === 'draft') return null;
    order.items = await orderModel.getItems(orderId);
    const bytes = await build(order, await printerSettings.get());
    if (!bytes) return null;
    const when = new Date(order.completed_at || order.created_at || Date.now());
    const month = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
    const dir = path.join(env.receiptPdf.dir, month);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${String(order.order_code).replace(/[^A-Za-z0-9-]/g, '')}_${token(order.order_code)}.pdf`);
    await fs.promises.writeFile(file, bytes);
    return file;
  } catch (err) {
    logger.warn(`Receipt PDF for order ${orderId} was not saved: ${err.message}`);
    return null;
  }
}

module.exports = { saveFor, build, pdfOf, token };
