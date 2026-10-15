/** Inventory > Excel export / import: real Express app, data layer faked (see helpers/adminFixture.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { start } = require('./helpers/adminFixture');
const excel = require('../src/services/inventoryExcel');

const sheetBuffer = async (rows, header = ['SKU', 'Tên nguyên liệu', 'Đơn vị', 'Tồn kho', 'Tồn tối thiểu', 'Giá vốn (đ/đơn vị)', 'Trạng thái']) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.addRow(header);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
};

async function admin(t) {
  const fx = await start();
  t.after(() => fx.stop());
  const { c, res } = await fx.login();
  assert.equal(res.status, 303);
  const csrf = await fx.csrfOf(c);
  const upload = (buf, dry) => fetch(`${fx.base}/admin/inventory/import${dry ? '?dry=1' : ''}`, {
    method: 'POST', headers: { cookie: Object.entries(Object.fromEntries(c.jar)).map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }, body: buf,
  });
  return { fx, c, upload };
}

test('export gives a styled, frozen, auto-fitted workbook that lists every item', async (t) => {
  const { c } = await admin(t);
  const res = await c.get('/admin/inventory/export.xlsx');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.match(res.headers.get('content-disposition'), /ton-kho-\d{8}\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('Nguyên liệu');
  assert.equal(ws.getRow(1).getCell(1).value, 'SKU');
  assert.equal(ws.views[0].state, 'frozen');
  assert.equal(ws.rowCount, 4);                                  // header + 3 fixture items
  assert.ok(ws.getColumn(2).width > 14 && ws.getColumn(2).width <= 52, `name column fitted, got ${ws.getColumn(2).width}`);
  assert.ok(ws.getColumn(1).width >= 10);
  assert.equal(ws.getRow(2).getCell('E').numFmt, '#,##0');
  assert.ok(wb.getWorksheet('Tổng hợp'));
});

test('template downloads and the export can be parsed straight back', async (t) => {
  const { c } = await admin(t);
  assert.equal((await c.get('/admin/inventory/template.xlsx')).status, 200);
  const exported = Buffer.from(await (await c.get('/admin/inventory/export.xlsx')).arrayBuffer());
  const rows = await excel.parseSheet(exported);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].sku, 'CF');
});

test('dry run previews creates, updates and counts without writing', async (t) => {
  const { fx, upload } = await admin(t);
  const buf = await sheetBuffer([
    ['CF', 'Cà phê rang xay đặc biệt', 'g', 4800, 1000, null, 'Đang dùng'],     // rename + count 5000 -> 4800
    ['SUA', null, null, 420, 500, null, null],                                  // nothing changes
    ['DUONG', 'Đường nước', 'ml', '3.000', 300, '20', null],                    // new, text numbers
  ]);
  const body = await (await upload(buf, true)).json();
  assert.equal(body.ok, true);
  assert.deepEqual([body.summary.creates, body.summary.updates, body.summary.counts, body.summary.unchanged, body.summary.errors], [1, 1, 1, 1, 0]);
  assert.equal(body.creates[0].quantity, 3000);
  assert.deepEqual(fx.calls.filter((x) => /inventory\.create|inventory\.update/.test(x.name)), []);
});

test('apply writes through the models; a file with errors changes nothing', async (t) => {
  const { fx, upload } = await admin(t);
  const good = await sheetBuffer([['CF', 'Cà phê rang xay', 'g', 5000, 1500, null, null], ['NEW-1', 'Siro dâu', 'ml', 0, 100, null, null]]);
  const ok = await (await upload(good)).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.applied, true);
  const names = fx.calls.map((x) => x.name);
  assert.ok(names.includes('inventory.create'));
  assert.ok(names.includes('inventory.update'));

  const before = fx.calls.length;
  const bad = await sheetBuffer([['X1', 'Không đơn vị', null, 10, 0, null, null], ['CF', 'Dòng trùng', 'g', 'abc', 0, null, null], ['CF', 'Lại trùng', 'g', 1, 0, null, null]]);
  const res = await upload(bad);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.summary.errors, 3);
  assert.equal(fx.calls.length, before);
});

test('import rejects non-xlsx input and a missing CSRF header', async (t) => {
  const { fx, upload } = await admin(t);
  const res = await upload(Buffer.from('sku,name\nA,B'), true);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /xlsx/i);
  const noCsrf = await fetch(`${fx.base}/admin/inventory/import?dry=1`, { method: 'POST', body: Buffer.from('x'), redirect: 'manual' });
  assert.ok(noCsrf.status >= 300 && noCsrf.status < 500, `unauthenticated upload refused, got ${noCsrf.status}`);
});

test('toNumber understands Vietnamese and English number text', () => {
  const n = excel.toNumber;
  assert.equal(n('3.000'), 3000);
  assert.equal(n('1.234,5'), 1234.5);
  assert.equal(n('1,234.5'), 1234.5);
  assert.equal(n('2,5'), 2.5);
  assert.equal(n('5 000 đ'), 5000);
  assert.equal(n(''), null);
  assert.ok(Number.isNaN(n('abc')));
});
