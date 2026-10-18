const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const env = require('../src/config/env');
const settingsModel = require('../src/models/settingsModel');
const demoState = require('../src/services/demoState');

test('demo switch kept in the database', async (t) => {
  let stored = {};
  mock.method(settingsModel, 'getByPrefix', async () => ({ ...stored }));
  mock.method(settingsModel, 'setMany', async (v) => { stored = { ...stored, ...v }; });
  const bootstrap = require('../src/config/bootstrapDb');
  const calls = [];
  mock.method(bootstrap, 'ensureDemoAccount', async () => { calls.push('reset'); return 'reset'; });
  process.env.SKIP_BOOT_TASKS = 'false';
  t.after(() => { mock.restoreAll(); env.demoRuntime.on = false; });

  assert.equal(env.demo.enabled, false, 'off by default');
  assert.equal(await demoState.load(), false);

  stored = { 'demo.enabled': '1' };
  assert.equal(await demoState.load(), true);
  assert.equal(env.demo.enabled, true, 'the login page and the guards read env.demo.enabled');
  assert.deepEqual(calls, ['reset'], 'switching it on resets the demo account once');
  await demoState.load();
  assert.equal(calls.length, 1, 'a second read does not reset it again');

  stored = { 'demo.enabled': '0' };
  assert.equal(await demoState.load(), false);

  mock.method(settingsModel, 'getByPrefix', async () => { throw new Error('db down'); });
  env.demoRuntime.on = true;
  assert.equal(await demoState.load(), true, 'an unreadable database keeps the current state');
});
