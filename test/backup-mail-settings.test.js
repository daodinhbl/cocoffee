process.env.SMTP_HOST = '';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const settingsModel = require('../src/models/settingsModel');
const backupService = require('../src/services/backupService');
const svc = require('../src/services/backupMailService');

test('backup e-mail typed in Web Admin wins over the environment and never echoes the password', async (t) => {
  const sent = [];
  svc.setTransportFactory((c) => ({ sendMail: async (m) => { sent.push({ ...m, smtp: c.smtpHost }); } }));
  let stored = {};
  mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries(Object.entries(stored).filter(([k]) => k.startsWith(p))));
  mock.method(settingsModel, 'setMany', async (v) => { stored = { ...stored, ...v }; });
  mock.method(backupService, 'createTemp', async () => ({ name: 'x.sql.gz', file: __filename, cleanup: async () => {} }));
  t.after(() => mock.restoreAll());

  assert.equal((await svc.view()).configured, false, 'nothing in the environment, nothing typed');
  await assert.rejects(svc.save({ to: 'khong-phai-email' }, 1), { code: 'VALIDATION' });
  await assert.rejects(svc.save({ to: 'a@b.vn', host: 'smtp bad host' }, 1), { code: 'VALIDATION' });
  await assert.rejects(svc.save({ to: 'a@b.vn', port: '70000' }, 1), { code: 'VALIDATION' });

  await svc.save({ to: ' chu@gmail.com ', host: 'smtp.gmail.com', port: '465', secure: '1', user: 'chu@gmail.com', pass: 'abcd efgh ijkl mnop', enabled: '1' }, 1);
  const v = await svc.view();
  assert.equal(v.configured, true);
  assert.equal(v.to, 'chu@gmail.com');
  assert.equal(v.passSet, true);
  assert.ok(!JSON.stringify(v).includes('abcd'), 'the password is never in what the screen gets');

  const r = await svc.sendNow();
  assert.equal(r.sent, true);
  assert.equal(sent[0].to, 'chu@gmail.com');
  assert.equal(sent[0].smtp, 'smtp.gmail.com');

  await svc.save({ to: 'khac@gmail.com', host: 'smtp.gmail.com', user: 'chu@gmail.com', pass: '' }, 1);   // blank password keeps the saved one
  assert.equal((await svc.view()).passSet, true);
  assert.equal((await svc.view()).to, 'khac@gmail.com');

  await svc.save({ to: 'khac@gmail.com', enabled: '0' }, 1);
  assert.equal((await svc.view()).configured, false, 'switched off');
  assert.equal(await svc.runIfDue(new Date('2026-10-18T03:00:00Z')), 'not-configured');
});
