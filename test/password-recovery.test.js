const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const bcrypt = require('bcryptjs');

const userModel = require('../src/models/userModel');
const settingsModel = require('../src/models/settingsModel');
const auditModel = require('../src/models/auditModel');
const recovery = require('../src/services/passwordRecovery');

function setup() {
  const store = {};
  const user = { id: 7, username: 'chuquan', role: 'admin', is_active: 1, password_hash: 'old' };
  let newHash = null;
  mock.method(userModel, 'findByUsername', async (n) => (n === 'chuquan' ? user : null));
  mock.method(userModel, 'setPassword', async (_id, h) => { newHash = h; });
  mock.method(settingsModel, 'setMany', async (v) => Object.assign(store, v));
  mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries(Object.entries(store).filter(([k]) => k.startsWith(p))));
  mock.method(auditModel, 'write', async () => {});
  recovery.resetLimits();
  return { store, getHash: () => newHash };
}

test('recovery code: format, reset, one-time use', async (t) => {
  const s = setup();
  t.after(() => mock.restoreAll());
  const code = await recovery.issueFor(7);
  assert.match(code, /^([A-HJ-NP-Z2-9]{4}-){3}[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(!JSON.stringify(s.store).includes(code), 'code is stored hashed only');

  const r = await recovery.reset({ username: 'chuquan', code: code.toLowerCase().replace(/-/g, ' '), newPassword: 'mat-khau-moi-12', confirm: 'mat-khau-moi-12', ip: '1.1.1.1' });
  assert.equal(r.username, 'chuquan');
  assert.ok(await bcrypt.compare('mat-khau-moi-12', s.getHash()));
  assert.notEqual(r.newCode, code);
  await assert.rejects(recovery.reset({ username: 'chuquan', code, newPassword: 'mat-khau-moi-13', confirm: 'mat-khau-moi-13' }), { code: 'BAD_RECOVERY' });   // old code is dead
  await recovery.reset({ username: 'chuquan', code: r.newCode, newPassword: 'mat-khau-moi-14', confirm: 'mat-khau-moi-14' });
});

test('recovery code: weak password keeps the code, wrong tries lock out', async (t) => {
  setup();
  t.after(() => mock.restoreAll());
  const code = await recovery.issueFor(7);
  await assert.rejects(recovery.reset({ username: 'chuquan', code, newPassword: 'ngan', confirm: 'ngan' }), { code: 'WEAK_PASSWORD' });
  await assert.rejects(recovery.reset({ username: 'chuquan', code, newPassword: 'mat-khau-moi-12', confirm: 'khac-nhau-1234' }), { code: 'VALIDATION' });
  for (let i = 0; i < recovery.MAX_FAILS; i++) await assert.rejects(recovery.reset({ username: 'chuquan', code: 'AAAA-AAAA-AAAA-AAAA', newPassword: 'mat-khau-moi-12', confirm: 'mat-khau-moi-12', ip: '9.9.9.9' }), { code: 'BAD_RECOVERY' });
  await assert.rejects(recovery.reset({ username: 'chuquan', code, newPassword: 'mat-khau-moi-12', confirm: 'mat-khau-moi-12', ip: '9.9.9.9' }), { code: 'RATE_LIMITED' });
});

test('recovery code: unknown user looks the same as a wrong code', async (t) => {
  setup();
  t.after(() => mock.restoreAll());
  await assert.rejects(recovery.reset({ username: 'khongco', code: 'AAAA-AAAA-AAAA-AAAA', newPassword: 'mat-khau-moi-12', confirm: 'mat-khau-moi-12' }), { code: 'BAD_RECOVERY' });
});
