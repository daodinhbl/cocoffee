const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
const taxModel = require('../src/models/taxModel');
const expenseModel = require('../src/models/expenseModel');
const settingsModel = require('../src/models/settingsModel');
const taxService = require('../src/services/taxService');
const { shopDay, addDays } = require('../src/utils/shopTime');

test('periods: month / quarter / year, neighbours, leap years', () => {
  assert.deepEqual(taxService.periodOf('month', '2026-02-10'), { kind: 'month', from: '2026-02-01', to: '2026-02-28', label: 'Tháng 2/2026' });
  assert.equal(taxService.periodOf('month', '2028-02-10').to, '2028-02-29');
  assert.deepEqual(taxService.periodOf('quarter', '2026-11-30'), { kind: 'quarter', from: '2026-10-01', to: '2026-12-31', label: 'Quý 4/2026' });
  assert.equal(taxService.periodOf('quarter', '2026-05-01').from, '2026-04-01');
  assert.deepEqual(taxService.periodOf('year', '2026-06-15'), { kind: 'year', from: '2026-01-01', to: '2026-12-31', label: 'Năm 2026' });
  assert.equal(taxService.shiftPeriod('month', '2026-01-15', -1).from, '2025-12-01');
  assert.equal(taxService.shiftPeriod('quarter', '2026-10-15', 1).from, '2027-01-01');
  assert.throws(() => taxService.periodOf('week'), /Kỳ phải là/);
});

test('snapshot: discount shared over the lines, rates of the day, rollup grows by group', async () => {
  const sets = [];
  const bumps = [];
  mock.method(taxModel, 'orderLines', async () => [
    { id: 1, lineTotal: 50000, productTax: null, stockMode: 'bom' },
    { id: 2, lineTotal: 30000, productTax: null, stockMode: 'direct' },
    { id: 3, lineTotal: 20000, productTax: 3, stockMode: 'bom' },          // product forced to the "none" group
  ]);
  mock.method(taxModel, 'categories', async () => [{ id: 1, code: 'fnb_service' }, { id: 2, code: 'goods_distribution' }, { id: 3, code: 'none' }]);
  mock.method(taxModel, 'ratesOn', async () => new Map([[1, { vat: 0.03, pit: 0.015 }], [2, { vat: 0.01, pit: 0.005 }], [3, { vat: 0, pit: 0 }]]));
  mock.method(taxModel, 'setLineTax', async (id, s) => { sets.push([id, s]); });
  mock.method(taxModel, 'bumpRevenue', async (b) => { bumps.push(b); });
  try {
    await taxService.snapshotOrder({}, { id: 9, discount: 10000 }, { day: '2026-10-17' });
    const net = sets.map(([, s]) => s.netRevenue);
    assert.deepEqual(net, [45000, 27000, 18000], '10.000 shared 5:3:2');
    assert.equal(net.reduce((a, b) => a + b, 0), 90000, 'shares add up to the discount exactly');
    assert.deepEqual(sets.map(([, s]) => s.categoryId), [1, 2, 3], 'bom -> dịch vụ ăn uống, direct -> hàng hóa, product setting wins');
    assert.deepEqual(sets.map(([, s]) => [s.vatRate, s.pitRate]), [[0.03, 0.015], [0.01, 0.005], [0, 0]]);
    const g1 = bumps.find((b) => b.categoryId === 1);
    assert.deepEqual([g1.day, g1.gross, g1.discount, g1.net, g1.vat, g1.pit], ['2026-10-17', 50000, 5000, 45000, 1350, 675]);
    assert.equal(bumps.length, 3);
    bumps.length = 0;
    await taxService.snapshotOrder({}, { id: 9, discount: 0 }, { day: '2026-10-17', rollup: false });
    assert.equal(bumps.length, 0, 'history backfill does not touch the rollup');
  } finally {
    for (const f of ['orderLines', 'categories', 'ratesOn', 'setLineTax', 'bumpRevenue']) taxModel[f].mock.restore();
  }
});

