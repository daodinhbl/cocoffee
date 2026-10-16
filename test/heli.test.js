/** Heli (/api/heli/*): the SQL guard, the admin-only database tool, the routes. OpenAI and MySQL are faked. */
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const { start, PASSWORD } = require('./helpers/adminFixture');
const sqlGuard = require('../src/services/heli/sqlGuard');

test('sqlGuard refuses secrets, writes, several statements and tricks', () => {
  const refused = [
    'SELECT password_hash FROM users',
    'SELECT * FROM users',
    'select * from `users`',
    'SELECT * FROM app_settings',
    'SELECT * FROM zalo_tokens',
    'SELECT * FROM payon_payments',
    'SELECT * FROM audit_log',
    'SELECT * FROM orders, users',
    'SELECT * FROM orders o, app_settings s',
    'SELECT * FROM mysql.user',
    'SELECT * FROM information_schema.tables',
    'SELECT * FROM orders JOIN users ON users.id = orders.id',
    'SELECT (SELECT value FROM app_settings LIMIT 1)',
    'SELECT * FROM orders WHERE id IN (SELECT id FROM users)',
    'INSERT INTO orders (id) VALUES (1)',
    'UPDATE orders SET total = 0',
    'DELETE FROM orders',
    'DROP TABLE orders',
    'SELECT 1; DELETE FROM orders',
    'SELECT * FROM orders; SELECT * FROM users',
    'SELECT * FROM orders /* users */',
    'SELECT * FROM orders -- x',
    'SELECT * FROM orders # x',
    "SELECT * FROM orders INTO OUTFILE '/tmp/x'",
    'SELECT SLEEP(30)',
    'SELECT LOAD_FILE(0x2f6574632f706173737764)',
    'SELECT @@version',
    'SELECT * FROM orders FOR UPDATE',
    'SHOW GRANTS',
    'SHOW CREATE TABLE users',
    'DESCRIBE users',
    'EXPLAIN SELECT * FROM users',
    'SET @a = 1',
    "SELECT 'unterminated FROM orders",
    '',
  ];
  for (const sql of refused) assert.equal(sqlGuard.check(sql).ok, false, `should refuse: ${sql}`);
});

test('sqlGuard allows plain reads of the shop tables', () => {
  const allowed = [
    'SELECT COUNT(*) AS n FROM orders WHERE DATE(created_at) = CURDATE()',
    "SELECT status, SUM(total) FROM orders WHERE note = 'users; app_settings' GROUP BY status;",
    'SELECT p.name, SUM(oi.quantity) q FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY p.name ORDER BY q DESC LIMIT 5',
    'select name, quantity_on_hand from inventory_items where is_low = 1',
    'DESCRIBE orders',
    'show tables',
  ];
  for (const sql of allowed) assert.equal(sqlGuard.check(sql).ok, true, `should allow: ${sql}`);
  assert.equal(sqlGuard.check('show tables').virtual, 'tables');
});

