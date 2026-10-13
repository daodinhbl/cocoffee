const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { computeMac, verifySignature } = require('../src/services/zalo/zaloSignature');

const appId = '360846524940903967';
const oaSecretKey = 'oa-secret';
const rawBody = '{"app_id":"360846524940903967","sender":{"id":"246845883529197922"},"event_name":"user_send_text","message":{"text":"2 cf sua","msg_id":"abc"},"timestamp":"154390853474"}';
const timestamp = '154390853474';

test('mac = sha256(appId + data + timestamp + OAsecretKey), hex', () => {
  const expected = crypto.createHash('sha256').update(appId + rawBody + timestamp + oaSecretKey).digest('hex');
  assert.equal(computeMac({ appId, rawBody, timestamp, oaSecretKey }), expected);
});

test('accepts the right signature, with or without "mac=" prefix', () => {
  const mac = computeMac({ appId, rawBody, timestamp, oaSecretKey });
  assert.ok(verifySignature({ appId, rawBody, timestamp, oaSecretKey, header: mac }));
  assert.ok(verifySignature({ appId, rawBody, timestamp, oaSecretKey, header: `mac=${mac}` }));
});

test('rejects tampered body, wrong key, missing or malformed header', () => {
  const mac = computeMac({ appId, rawBody, timestamp, oaSecretKey });
  assert.ok(!verifySignature({ appId, rawBody: rawBody.replace('2 cf', '9 cf'), timestamp, oaSecretKey, header: mac }));
  assert.ok(!verifySignature({ appId, rawBody, timestamp, oaSecretKey: 'other', header: mac }));
  assert.ok(!verifySignature({ appId, rawBody, timestamp, oaSecretKey, header: undefined }));
  assert.ok(!verifySignature({ appId, rawBody, timestamp, oaSecretKey, header: 'deadbeef' }));
});