test('snapshot: an odd discount keeps every cent (last line takes the rest)', async () => {
  const sets = [];
  mock.method(taxModel, 'orderLines', async () => [{ id: 1, lineTotal: 10000, stockMode: 'bom' }, { id: 2, lineTotal: 10000, stockMode: 'bom' }, { id: 3, lineTotal: 10000, stockMode: 'bom' }]);
  mock.method(taxModel, 'categories', async () => [{ id: 1, code: 'fnb_service' }]);
  mock.method(taxModel, 'ratesOn', async () => new Map());
  mock.method(taxModel, 'setLineTax', async (id, s) => { sets.push(s.netRevenue); });
  mock.method(taxModel, 'bumpRevenue', async () => {});
  try {
    await taxService.snapshotOrder({}, { id: 1, discount: 1000 }, { day: '2026-10-17' });
    assert.equal(sets.reduce((a, b) => a + b, 0), 29000);
  } finally {
    for (const f of ['orderLines', 'categories', 'ratesOn', 'setLineTax', 'bumpRevenue']) taxModel[f].mock.restore();
  }
});

function stubEstimate({ before, split, expenses }) {
  mock.method(taxModel, 'categories', async () => [{ id: 1, name: 'Dịch vụ ăn uống' }, { id: 2, name: 'Hàng hóa' }]);
  mock.method(taxModel, 'revenueByCategory', async () => split);
  mock.method(taxModel, 'revenueTotal', async () => before);
  mock.method(taxModel, 'expenseByTreatment', async () => expenses);
  mock.method(settingsModel, 'getByPrefix', async () => ({}));
}
const unstub = () => { for (const [m, f] of [[taxModel, 'categories'], [taxModel, 'revenueByCategory'], [taxModel, 'revenueTotal'], [taxModel, 'expenseByTreatment'], [settingsModel, 'getByPrefix']]) m[f].mock.restore(); };

test('estimate: only the part of the year above the threshold is taxed', async () => {
  stubEstimate({
    before: 300000000,
    split: [{ categoryId: 1, lines: 1, gross: 405000000, discount: 5000000, net: 400000000, vat: 12000000, pit: 6000000 }, { categoryId: 2, lines: 1, gross: 100000000, discount: 0, net: 100000000, vat: 1000000, pit: 500000 }],
    expenses: { deductible: 80000000, non_deductible: 2000000, capex: 3500000 },
  });
  try {
    const e = await taxService.estimate('2026-10-01', '2026-12-31');
    assert.equal(e.revenue.net, 500000000);
    assert.equal(e.year.through, 800000000);
    assert.equal(e.taxableRevenue, 300000000, '800M this year - 500M threshold');
    assert.equal(e.vat, 7800000, '13M x (300M / 500M)');
    assert.equal(e.pit, 3900000, 'revenue method: 6,5M x 0,6');
    assert.equal(e.tax, 11700000);
    assert.equal(e.profit, 420000000);
    assert.equal(e.expenses.total, 85500000);
    assert.equal(e.year.exempt, false);

    const profit = await taxService.estimate('2026-10-01', '2026-12-31', { config: { exemptThreshold: 500000000, pitMethod: 'profit', profitRate: 0.15 } });
    assert.equal(profit.pit, Math.round((300000000 - 80000000 * 0.6) * 0.15), 'profit method: (taxable revenue - deductible expenses x share) x 15%');
    assert.equal(profit.vat, 7800000, 'VAT does not depend on the PIT method');
  } finally { unstub(); }
});