test('Heli routes', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const { pool } = require('../src/config/db');
  const openai = require('../src/services/heli/openai');
  const agent = require('../src/services/heli/agent');

  const statements = [];
  let connections = 0;
  mock.method(pool, 'getConnection', async () => {
    connections += 1;
    return {
      query: async (q) => { statements.push(typeof q === 'string' ? q : q.sql); return [[{ n: 7 }]]; },
      release() {},
    };
  });

  async function api(path, token, json) {
    const res = await fetch(fx.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(json || {}),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch (_) { body = text; }
    return { status: res.status, body };
  }
  const login = async (username) => (await api('/api/auth/login', null, { username, password: PASSWORD })).body.token;
  const boss = await login('boss');
  const cashier = await login('thungan');

  // the model "decides" to run `sql`, then answers with whatever the tool returned
  const modelRuns = (sql, seen) => mock.method(openai, 'chat', async (messages, tools) => {
    seen.push({ tools, last: messages[messages.length - 1] });
    const last = messages[messages.length - 1];
    if (last.role === 'tool') return { role: 'assistant', content: `Kết quả: ${last.content}` };
    return { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mysql_query', arguments: JSON.stringify({ sql }) } }] };
  });

  await t.test('needs a bearer token', async () => {
    assert.equal((await api('/api/heli/chat', null, { message: 'xin chào' })).status, 401);
  });

  await t.test('cashier gets no database tool, and a forced tool call is refused without touching MySQL', async () => {
    agent.reset(2);
    const seen = [];
    const m = modelRuns('SELECT COUNT(*) FROM orders', seen);
    const before = connections;
    const r = await api('/api/heli/chat', cashier, { message: 'hôm nay bao nhiêu đơn?' });
    m.mock.restore();
    assert.equal(r.status, 200);
    assert.equal(seen[0].tools, undefined, 'tools are not offered to a cashier');
    assert.match(r.body.reply, /chỉ quản trị viên/);
    assert.equal(connections, before, 'MySQL untouched');
    const direct = await agent.runTool({ function: { name: 'mysql_query', arguments: '{"sql":"SELECT 1"}' } }, { id: 2, role: 'cashier' });
    assert.match(direct, /Từ chối/);
    assert.equal(connections, before);
  });

  await t.test('admin: a read runs inside a READ ONLY transaction that is rolled back', async () => {
    agent.reset(1);
    statements.length = 0;
    const seen = [];
    const m = modelRuns('SELECT COUNT(*) AS n FROM orders', seen);
    const r = await api('/api/heli/chat', boss, { message: 'hôm nay bao nhiêu đơn?' });
    m.mock.restore();
    assert.equal(r.status, 200);
    assert.ok(seen[0].tools.length === 1, 'admin is offered mysql_query');
    assert.match(r.body.reply, /"n":7/);
    assert.deepEqual(statements, ['START TRANSACTION READ ONLY', 'SELECT COUNT(*) AS n FROM orders', 'ROLLBACK']);
  });

  for (const sql of ['SELECT password_hash FROM users', 'DELETE FROM orders', 'SELECT 1; SELECT 2', 'SELECT * FROM app_settings']) {
    await t.test(`admin: "${sql}" is refused before MySQL`, async () => {
      agent.reset(1);
      const seen = [];
      const before = connections;
      const m = modelRuns(sql, seen);
      const r = await api('/api/heli/chat', boss, { message: 'thử' });
      m.mock.restore();
      assert.equal(r.status, 200);
      assert.match(r.body.reply, /Từ chối/);
      assert.equal(connections, before);
    });
  }

  await t.test('history is cut to 20 messages and an empty message is refused', async () => {
    agent.reset(1);
    const m = mock.method(openai, 'chat', async (messages) => ({ role: 'assistant', content: `n=${messages.length}` }));
    let last;
    for (let i = 0; i < 15; i += 1) last = await api('/api/heli/chat', boss, { message: `câu ${i}` });
    m.mock.restore();
    assert.equal(last.status, 200);
    assert.ok(Number(/n=(\d+)/.exec(last.body.reply)[1]) <= 22, 'system + at most 20 kept messages + the new one');
    assert.equal((await api('/api/heli/chat', boss, { message: '   ' })).status, 400);
  });

  await t.test('tts strips markdown and links; stt needs audio; both pass through the faked OpenAI', async () => {
    const said = [];
    const s = mock.method(openai, 'speak', async (text) => { said.push(text); return Buffer.from('ID3'); });
    const res = await fetch(`${fx.base}/api/heli/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cashier}` },
      body: JSON.stringify({ text: '**Xin chào** xem https://x.test/a `ok` [liên kết](https://y.test)' }),
    });
    s.mock.restore();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(said[0], 'Xin chào xem ok liên kết');

    const empty = await fetch(`${fx.base}/api/heli/stt`, { method: 'POST', headers: { 'content-type': 'audio/mp4', authorization: `Bearer ${boss}` } });
    assert.equal(empty.status, 400);
    const tr = mock.method(openai, 'transcribe', async (buf, ext) => `${buf.length} ${ext}`);
    const ok = await fetch(`${fx.base}/api/heli/stt`, { method: 'POST', headers: { 'content-type': 'audio/mp4', authorization: `Bearer ${boss}` }, body: Buffer.from('abcd') });
    tr.mock.restore();
    assert.deepEqual(await ok.json(), { text: '4 m4a' });
  });

  await t.test('upstream failure shows a Vietnamese message without details; no key configured = 503', async () => {
    const m = mock.method(openai, 'chat', async () => { throw require('../src/utils/httpError').AppError ? new (require('../src/utils/httpError').AppError)(502, 'HELI_UPSTREAM', 'Heli tạm thời không phản hồi') : null; });
    agent.reset(1);
    const r = await api('/api/heli/chat', boss, { message: 'alo' });
    m.mock.restore();
    assert.equal(r.status, 502);
    assert.equal(r.body.error.message, 'Heli tạm thời không phản hồi');
    const env = require('../src/config/env');
    const saved = env.heli.apiKey;
    env.heli.apiKey = '';
    const off = await api('/api/heli/chat', boss, { message: 'alo' });
    env.heli.apiKey = saved;
    assert.equal(off.status, 503);
  });
});
