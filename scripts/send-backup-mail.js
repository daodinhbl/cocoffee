#!/usr/bin/env node
/** Sends the backup e-mail right now (a test of the SMTP settings):  node scripts/send-backup-mail.js */
const svc = require('../src/services/backupMailService');
const { defaultPool } = require('../src/config/db');

svc.sendNow()
  .then((r) => console.log(r.sent ? `Sent ${r.name} (${r.size} bytes)${r.attached ? '' : ' without attachment (too big)'}.` : `Not sent: ${r.reason}`))
  .catch((err) => { console.error(`Failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => defaultPool.end());