test('estimate: below the threshold nothing is due; a period entirely above it is taxed in full', async () => {
  stubEstimate({ before: 0, split: [{ categoryId: 1, lines: 1, gross: 100000000, discount: 0, net: 100000000, vat: 3000000, pit: 1500000 }], expenses: { deductible: 0, non_deductible: 0, capex: 0 } });
  try {
    const e = await taxService.estimate('2026-01-01', '2026-03-31');
    assert.deepEqual([e.vat, e.pit, e.tax, e.taxableRevenue, e.year.exempt, e.year.remaining], [0, 0, 0, 0, true, 400000000]);
  } finally { unstub(); }
  stubEstimate({ before: 900000000, split: [{ categoryId: 1, lines: 1, gross: 100000000, discount: 0, net: 100000000, vat: 3000000, pit: 1500000 }], expenses: { deductible: 0, non_deductible: 0, capex: 0 } });
  try {
    const e = await taxService.estimate('2026-10-01', '2026-10-31');
    assert.deepEqual([e.vat, e.pit, e.taxableRevenue], [3000000, 1500000, 100000000]);
  } finally { unstub(); }
  stubEstimate({ before: 0, split: [], expenses: { deductible: 0, non_deductible: 0, capex: 0 } });
  try {
    assert.equal((await taxService.estimate('2026-10-01', '2026-10-31')).tax, 0, 'an empty period');
  } finally { unstub(); }
});

test('configuration: defaults, saved values, bad values refused', async () => {
  mock.method(settingsModel, 'getByPrefix', async () => ({}));
  const saved = [];
  mock.method(settingsModel, 'setMany', async (v) => { saved.push(v); });
  try {
    assert.deepEqual(await taxService.getConfig(), { exemptThreshold: 500000000, pitMethod: 'revenue', profitRate: 0.15 });
    await taxService.saveConfig({ exemptThreshold: 1000000000, pitMethod: 'profit', profitRate: 0.17 }, 1);
    assert.deepEqual(saved[0], { 'tax.exemptThreshold': '1000000000', 'tax.pitMethod': 'profit', 'tax.profitRate': '0.17' });
    await assert.rejects(taxService.saveConfig({ exemptThreshold: -1, pitMethod: 'revenue', profitRate: 0.1 }, 1), /Ngưỡng/);
    await assert.rejects(taxService.saveConfig({ exemptThreshold: 1, pitMethod: 'x', profitRate: 0.1 }, 1), /cách tính/);
    await assert.rejects(taxService.saveConfig({ exemptThreshold: 1, pitMethod: 'profit', profitRate: 1.5 }, 1), /Thuế suất/);
  } finally { settingsModel.getByPrefix.mock.restore(); settingsModel.setMany.mock.restore(); }
});

test('locking: only finished periods; a locked day refuses expense changes; filed periods cannot be reopened', async () => {
  await assert.rejects(taxService.lockPeriod('month', shopDay(), 1), (e) => e.code === 'PERIOD_NOT_OVER');
  mock.method(taxModel, 'lockedCovering', async (day) => (day === '2026-09-10' ? { id: 1, kind: 'month', period_from: '2026-09-01', period_to: '2026-09-30' } : null));
  try {
    await assert.rejects(taxService.assertOpenDay('2026-09-10'), (e) => e.code === 'PERIOD_LOCKED' && /2026-09-01/.test(e.message));
    await taxService.assertOpenDay('2026-10-10');
  } finally { taxModel.lockedCovering.mock.restore(); }
  mock.method(taxModel, 'getPeriod', async () => ({ status: 'filed' }));
  try {
    await assert.rejects(taxService.unlockPeriod('month', '2026-09-10', 1), (e) => e.code === 'PERIOD_FILED');
  } finally { taxModel.getPeriod.mock.restore(); }
  mock.method(taxModel, 'getPeriod', async () => null);
  try {
    await assert.rejects(taxService.markFiled('month', '2026-09-10', 'x', 1), (e) => e.code === 'NOT_LOCKED');
    await assert.rejects(taxService.unlockPeriod('month', '2026-09-10', 1), (e) => e.code === 'NOT_FOUND');
  } finally { taxModel.getPeriod.mock.restore(); }
});

