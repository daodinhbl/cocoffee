const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock } = require('node:test');
const ExcelJS = require('exceljs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-s2c-'));
process.env.TAX_EXPORT_DIR = dir;
const env = require('../src/config/env');
const taxModel = require('../src/models/taxModel');
const shopProfile = require('../src/services/shopProfile');
const svc = require('../src/services/taxExportService');

test('S2c-HKD stock book: opening + in - out = closing, values, totals', async (t) => {
  env.taxExport.dir = dir;
  let finished = null;
  mock.method(shopProfile, 'get', async () => ({ effective: { name: 'Cò Coffee', ownerName: 'Chủ', taxCode: '123', regNo: '45', address: 'Huế' } }));
  mock.method(taxModel, 'claimNextExport', async () => (finished ? null : { id: 7, kind: 's2c', period_from: '2026-10-01', period_to: '2026-10-31' }));
  mock.method(taxModel, 'finishExport', async (_id, out) => { finished = out; });
  mock.method(taxModel, 'failExport', async (_id, msg) => { throw new Error(msg); });
  mock.method(taxModel, 'inventoryBook', async (from, to) => {
    assert.deepEqual([from, to], ['2026-10-01', '2026-10-31']);
    return [
      { id: 1, sku: 'CF01', name: 'Cà phê hạt', unit: 'g', avg_cost: 300, opening: '1000', qty_in: '5000', qty_out: '2500.5', val_in: '1500000', val_out: '750150', last_cost: '300' },
      { id: 2, sku: 'XX', name: 'Không có gì', unit: 'cái', avg_cost: 0, opening: '0', qty_in: '0', qty_out: '0', val_in: '0', val_out: '0', last_cost: '0' },
    ];
  });
  t.after(() => { mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); });

  assert.ok(svc.KINDS.includes('s2c'));
  assert.equal(await svc.processNext(), true);
  assert.match(finished.fileName, /S2c-HKD-so-ton-kho_2026-10-01_2026-10-31\.xlsx$/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(dir, finished.fileName));
  const ws = wb.getWorksheet('S2c-HKD');
  const rows = [];
  ws.eachRow((r) => rows.push(r.values.slice(1)));
  const line = rows.find((r) => r[1] === 'CF01');
  assert.deepEqual([line[0], line[4], line[5], line[7], line[9], line[10]], [1, 1000, 5000, 2500.5, 3499.5, Math.round(3499.5 * 300)]);
  assert.ok(!rows.some((r) => r[1] === 'XX'), 'an item with no stock and no movement is left out');
  const total = rows.find((r) => r[2] === 'Cộng');
  assert.equal(total[6], 1500000);
  assert.equal(total[8], 750150);
  assert.equal(total[10], 1049850);
});
