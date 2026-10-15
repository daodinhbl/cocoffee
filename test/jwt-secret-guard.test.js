const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { jwtSecretProblems } = require('../src/config/jwtSecretCheck');

const run = (extra) => spawnSync(process.execPath, ['-e', "require('./src/config/env')"], {
  cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  env: { PATH: process.env.PATH, DB_NAME: 'x', DB_USER: 'x', DB_PASSWORD: 'x', DOTENV_CONFIG_QUIET: 'true', ...extra },
});

test('jwtSecretProblems: empty, short, weak and repeated secrets are refused', () => {
  assert.ok(jwtSecretProblems(undefined).length);
  assert.ok(jwtSecretProblems('   ').length);
  assert.ok(jwtSecretProblems('short').length);
  assert.ok(jwtSecretProblems('secret').length);
  assert.ok(jwtSecretProblems('a'.repeat(40)).length);
  assert.deepEqual(jwtSecretProblems('k3Jx9Qw2LmZr7TnVb5HcYd8PfGs1UaEo6XiNt4Rq'), []);
});

test('REQUIRE_JWT_SECRET=1 without a good JWT_SECRET exits with status 1', () => {
  for (const jwt of [undefined, 'secret', 'tooshort', 'x'.repeat(40)]) {
    const r = run({ REQUIRE_JWT_SECRET: '1', ...(jwt ? { JWT_SECRET: jwt } : {}) });
    assert.equal(r.status, 1, `JWT_SECRET=${jwt}`);
    assert.match(r.stderr, /FATAL: REQUIRE_JWT_SECRET/);
  }
});

test('REQUIRE_JWT_SECRET=1 with a strong JWT_SECRET starts; without the flag a missing secret only warns', () => {
  assert.equal(run({ REQUIRE_JWT_SECRET: '1', JWT_SECRET: 'k3Jx9Qw2LmZr7TnVb5HcYd8PfGs1UaEo6XiNt4Rq' }).status, 0);
  assert.equal(run({}).status, 0);
});
