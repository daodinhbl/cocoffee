const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start } = require('./helpers/adminFixture');

test('/admin/inventory: STT column, zebra rows, 20 per page, server-side search', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const inventoryService = require('../src/services/inventoryService');
  const items = Array.from({ length: 45 }, (_, k) => ({
    id: k + 1, sku: `SKU${String(k + 1).padStart(3, '0')}`, name: k === 6 ? 'Sữa đặc' : `Nguyên liệu ${k + 1}`, unit: 'g',
    quantity_on_hand: k % 5 === 0 ? 0 : 100, min_stock: 10, avg_cost: 100, stock_value: 10000, is_active: 1, is_low: k % 5 === 0 ? 1 : 0, image_url: '',
  }));
  mock.method(inventoryService, 'listWithValue', async () => ({ items, stockValue: 123456 }));
  const { c: admin } = await fx.login();
  const rows = (html) => [...html.matchAll(/<tr data-row class="([^"]*)">\s*<td[^>]*>(\d+)<\/td>/g)].map((m) => ({ cls: m[1], stt: Number(m[2]) }));
  const flat = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  let html = await (await admin.get('/admin/inventory')).text();
  let r = rows(html);
  assert.equal(r.length, 20);
  assert.deepEqual([r[0].stt, r[19].stt], [1, 20]);
  assert.match(html, />STT</);
  assert.ok(r.filter((x) => x.stt % 2 === 1).every((x) => x.cls.includes('bg-blue-50/70')), 'odd rows are light blue at 70%');
  assert.ok(r.filter((x) => x.stt % 2 === 0).every((x) => !x.cls.includes('bg-blue-50/70')), 'even rows stay white');
  assert.match(flat(html), /Hiển thị 1–20 trong 45 mặt hàng/);
  assert.match(flat(html), /Trang 1 \/ 3/);

  html = await (await admin.get('/admin/inventory?page=3')).text();
  r = rows(html);
  assert.deepEqual(r.map((x) => x.stt), [41, 42, 43, 44, 45], 'numbering continues across pages');
  assert.ok(r[0].cls.includes('bg-blue-50/70'), '41 is odd');
  assert.match(flat(html), /Hiển thị 41–45 trong 45 mặt hàng/);
  assert.equal(rows(await (await admin.get('/admin/inventory?page=99')).text())[0].stt, 41, 'past the end -> last page');

  html = await (await admin.get('/admin/inventory?q=sua%20dac')).text();
  r = rows(html);
  assert.equal(r.length, 1, 'accent-insensitive search');
  assert.equal(r[0].stt, 1, 'numbering restarts for the result list');
  assert.match(html, /value="sua dac"/);

  html = await (await admin.get('/admin/inventory?low=1&page=1')).text();
  assert.equal(rows(html).length, 9, '45 items, every 5th is low -> 9');
  assert.match(flat(html), /Hiển thị 1–9 trong 9 mặt hàng/);
  assert.doesNotMatch(flat(html), /Trang 1 \/ 1/, 'a single page has no page buttons');

  html = await (await admin.get('/admin/inventory?q=zzzz')).text();
  assert.equal(rows(html).length, 0);
  assert.match(html, /Không có mặt hàng phù hợp/);

  await t.test('classification tabs', async () => {
    const mixed = [
      { sku: 'RM-COFFEE', name: 'Cà phê rang xay', unit: 'g' }, { sku: 'RM-MILK', name: 'Sữa đặc', unit: 'g' },
      { sku: 'RM-CUP', name: 'Ly nhựa + nắp', unit: 'pcs' }, { sku: 'RM-STRAW', name: 'Ống hút', unit: 'pcs' },
      { sku: 'GD-AQUAFINA', name: 'Nước Aquafina 500ml', unit: 'bottle' }, { sku: 'GD-555', name: 'Thuốc lá 555', unit: 'pack' },
      { sku: 'XYZ-1', name: 'Dụng cụ lạ', unit: 'pcs' }, { sku: 'RM-SUGAR', name: 'Đường', unit: 'g', group_code: 'other' },
    ].map((x, k) => ({ id: k + 1, quantity_on_hand: 5, min_stock: 10, avg_cost: 1, stock_value: 5, is_active: 1, is_low: 1, image_url: '', ...x }));
    mock.method(inventoryService, 'listWithValue', async () => ({ items: mixed, stockValue: 1 }));
    const names = (html) => [...html.matchAll(/<a href="\/admin\/inventory\/\d+" class="[^"]*">([^<]+)<\/a>/g)].map((m) => m[1]);
    const html = await (await admin.get('/admin/inventory')).text();
    const nav = html.slice(html.indexOf('aria-label="Phân loại nguyên liệu"'), html.indexOf('</nav>', html.indexOf('aria-label="Phân loại nguyên liệu"')));
    assert.match(flat(nav), /Tất cả 8 Nguyên liệu pha chế 2 Bao bì &amp; vật dụng 2 Hàng bán lẻ 2 Khác 2/);
    assert.deepEqual(names(await (await admin.get('/admin/inventory?group=packaging')).text()), ['Ly nhựa + nắp', 'Ống hút']);
    assert.deepEqual(names(await (await admin.get('/admin/inventory?group=retail')).text()), ['Nước Aquafina 500ml', 'Thuốc lá 555']);
    assert.deepEqual(names(await (await admin.get('/admin/inventory?group=raw')).text()), ['Cà phê rang xay', 'Sữa đặc']);
    assert.deepEqual(names(await (await admin.get('/admin/inventory?group=other')).text()).sort(), ['Dụng cụ lạ', 'Đường'].sort(), 'a stored group wins over the guess');
    const g = await (await admin.get('/admin/inventory?group=retail&low=1&q=thuoc')).text();
    assert.deepEqual(names(g), ['Thuốc lá 555']);
    assert.match(g, /href="\/admin\/inventory\?group=raw&amp;low=1&amp;q=thuoc"/, 'tabs keep the search and the low-stock filter');
    assert.match(g, /name="group" value="retail"/, 'search form keeps the tab');
    assert.deepEqual(names(await (await admin.get('/admin/inventory?group=bogus')).text()).length, 8, 'an unknown group is ignored');
    assert.match(await (await admin.get('/admin/inventory')).text(), /<select id="i-group" name="group_code"/);
  });
});
