/**
 * First-boot DB bootstrap, with mysql2 replaced by a recording fake (no MySQL needed).
 * Focus: the safety contract (never touch a database holding data), resuming a half-applied bootstrap,
 * and the admin-password swap (admin/admin is never left live).
 */
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const env = require('../src/config/env');
const { bootstrapIfEmpty } = require('../src/config/bootstrapDb');

const SCHEMA_TABLES = [...fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8')
  .matchAll(/CREATE TABLE\s+(\w+)/g)].map((m) => m[1]);

/**
 * Fake connection. `tables`: a number (that many foreign tables) or an array of table names;
 * `withRows`: names of tables that hold data. Records every statement except the inspection queries.
 */
function fakeConnection(t, tables, withRows = []) {
  const names = Array.isArray(tables) ? tables : Array.from({ length: tables }, (_, i) => `other_${i}`);
  const statements = [];
  const conn = {
    query: async (sql, params) => {
      if (/information_schema\.tables/.test(sql)) return [names.map((name) => ({ name }))];
      const probe = /SELECT EXISTS\(SELECT 1 FROM `(\w+)`\)/.exec(sql);
      if (probe) return [[{ has_rows: withRows.includes(probe[1]) ? 1 : 0 }]];
      statements.push({ sql, params });
      return [{}];
    },
    end: async () => {},
  };
  t.mock.method(mysql, 'createConnection', async () => conn);
  return statements;
}

const withEnv = (t, patch) => {
  const before = { ...env.db };
  Object.assign(env.db, patch);
  t.after(() => Object.assign(env.db, before));
};

test('does nothing unless AUTO_BOOTSTRAP_DB is on', async (t) => {
  withEnv(t, { autoBootstrap: false });
  const stmts = fakeConnection(t, 0);
  assert.equal(await bootstrapIfEmpty(), 'disabled');
  assert.equal(stmts.length, 0);
});

test('never touches a database that has tables of its own (schema.sql DROPs tables)', async (t) => {
  withEnv(t, { autoBootstrap: true, seedDemo: true, bootstrapAdminPassword: 'a-strong-password-1' });
  const stmts = fakeConnection(t, 3);
  assert.equal(await bootstrapIfEmpty(), 'skipped-not-empty');
  assert.equal(stmts.length, 0, 'no schema, no seed, no password update');
});

test('empty database: applies schema + seed, then swaps admin/admin for the configured password', async (t) => {
  withEnv(t, { autoBootstrap: true, seedDemo: true, bootstrapAdminPassword: 'a-strong-password-1' });
  const stmts = fakeConnection(t, 0);
  assert.equal(await bootstrapIfEmpty(), 'applied');
  assert.match(stmts[0].sql, /CREATE TABLE users/);
  assert.match(stmts[1].sql, /INSERT INTO users/);
  const update = stmts[2];
  assert.match(update.sql, /UPDATE users SET password_hash = \? WHERE username = 'admin'/);
  assert.notEqual(update.params[0], 'a-strong-password-1', 'only a hash is written');
  assert.ok(bcrypt.compareSync('a-strong-password-1', update.params[0]));
  assert.ok(!bcrypt.compareSync('admin', update.params[0]), 'the factory password no longer works');
});

test('missing or too-short password variable: admin/admin is still replaced (random password, fail closed)', async (t) => {
  for (const pw of ['', 'short']) {
    withEnv(t, { autoBootstrap: true, seedDemo: true, bootstrapAdminPassword: pw });
    const stmts = fakeConnection(t, 0);
    assert.equal(await bootstrapIfEmpty(), 'applied');
    assert.equal(stmts.length, 3, `schema + seed + password (password "${pw}")`);
    assert.match(stmts[2].sql, /UPDATE users SET password_hash/);
    assert.ok(!bcrypt.compareSync('admin', stmts[2].params[0]), 'admin/admin never stays live');
    if (pw) assert.ok(!bcrypt.compareSync(pw, stmts[2].params[0]), 'the refused value is not used either');
  }
});

test('the password swap only happens together with the demo seed (no users table rows otherwise)', async (t) => {
  withEnv(t, { autoBootstrap: true, seedDemo: false, bootstrapAdminPassword: 'a-strong-password-1' });
  const stmts = fakeConnection(t, 0);
  assert.equal(await bootstrapIfEmpty(), 'applied');
  assert.equal(stmts.length, 1);
});

test('resumes a half-applied bootstrap: only our tables, all empty, some missing', async (t) => {
  withEnv(t, { autoBootstrap: true, seedDemo: false, bootstrapAdminPassword: '' });
  const stmts = fakeConnection(t, ['users', 'categories']);
  assert.equal(await bootstrapIfEmpty(), 'applied');
  assert.match(stmts[0].sql, /CREATE TABLE users/);
});

test('resumes when the whole schema exists but the requested seed never ran', async (t) => {
  withEnv(t, { autoBootstrap: true, seedDemo: true, bootstrapAdminPassword: 'a-strong-password-1' });
  const stmts = fakeConnection(t, SCHEMA_TABLES);
  assert.equal(await bootstrapIfEmpty(), 'applied');
  assert.equal(stmts.length, 3);
});

test('a complete, empty schema without demo seed is left alone on every boot', async (t) => {
  withEnv(t, { autoBootstrap: true, seedDemo: false, bootstrapAdminPassword: '' });
  const stmts = fakeConnection(t, SCHEMA_TABLES);
  assert.equal(await bootstrapIfEmpty(), 'skipped-not-empty');
  assert.equal(stmts.length, 0);
});

test('never resumes over data: one table with rows, or a table that is not ours', async (t) => {
  withEnv(t, { autoBootstrap: true, seedDemo: true, bootstrapAdminPassword: 'a-strong-password-1' });
  let stmts = fakeConnection(t, ['users', 'categories'], ['categories']);
  assert.equal(await bootstrapIfEmpty(), 'skipped-not-empty');
  assert.equal(stmts.length, 0);
  stmts = fakeConnection(t, ['users', 'wp_posts']);
  assert.equal(await bootstrapIfEmpty(), 'skipped-not-empty');
  assert.equal(stmts.length, 0);
});

test('a failing statement is reported as "failed", never thrown', async (t) => {
  withEnv(t, { autoBootstrap: true, seedDemo: false, bootstrapAdminPassword: '' });
  t.mock.method(mysql, 'createConnection', async () => ({
    query: async (sql) => { if (/information_schema/.test(sql)) return [[]]; throw new Error('boom'); },
    end: async () => {},
  }));
  assert.equal(await bootstrapIfEmpty(), 'failed');
});
