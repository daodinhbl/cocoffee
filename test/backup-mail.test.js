process.env.SMTP_HOST = 'smtp.example.test';
process.env.SMTP_USER = 'shop@example.test';
process.env.SMTP_PASS = 'app-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock } = require('node:test');
const settingsModel = require('../src/models/settingsModel');
const backupService = require('../src/services/backupService');
const svc = require('../src/services/backupMailService');
const env = require('../src/config/env');

test('daily backup by e-mail', async (t) => {
  const sent = [];
  svc.setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); } }));
  let stored = {};
  mock.method(settingsModel, 'getByPrefix', async () => ({ ...stored }));
  mock.method(settingsModel, 'setMany', async (v) => { stored = { ...stored, ...v }; });
  let cleaned = 0;
  mock.method(backupService, 'createTemp', async () => {
    const file = path.join(os.tmpdir(), `bm-${Date.now()}.sql.gz`);
    fs.writeFileSync(file, Buffer.alloc(4096, 1));
    return { name: 'cocoffee-manual-20261018-020000-abcd.sql.gz', file, cleanup: async () => { cleaned += 1; fs.unlinkSync(file); } };
  });
  t.after(() => mock.restoreAll());
  // 02:05 shop time = 19:05 UTC the day before
  const at = (iso) => new Date(iso);

  await t.test('the recipient defaults to the owner and the clock is shop time (UTC+7)', () => {
    assert.equal(env.backupMail.to, 'dinhxuandaodc.435@gmail.com');
    assert.equal(env.backupMail.hour, 2);
    assert.deepEqual(svc.shopNow(at('2026-10-17T19:05:00Z')), { day: '2026-10-18', hour: 2 });
    assert.equal(svc.configured(), true);
  });

  await t.test('before 02:00 nothing is sent', async () => {
    assert.equal(await svc.runIfDue(at('2026-10-17T18:30:00Z')), 'too-early');   // 01:30 shop time
    assert.equal(sent.length, 0);
  });

  await t.test('at 02:05 the dump is mailed as an attachment and the day is remembered', async () => {
    assert.equal(await svc.runIfDue(at('2026-10-17T19:05:00Z')), 'sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'dinhxuandaodc.435@gmail.com');
    assert.equal(sent[0].from, 'shop@example.test');
    assert.match(sent[0].subject, /Sao lưu cơ sở dữ liệu 2026-10-18/);
    assert.equal(sent[0].attachments.length, 1);
    assert.match(sent[0].attachments[0].filename, /\.sql\.gz$/);
    assert.equal(stored['backup.mail.lastDay'], '2026-10-18');
    assert.equal(cleaned, 1, 'the temporary dump is removed');
  });

  await t.test('never twice on the same day, again the next day', async () => {
    assert.equal(await svc.runIfDue(at('2026-10-17T20:00:00Z')), 'done-today');
    assert.equal(sent.length, 1);
    assert.equal(await svc.runIfDue(at('2026-10-18T19:10:00Z')), 'sent');
    assert.equal(sent.length, 2);
  });

  await t.test('a failed send is reported and tried again at the next check', async () => {
    stored = {};
    svc.status.lastDay = null;
    svc.setTransportFactory(() => ({ sendMail: async () => { throw new Error('535 bad credentials'); } }));
    assert.equal(await svc.runIfDue(at('2026-10-19T19:10:00Z')), 'failed');
    assert.equal(svc.status.error, '535 bad credentials');
    assert.equal(stored['backup.mail.lastDay'], undefined, 'not marked as done');
    assert.equal(cleaned, 3, 'the dump is cleaned even when sending fails');
    svc.setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); } }));
    assert.equal(await svc.runIfDue(at('2026-10-19T19:20:00Z')), 'sent');
  });

  await t.test('too big for the mail: sent without the file', async () => {
    stored = {};
    svc.status.lastDay = null;
    const before = env.backupMail.maxAttachmentMb;
    env.backupMail.maxAttachmentMb = 0;
    try {
      assert.equal(await svc.runIfDue(at('2026-10-20T19:10:00Z')), 'sent');
      const m = sent[sent.length - 1];
      assert.equal(m.attachments.length, 0);
      assert.match(m.text, /không đính kèm/);
    } finally { env.backupMail.maxAttachmentMb = before; }
  });
});
