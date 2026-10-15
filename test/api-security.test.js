/**
 * JSON API security rules (api.json security_prereqs P0): token audience/issuer, revocation on password change,
 * the must-change-password gate, admin-only debt settlement, admin-only /api/admin/*, plus Idempotency-Key.
 * Real Express app and middleware, data layer faked (helpers/adminFixture.js). No MySQL.
 */
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { start, PASSWORD } = require('./helpers/adminFixture');

test('API security', async (t) => {
  // captured before the fixture replaces it with a recorder: some tests below need the real payment logic
  const orderService = require('../src/services/orderService');
  const realPayOrder = orderService.payOrder;
  const fx = await start();
  t.after(fx.stop);
  // guard: nothing in this file may reach a real database (a developer .env can point at one)
  const { pool } = require('../src/config/db');
  const realDb = mock.method(pool, 'query', async () => { throw new Error('test reached the real database'); });
  t.after(() => assert.equal(realDb.mock.callCount(), 0, 'no query reached the real pool'));

  const orderModel = require('../src/models/orderModel');
  const customerModel = require('../src/models/customerModel');
  const env = require('../src/config/env');
  const called = (name) => fx.calls.filter((c) => c.name === name);

  async function api(method, path, { token, json, headers = {} } = {}) {
    const res = await fetch(fx.base + path, {
      method,
      headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: json ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { body = text; }
    return { status: res.status, body, headers: res.headers };
  }
  const login = async (username, password = PASSWORD) => (await api('POST', '/api/auth/login', { json: { username, password } })).body;

  const boss = await login('boss');
  const cashier = await login('thungan');

  await t.test('login issues an audience-bound token with a password stamp; /auth/me never shows the stamp', async () => {
    assert.equal(boss.must_change_password, false);
    assert.equal(boss.user.role, 'admin');
    const claims = jwt.decode(boss.token);
    assert.equal(claims.aud, 'pos-api');
    assert.equal(claims.iss, 'cocoffee');
    assert.match(claims.pws, /^[0-9a-f]{16}$/);
    assert.equal(claims.mcp, 0);
    const me = await api('GET', '/api/auth/me', { token: boss.token });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.user, { id: 1, username: 'boss', full_name: 'Chủ Quán', role: 'admin', is_active: 1, must_change_password: false });
  });

  await t.test('the Web Admin cookie JWT is not accepted as a bearer token, nor a token without the API audience', async () => {
    const { c } = await fx.login();
    const cookieJwt = c.jar.get('cc_admin');
    assert.ok(cookieJwt, 'web login produced a session cookie');
    assert.equal(jwt.decode(cookieJwt).aud, 'admin-web');
    const r = await api('GET', '/api/tables', { token: cookieJwt });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'UNAUTHORIZED');

    const legacy = jwt.sign({ sub: 1, role: 'admin' }, env.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });   // the old token format
    assert.equal((await api('GET', '/api/tables', { token: legacy })).status, 401);
    const noStamp = jwt.sign({ sub: 1, role: 'admin' }, env.jwt.secret, { algorithm: 'HS256', audience: 'pos-api', issuer: 'cocoffee', expiresIn: '1h' });
    assert.equal((await api('GET', '/api/tables', { token: noStamp })).status, 401, 'a token without a password stamp is refused');
    const otherIssuer = jwt.sign({ sub: 1, role: 'admin', pws: jwt.decode(boss.token).pws }, env.jwt.secret, { algorithm: 'HS256', audience: 'pos-api', issuer: 'someone-else', expiresIn: '1h' });
    assert.equal((await api('GET', '/api/tables', { token: otherIssuer })).status, 401);
    assert.equal((await api('GET', '/api/tables', { token: boss.token })).status, 200);
  });

  await t.test('an API bearer token cannot be used as the admin cookie', async () => {
    const res = await fx.client().req('/admin/dashboard', { headers: { cookie: `cc_admin=${boss.token}` } });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^\/admin\/login/);
  });

  await t.test('a cashier gets 403 on every /api/admin/* endpoint and on the admin-only list variants', async () => {
    const paths = [
      ['GET', '/api/admin/notifications'], ['GET', '/api/admin/dashboard'], ['GET', '/api/admin/reports'],
      ['GET', '/api/admin/customers'], ['GET', '/api/admin/customers/reconciliation'], ['GET', '/api/admin/customers/5'],
      ['GET', '/api/admin/customers/5/statement'], ['POST', '/api/admin/customers'], ['PUT', '/api/admin/customers/5'],
      ['POST', '/api/admin/customers/5/collect'], ['POST', '/api/admin/customers/5/adjust'],
      ['GET', '/api/admin/menu'], ['GET', '/api/admin/bom'], ['PUT', '/api/admin/products/1/image'], ['DELETE', '/api/admin/inventory/1/image'],
      ['GET', '/api/admin/zalo'], ['PUT', '/api/admin/zalo/debt-recipient'], ['PUT', '/api/admin/zalo/chatbot-info'], ['POST', '/api/admin/zalo/register-webhook'],
      ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings/printer'], ['GET', '/api/admin/users'], ['POST', '/api/admin/users'],
      ['PUT', '/api/admin/users/2/password'], ['PUT', '/api/admin/users/1/active'], ['GET', '/api/admin/does-not-exist'],
      ['GET', '/api/tables?all=1'], ['GET', '/api/inventory?all=1'], ['GET', '/api/inventory/1'], ['GET', '/api/inventory/purchases'],
    ];
    fx.calls.length = 0;
    for (const [method, path] of paths) {
      const r = await api(method, path, { token: cashier.token, json: method === 'GET' ? undefined : { password: 'x'.repeat(12), active: false } });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.error.code, 'FORBIDDEN', `${method} ${path}`);
    }
    assert.equal(fx.calls.length, 0, 'no write reached the data layer');
    // the same lists without the admin switch still work for the POS
    assert.equal((await api('GET', '/api/tables', { token: cashier.token })).status, 200);
    assert.equal((await api('GET', '/api/inventory', { token: cashier.token })).status, 200);
    assert.equal((await api('GET', '/api/admin/does-not-exist', { token: boss.token })).status, 404);
  });

  await t.test('a token issued before a password change is rejected; change-password answers a fresh token', async () => {
    const before = await login('boss');
    assert.equal((await api('GET', '/api/tables', { token: before.token })).status, 200);
    const changed = await api('POST', '/api/auth/change-password', { token: before.token, json: { current_password: PASSWORD, new_password: 'A-brand-new-pass-1' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.ok, true);
    assert.equal(jwt.decode(changed.body.token).aud, 'pos-api');
    const old = await api('GET', '/api/tables', { token: before.token });
    assert.equal(old.status, 401, 'old token revoked');
    assert.equal(old.body.error.code, 'UNAUTHORIZED');
    assert.equal((await api('GET', '/api/tables', { token: boss.token })).status, 401, 'every older token is revoked');
    assert.equal((await api('GET', '/api/tables', { token: changed.body.token })).status, 200, 'the fresh token works');
    fx.resetPasswords();
    assert.equal((await api('GET', '/api/tables', { token: boss.token })).status, 200, 'stamp back to the original password');
  });

  await t.test('an admin password reset revokes the tokens of that account', async () => {
    const victim = await login('thungan');
    const r = await api('PUT', '/api/admin/users/2/password', { token: boss.token, json: { password: 'Reset-by-the-boss-1' } });
    assert.equal(r.status, 200);
    assert.equal((await api('GET', '/api/tables', { token: victim.token })).status, 401);
    fx.resetPasswords();
  });

  await t.test('change-password: same password, wrong current password, too short, demo account', async () => {
    fx.calls.length = 0;
    const same = await api('POST', '/api/auth/change-password', { token: boss.token, json: { current_password: PASSWORD, new_password: PASSWORD } });
    assert.equal(same.status, 400);
    assert.equal(same.body.error.code, 'VALIDATION');
    const wrong = await api('POST', '/api/auth/change-password', { token: boss.token, json: { current_password: 'not-it-at-all', new_password: 'A-brand-new-pass-1' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'BAD_CREDENTIALS');
    const short = await api('POST', '/api/auth/change-password', { token: boss.token, json: { current_password: PASSWORD, new_password: 'short' } });
    assert.equal(short.body.error.code, 'WEAK_PASSWORD');
    assert.equal(called('user.setPassword').length, 0);

    const demoBefore = { ...env.demo };
    Object.assign(env.demo, { enabled: true, username: 'admin', password: 'admin' });
    try {
      const demo = await login('admin', 'admin');
      assert.equal(demo.must_change_password, false, 'the public demo account is never forced to change');
      const r = await api('POST', '/api/auth/change-password', { token: demo.token, json: { current_password: 'admin', new_password: 'A-brand-new-pass-1' } });
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'DEMO_ACCOUNT');
    } finally {
      Object.assign(env.demo, demoBefore);
    }
  });

  await t.test('an admin with a weak password gets 403 MUST_CHANGE_PASSWORD until change-password', async () => {
    fx.resetPasswords();
    const weak = await login('admin', 'admin');
    assert.equal(weak.must_change_password, true);
    assert.equal(jwt.decode(weak.token).mcp, 1);
    for (const path of ['/api/tables', '/api/orders', '/api/admin/dashboard', '/api/pos/bootstrap', '/api/nope']) {
      const r = await api('GET', path, { token: weak.token });
      assert.equal(r.status, 403, path);
      assert.equal(r.body.error.code, 'MUST_CHANGE_PASSWORD', path);
    }
    const me = await api('GET', '/api/auth/me', { token: weak.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.must_change_password, true);

    const changed = await api('POST', '/api/auth/change-password', { token: weak.token, json: { current_password: 'admin', new_password: 'A-much-better-pw1' } });
    assert.equal(changed.status, 200);
    assert.equal(jwt.decode(changed.body.token).mcp, 0);
    assert.equal((await api('GET', '/api/tables', { token: changed.body.token })).status, 200);
    assert.equal((await api('GET', '/api/admin/dashboard', { token: changed.body.token })).status, 200);
    assert.equal((await api('GET', '/api/auth/me', { token: changed.body.token })).body.user.must_change_password, false);
    assert.equal((await api('GET', '/api/auth/me', { token: weak.token })).status, 401, 'the flagged token died with the old password');
    fx.resetPasswords();
  });

  await t.test('a cashier is never forced to change a short password (same as the Web Admin)', async () => {
    const bcrypt = require('bcryptjs');
    const userModel = require('../src/models/userModel');
    userModel.findByUsername.mock.mockImplementationOnce(async () => ({ id: 2, username: 'thungan', full_name: 'Thu Ngân', role: 'cashier', is_active: 1, password_hash: bcrypt.hashSync('1234', 4) }));
    const short = await login('thungan', '1234');
    assert.equal(short.must_change_password, false);
    assert.equal(jwt.decode(short.token).mcp, 0);
  });

  await t.test('only an admin can pay a completed debt order; checked inside payOrder after the row lock', async () => {
    const DEBT = { ...fx.ORDER, id: 43, status: 'completed', payment_status: 'unpaid', customer_id: 5, total: 79000 };
    const WALKIN = { ...fx.ORDER, id: 44, status: 'completed', payment_status: 'unpaid', customer_id: null, total: 79000 };
    const getById = orderModel.getById.mock;
    const lockReads = [];
    getById.mockImplementation(async (id, _conn, opts = {}) => {
      if (opts.forUpdate) lockReads.push(Number(id));
      return Number(id) === 43 ? DEBT : Number(id) === 44 ? WALKIN : fx.ORDER;
    });
    const payments = [];
    const ledger = [];
    mock.method(orderModel, 'insertPayment', async (p) => { payments.push(p); });
    mock.method(orderModel, 'markPaid', async () => {});
    mock.method(customerModel, 'addEntry', async (e) => { ledger.push(e); });
    const pay = (id, token, body = { method: 'cash' }) => {
      orderService.payOrder.mock.mockImplementationOnce(realPayOrder);
      return api('POST', `/api/orders/${id}/pay`, { token, json: body });
    };
    try {
      const denied = await pay(43, cashier.token);
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error.code, 'FORBIDDEN');
      assert.deepEqual(lockReads, [43], 'the role is checked after locking the order row');
      assert.equal(payments.length, 0, 'no payment recorded');
      assert.equal(ledger.length, 0, 'the debt stays open');

      const walkIn = await pay(44, cashier.token);
      assert.equal(walkIn.status, 200, 'a walk-in Zalo bill (no customer) is still collected at the counter');
      assert.equal(payments.length, 1);
      assert.equal(ledger.length, 0);

      const other = await api('POST', '/api/orders/44/pay', { token: cashier.token, json: { method: 'other' } });
      assert.equal(other.status, 400, "a cashier cannot use method 'other'");

      const settled = await pay(43, boss.token, { method: 'transfer', reference: 'FT1' });
      assert.equal(settled.status, 200);
      assert.equal(payments.at(-1).orderId, 43);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].type, 'payment');
      assert.equal(ledger[0].amount, -79000);
    } finally {
      getById.mockImplementation(async () => fx.ORDER);
    }
  });

  await t.test('Idempotency-Key: a retried POST /api/orders creates one order and replays the answer', async () => {
    fx.calls.length = 0;
    const body = { table_id: 2, items: [{ product_id: 1, quantity: 2 }] };
    const headers = { 'idempotency-key': 'tablet-1:order-0001' };
    const first = await api('POST', '/api/orders', { token: cashier.token, json: body, headers });
    const second = await api('POST', '/api/orders', { token: cashier.token, json: body, headers });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(second.body, first.body);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
    assert.equal(called('order.createPos').length, 1, 'the order was created once');
    const mismatch = await api('POST', '/api/orders', { token: cashier.token, json: { ...body, table_id: 1 }, headers });
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_MISMATCH');
    const otherUser = await api('POST', '/api/orders', { token: boss.token, json: body, headers });
    assert.equal(otherUser.status, 201, 'keys are scoped per user');
    assert.equal(called('order.createPos').length, 2);
    assert.equal((await api('POST', '/api/orders', { token: cashier.token, json: body, headers: { 'idempotency-key': 'bad key!' } })).status, 400);
  });

  await t.test('Idempotency-Key on the writes the app replays from its offline queue: executed once', async () => {
    fx.calls.length = 0;
    const headers = { 'idempotency-key': 'off-queue-collect-1' };
    const collect = { amount: 50000, method: 'cash' };
    const a = await api('POST', '/api/admin/customers/5/collect', { token: boss.token, json: collect, headers });
    const b = await api('POST', '/api/admin/customers/5/collect', { token: boss.token, json: collect, headers });
    assert.equal(a.status, 200);
    assert.deepEqual(b.body, a.body);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.equal(called('customer.collect').length, 1, 'the debt was collected once');
    const recv = { quantity: 10, unit_cost: 100 };
    const h2 = { 'idempotency-key': 'off-queue-receive-1' };
    await api('POST', '/api/inventory/1/receive', { token: boss.token, json: recv, headers: h2 });
    await api('POST', '/api/inventory/1/receive', { token: boss.token, json: recv, headers: h2 });
    assert.equal(called('inventory.receive').length, 1, 'the stock was received once');
  });
});
