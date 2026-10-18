#!/usr/bin/env node
/**
 * Saves the public address of the site in its settings (what Cài đặt > "Tên miền công khai" edits): the Windows manager calls this
 * every time the ngrok tunnel comes up with a new address.   node scripts/set-public-url.js https://quan.ngrok-free.app
 *   ''  (empty)  goes back to PUBLIC_BASE_URL.
 */
const { defaultPool } = require('../src/config/db');
const publicUrl = require('../src/services/publicUrl');
const settingsModel = require('../src/models/settingsModel');
const env = require('../src/config/env');

(async () => {
  const raw = process.argv[2] ?? '';
  const url = publicUrl.normalize(raw);
  await settingsModel.setMany({ [publicUrl.KEY]: url }, null);       // the running site re-reads the setting within a minute
  env.publicUrlOverride.value = url;
  console.log(url ? `Public address saved: ${url}` : 'Saved address removed: PUBLIC_BASE_URL applies again.');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => defaultPool.end());