test('rates: a new row needs a valid day and rate, and cannot repeat a start date', async () => {
  mock.method(taxModel, 'categories', async () => [{ id: 1 }]);
  mock.method(taxModel, 'rates', async () => [{ category_id: 1, effective_from: '2026-01-01' }]);
  const added = [];
  mock.method(taxModel, 'addRate', async (r) => { added.push(r); });
  try {
    await taxService.addRate({ categoryId: 1, effectiveFrom: '2027-01-01', vatRate: 0.02, pitRate: 0.01, legalBasis: 'NĐ x', userId: 1 });
    assert.deepEqual([added[0].effectiveFrom, added[0].vatRate, added[0].pitRate], ['2027-01-01', 0.02, 0.01]);
    await assert.rejects(taxService.addRate({ categoryId: 1, effectiveFrom: '2026-01-01', vatRate: 0.02, pitRate: 0.01 }), (e) => e.code === 'DUPLICATE');
    await assert.rejects(taxService.addRate({ categoryId: 1, effectiveFrom: 'x', vatRate: 0.02, pitRate: 0.01 }), /Ngày hiệu lực/);
    await assert.rejects(taxService.addRate({ categoryId: 1, effectiveFrom: '2027-02-01', vatRate: 3, pitRate: 0.01 }), /0–100%/);
    await assert.rejects(taxService.addRate({ categoryId: 9, effectiveFrom: '2027-02-01', vatRate: 0.01, pitRate: 0.01 }), (e) => e.code === 'NOT_FOUND');
  } finally { for (const f of ['categories', 'rates', 'addRate']) taxModel[f].mock.restore(); }
});

test('export worker: builds the three sheets as a real .xlsx and marks the job done', async (t) => {
  const ExcelJS = require('exceljs');
  const env = require('../src/config/env');
  const exportService = require('../src/services/taxExportService');
  const shopProfile = require('../src/services/shopProfile');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxx-'));
  const keep = env.taxExport.dir;
  env.taxExport.dir = dir;
  t.after(() => { env.taxExport.dir = keep; fs.rmSync(dir, { recursive: true, force: true }); });
  const job = { id: 7, kind: 'bundle', period_from: '2026-09-01', period_to: '2026-09-30' };
  const finished = [];
  mock.method(taxModel, 'claimNextExport', async () => job);
  mock.method(taxModel, 'finishExport', async (id, out) => { finished.push([id, out]); });
  mock.method(taxModel, 'failExport', async (id, msg) => { finished.push(['fail', msg]); });
  mock.method(taxModel, 'categories', async () => [{ id: 1, code: 'fnb_service', name: 'Dịch vụ ăn uống' }, { id: 2, code: 'goods_distribution', name: 'Hàng hóa' }, { id: 3, code: 'none', name: 'Không thuế' }]);
  mock.method(taxModel, 'revenueRows', async () => [
    { day: '2026-09-01', categoryId: 1, lines: 40, gross: 1500000, discount: 20000, net: 1480000, vat: 44400, pit: 22200 },
    { day: '2026-09-01', categoryId: 2, lines: 5, gross: 100000, discount: 0, net: 100000, vat: 1000, pit: 500 },
    { day: '2026-09-02', categoryId: 1, lines: 30, gross: 1000000, discount: 0, net: 1000000, vat: 30000, pit: 15000 },
  ]);
  mock.method(taxModel, 'revenueByCategory', async () => [{ categoryId: 1, lines: 70, gross: 2500000, discount: 20000, net: 2480000, vat: 74400, pit: 37200 }, { categoryId: 2, lines: 5, gross: 100000, discount: 0, net: 100000, vat: 1000, pit: 500 }]);
  mock.method(taxModel, 'revenueTotal', async () => 0);
  mock.method(taxModel, 'expenseByTreatment', async () => ({ deductible: 8000000, non_deductible: 0, capex: 0 }));
  mock.method(settingsModel, 'getByPrefix', async () => ({}));
  let page = 0;
  mock.method(expenseModel, 'exportBatch', async () => (page++ === 0 ? [
    { id: 5, expense_date: '2026-09-05', category_name: 'Thuê mặt bằng', ledger_code: 'TMB', tax_treatment: 'deductible', payee: 'Chủ nhà', doc_no: 'PC-1', amount: 8000000, vat_included: 0, source: 'manual', note: 'Tháng 9' },
  ] : []));
  mock.method(shopProfile, 'get', async () => ({ effective: { name: 'Cò Coffee', ownerName: 'Nguyễn Văn A', taxCode: '0123456789', regNo: '01A8', address: '12 Đường Cò' } }));
  t.after(() => { for (const [m, f] of [[taxModel, 'claimNextExport'], [taxModel, 'finishExport'], [taxModel, 'failExport'], [taxModel, 'categories'], [taxModel, 'revenueRows'], [taxModel, 'revenueByCategory'], [taxModel, 'revenueTotal'], [taxModel, 'expenseByTreatment'], [settingsModel, 'getByPrefix'], [expenseModel, 'exportBatch'], [shopProfile, 'get']]) m[f].mock.restore(); });

  assert.equal(await exportService.processNext(), true);
  assert.equal(finished.length, 1, JSON.stringify(finished));
  assert.equal(finished[0][0], 7);
  const { fileName, fileBytes } = finished[0][1];
  assert.match(fileName, /^7-so-thue_2026-09-01_2026-09-30\.xlsx$/);
  assert.ok(fileBytes > 2000);
  assert.deepEqual(fs.readdirSync(dir), [fileName], 'no .part file is left behind');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(dir, fileName));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Sổ doanh thu', 'Sổ chi phí', 'Bảng kê tờ khai']);
  const text = (ws) => { const out = []; ws.eachRow((r) => out.push(r.values.slice(1).join(' | '))); return out.join('\n'); };
  const rev = text(wb.getWorksheet('Sổ doanh thu'));
  assert.match(rev, /CÒ COFFEE/);
  assert.match(rev, /MST: 0123456789/);
  assert.match(rev, /01\/09\/2026 \| 45 \| 1480000 \| 100000 \| 20000 \| 1580000/, 'a day: lines, one column per tax group, discount, net');
  assert.match(rev, /Cộng \| 75 \| 2480000 \| 100000 \| 20000 \| 2580000/);
  const exp = text(wb.getWorksheet('Sổ chi phí'));
  assert.match(exp, /1 \| 05\/09\/2026 \| Thuê mặt bằng \| TMB \| Được trừ \| Chủ nhà \| PC-1 \| 8000000/);
  assert.match(exp, /Cộng chi phí được trừ \|[ |]*8000000/);
  const decl = text(wb.getWorksheet('Bảng kê tờ khai'));
  assert.match(decl, /Thuế GTGT ước tính \| 0/, 'revenue 2,58M is far below the threshold: nothing due');
  assert.match(decl, /Cần kế toán xác nhận|kế toán xác nhận/);
  assert.equal(exportService.filePath({ status: 'done', file_name: fileName }), path.join(dir, fileName));
  assert.equal(exportService.filePath({ status: 'queued', file_name: fileName }), null);
  assert.equal(exportService.filePath({ status: 'done', file_name: '../etc/passwd' }), null, 'a file name can never leave the export folder');
});

