process.env.FNB_NO_LISTEN = '1';
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('receipt PDF: valid one-page 80 mm file, saved under a token name', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpt-'));
  process.env.RECEIPT_PDF_DIR = dir;
  process.env.RECEIPT_PDF_ENABLED = 'true';
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orderModel = require('../src/models/orderModel');
  const printerSettings = require('../src/services/printerSettings');
  const receiptPdf = require('../src/services/receiptPdf');
  const order = {
    id: 10, order_code: 'CF261017-00010', status: 'completed', payment_status: 'paid', source: 'pos', table_name: 'Bàn 3',
    subtotal: 71000, discount: 0, total: 71000, created_at: new Date('2026-10-17T15:10:00Z'), completed_at: new Date('2026-10-17T15:10:00Z'),
  };
  const items = [{ product_name: 'Cà Phê Sữa Pha Máy', unit_price: 17000, quantity: 1, line_total: 17000, note: null }, { product_name: 'Trà Đào Nóng', unit_price: 18000, quantity: 3, line_total: 54000, note: 'ít đường' }];
  t.mock.method(orderModel, 'getById', async () => order);
  t.mock.method(orderModel, 'getItems', async () => items);
  t.mock.method(printerSettings, 'get', async () => ({ shopAddress: '', shopPhone: '', footer: 'Cảm ơn quý khách — hẹn gặp lại!', showVat: true, vatRate: 8 }));

  const bytes = await receiptPdf.build({ ...order, items }, await printerSettings.get());
  assert.ok(bytes, 'font available, so the receipt is drawn');
  const text = bytes.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 1/);
  assert.match(text, /\/MediaBox \[0 0 226\.77 \d+\.\d\d\]/, '80 mm wide');
  const xrefAt = Number(/startxref\n(\d+)\n/.exec(text)[1]);
  assert.equal(text.slice(xrefAt, xrefAt + 4), 'xref', 'startxref points at the xref table');
  const entries = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  assert.equal(entries.length, 6);
  entries.forEach((off, i) => assert.equal(text.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `xref offset of object ${i + 1}`));

  const file = await receiptPdf.saveFor(10);
  assert.ok(file && fs.existsSync(file));
  assert.match(path.relative(dir, file).split(path.sep).join('/'), /^\d{4}-\d{2}\/CF261017-00010_[0-9a-f]{12}\.pdf$/);
  assert.equal(file.endsWith(`_${receiptPdf.token('CF261017-00010')}.pdf`), true);
  assert.ok(fs.statSync(file).size > 1000);

  order.status = 'cancelled';
  assert.equal(await receiptPdf.saveFor(10), null, 'a cancelled order is not filed');
  process.env.RECEIPT_PDF_ENABLED = 'false';
});

test('POS checkout files the receipt after a successful payment, and only then', async (t) => {
  const orderService = require('../src/services/orderService');
  const receiptPdf = require('../src/services/receiptPdf');
  const posService = require('../src/services/posService');
  const filed = [];
  t.mock.method(receiptPdf, 'saveFor', async (id) => { filed.push(id); return null; });
  t.mock.method(orderService, 'replaceOpenOrderItems', async (id) => ({ id }));
  const cart = { tableId: null, orderId: 42, items: [{ product_id: 1, quantity: 1 }] };

  t.mock.method(orderService, 'payOrder', async (id) => ({ order: { id, total: 1000 }, change: 0 }));
  await posService.checkout(cart, { method: 'cash' }, 1);
  assert.deepEqual(filed, [42]);

  orderService.payOrder.mock.mockImplementation(async () => { throw new Error('INSUFFICIENT_PAYMENT'); });
  await assert.rejects(posService.checkout(cart, { method: 'cash' }, 1));
  assert.deepEqual(filed, [42], 'a failed payment files nothing');
});
