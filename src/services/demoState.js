const env = require('../config/env');
const settingsModel = require('../models/settingsModel');
const logger = require('../utils/logger');

/**
 * Demo mode without touching the hosting panel: besides DEMO_MODE=true in the environment, the row app_settings
 * "demo.enabled" = "1" turns the public demo account on (login-page card, account reset at start, password locked).
 * Switch it with `node scripts/demo-mode.js on|off`; a running site notices within a minute.
 */
const KEY = 'demo.enabled';

/** Reads the switch. Never throws; an unreadable database leaves the current state. */
async function load() {
  try {
    const raw = await settingsModel.getByPrefix(KEY);
    const on = raw[KEY] === '1';
    const flipped = on !== env.demoRuntime.on;
    if (flipped) logger.info(`Demo mode (settings) is now ${on ? 'ON' : 'off'}`);
    env.demoRuntime.on = on;
    // Switched on while the site runs: reset the account now. Never from a run with SKIP_BOOT_TASKS (a developer machine that
    // points at a live database must not touch its accounts).
    if (on && flipped && !/^(1|true|yes)$/i.test(process.env.SKIP_BOOT_TASKS || '')) await require('../config/bootstrapDb').ensureDemoAccount();
  } catch (err) {
    logger.warn('Demo switch unreadable, keeping the current state', err);
  }
  return env.demo.enabled;
}

function startRefresh() {
  setInterval(() => load().catch(() => {}), 60 * 1000).unref();
}

async function set(on) {
  await settingsModel.setMany({ [KEY]: on ? '1' : '0' }, null);
  env.demoRuntime.on = on;
}

module.exports = { load, startRefresh, set, KEY };