test('export queue: validation and de-duplication', async () => {
  const exportService = require('../src/services/taxExportService');
  let open = null;
  const inserted = [];
  mock.method(taxModel, 'findOpenExport', async () => open);
  mock.method(taxModel, 'insertExport', async (e) => { inserted.push(e); return 40 + inserted.length; });
  try {
    const today = shopDay();
    assert.deepEqual(await exportService.enqueue({ kind: 'bundle', from: '2026-09-01', to: '2026-09-30', userId: 1 }), { id: 41, reused: false });
    open = { id: 41 };
    assert.deepEqual(await exportService.enqueue({ kind: 'bundle', from: '2026-09-01', to: '2026-09-30', userId: 1 }), { id: 41, reused: true }, 'a second click returns the waiting job');
    await assert.rejects(exportService.enqueue({ kind: 'nope', from: '2026-09-01', to: '2026-09-30' }), /Loại sổ/);
    await assert.rejects(exportService.enqueue({ kind: 'bundle', from: '2026-09-30', to: '2026-09-01' }), /Khoảng ngày/);
    await assert.rejects(exportService.enqueue({ kind: 'bundle', from: '2025-01-01', to: '2026-09-30' }), /một năm/);
    await assert.rejects(exportService.enqueue({ kind: 'bundle', from: today, to: addDays(today, 3) }), /tương lai/);
  } finally { taxModel.findOpenExport.mock.restore(); taxModel.insertExport.mock.restore(); }
});
