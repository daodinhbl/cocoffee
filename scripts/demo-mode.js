#!/usr/bin/env node
/**
 * Turns the public demo account on or off in the database (no hosting-panel change needed):
 *   node scripts/demo-mode.js on | off | status
 * "on": the login page shows admin / admin with the note not to change the password, and at the next start (or restart) the
 * account is reset to those values. ANYONE can then sign in: only for a demo site.
 */
const demo = require('../src/services/demoState');
const { defaultPool } = require('../src/config/db');
const env = require('../src/config/env');

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'on' || cmd === 'off') {
    await demo.set(cmd === 'on');
    console.log(`Demo mode ${cmd.toUpperCase()}. ${cmd === 'on' ? 'Restart the site (or wait for the next start) so the admin account is reset to the demo password.' : 'The login card disappears within a minute; the admin password stays as it is.'}`);
  } else if (cmd === 'status') {
    await demo.load();
    console.log(`Demo mode is ${env.demo.enabled ? 'ON' : 'off'} (env DEMO_MODE=${process.env.DEMO_MODE || ''}, settings ${env.demoRuntime.on ? 'on' : 'off'}).`);
  } else {
    console.log('usage: node scripts/demo-mode.js on|off|status');
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => defaultPool.end());
