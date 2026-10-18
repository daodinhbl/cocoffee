process.env.NGROK_API_KEY = 'vendor-key-for-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { mock } = require('node:test');
const settingsModel = require('../src/models/settingsModel');
const core = require('../scripts/license-core');
const broker = require('../src/services/ngrokBroker');

const MACHINE = 'A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90';

test('ngrok broker: licence-checked, domain + domain-bound credential, same answer next time', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  process.env.LICENSE_PUBLIC_KEY = core.publicHex(publicKey);
  const issue = (machine, days = 30, now = new Date('2026-10-18T00:00:00Z')) => core.sign(core.buildPayload({ machine, customer: 'Quán Cà Phê Cò', days, features: ['pos'], now }), privateKey);
  let stored = {};
  mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries(Object.entries(stored).filter(([k]) => k.startsWith(p))));
  mock.method(settingsModel, 'setMany', async (v) => { stored = { ...stored, ...v }; });
  const calls = [];
  let domainStatus = [201];
  broker.setHttp(async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/reserved_domains') { const s = domainStatus.shift() ?? 201; return { status: s, json: s < 300 ? { domain: body.domain } : { msg: 'taken' } }; }
    if (path === '/credentials') return { status: 201, json: { id: 'cr_1', token: '2abcSecretTunnelToken' } };
    return { status: 404, json: null };
  });
  t.after(() => mock.restoreAll());
  const now = new Date('2026-10-18T01:00:00Z');

  await t.test('slug', () => {
    assert.equal(broker.slugOf('Quán Cà Phê Cò'), 'quan-ca-phe-co');
    assert.equal(broker.slugOf('!!!'), 'pos');
  });

  await t.test('a wrong, foreign, other-machine or expired code is refused before ngrok is called', async () => {
    const other = crypto.generateKeyPairSync('ed25519').privateKey;
    const foreign = core.sign(core.buildPayload({ machine: MACHINE, customer: 'Khách X', days: 30, features: ['pos'], now }), other);
    await assert.rejects(broker.claim({ machine: MACHINE, code: foreign, now }), { code: 'BAD_LICENCE' });
    await assert.rejects(broker.claim({ machine: MACHINE, code: issue('0000-0000-0000-0000-0000-0000-0000-0000'), now }), { code: 'BAD_LICENCE' });
    await assert.rejects(broker.claim({ machine: MACHINE, code: issue(MACHINE, 1, new Date('2026-01-01T00:00:00Z')), now }), { code: 'LICENCE_EXPIRED' });
    await assert.rejects(broker.claim({ machine: 'sai', code: 'x', now }), { code: 'VALIDATION' });
    assert.equal(calls.length, 0);
  });

  await t.test('first claim reserves a domain and a credential limited to it; the second returns the same', async () => {
    const code = issue(MACHINE);
    const a = await broker.claim({ machine: MACHINE, code, shopName: 'Cò Coffee', now });
    assert.match(a.domain, /^co-coffee-[0-9a-f]{4}\.ngrok\.app$/);
    assert.equal(a.authtoken, '2abcSecretTunnelToken');
    assert.equal(a.reused, false);
    const cred = calls.find((c) => c.path === '/credentials');
    assert.deepEqual(cred.body.acl, [`bind:${a.domain}`], 'the token can bind only its own domain');
    const n = calls.length;
    const b = await broker.claim({ machine: MACHINE, code, now });
    assert.deepEqual([b.domain, b.authtoken, b.reused], [a.domain, a.authtoken, true]);
    assert.equal(calls.length, n, 'no more ngrok calls');
  });

  await t.test('a taken name is retried with another suffix', async () => {
    stored = {};
    calls.length = 0;
    domainStatus = [409, 409];
    const r = await broker.claim({ machine: MACHINE, code: issue(MACHINE), now });
    assert.equal(calls.filter((c) => c.path === '/reserved_domains').length, 3);
    assert.ok(r.domain);
  });

  await t.test('without NGROK_API_KEY the broker is off', async () => {
    delete process.env.NGROK_API_KEY;
    await assert.rejects(broker.claim({ machine: MACHINE, code: issue(MACHINE), now }), { code: 'NOT_CONFIGURED' });
    process.env.NGROK_API_KEY = 'vendor-key-for-tests';
  });
});
