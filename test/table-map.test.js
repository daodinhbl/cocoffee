const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start } = require('./helpers/adminFixture');

test('sơ đồ bàn 2.5D', async (t) => {
  const fx = await start();
  t.after(() => { fx.stop(); mock.restoreAll(); });
  const tableModel = require('../src/models/tableModel');
  const saved = [];
  mock.method(tableModel, 'saveLayout', async (items) => { saved.push(...items); });
  const { c: admin } = await fx.login();
  const token = await fx.csrfOf(admin);
  await t.test('the page lists the active tables with their state, on an automatic grid when unplaced', async () => {
    const html = await (await admin.get('/admin/tables/map')).text();
    assert.match(html, /Sơ đồ bàn/);
    assert.match(html, /data-id="1"[^>]*data-state="busy"/);
    assert.match(html, /data-id="2"[^>]*data-state="free"/);
    assert.match(html, /href="\/admin\/pos\?table=1"/);
    assert.match(html, /table-map\.js/);
    assert.match(html, /id="map-csrf"/);
    const list = await (await admin.get('/admin/tables')).text();
    assert.match(list, /href="\/admin\/tables\/map"/);
  });

  await t.test('saving needs the CSRF header and validates positions and shapes', async () => {
    const send = (body, csrf) => admin.req('/admin/tables/layout', { method: 'POST', json: body, headers: { 'x-csrf-token': csrf ?? '' } });
    assert.equal((await send({ tables: [{ id: 1, x: 100, y: 200, shape: 'round' }] }, '')).status, 403);
    assert.equal((await send({ tables: [{ id: 1, x: 1001, y: 200, shape: 'round' }] }, token)).status, 400);
    assert.equal((await send({ tables: [{ id: 1, x: 10, y: 20, shape: 'triangle' }] }, token)).status, 400);
    assert.equal((await send({ tables: [] }, token)).status, 400);
    assert.equal(saved.length, 0);
    const ok = await send({ tables: [{ id: 1, x: 100.4, y: 200, shape: 'round' }, { id: 2, x: 500, y: 600, shape: 'long' }] }, token);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, saved: 2 });
    assert.deepEqual(saved, [{ id: 1, x: 100, y: 200, shape: 'round' }, { id: 2, x: 500, y: 600, shape: 'long' }]);
  });
});
