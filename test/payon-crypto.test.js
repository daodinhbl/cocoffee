const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/services/payon/payonCrypto');

// Reference vectors produced by PHP 8.2 running the vendor SDK's algorithm (PayonEncrypto::Encrypt, BuildPayment,
// ValidateNotify) with a fixed salt: secret 'S3cretKey', app_id '160088PayON', salt 0102030405060708.
const SECRET = 'S3cretKey';
const APP = '160088PayON';
const SALT = Buffer.from('0102030405060708', 'hex');
const REQ_JSON = '{"merchant_id":12345,"merchant_request_id":"CF261015-00042-ab12","amount":79000,"description":"Thanh to\\u00e1n \\u0111\\u01a1n CF261015-00042","url_notify":"https:\\/\\/cocoffee.example.test\\/api\\/payon\\/ipn","time_expire":900}';
const REQ_DATA = 'U2FsdGVkX18BAgMEBQYHCGdasRx5YBB1rWHDpvFGSj59otmw0BzxqEXm4U86nNt5Y2zXodUF9b2PJcjIxxPBITj+XwVKBKQgpDARNa6vDMuD6jyvIxWEAfl10tyd9rZ5GULhY/MzKAJoRwLIv/plMzOcCf4JypwLr8O8PJAud3/OnWK1pHTqCS3KXSK5uOk8E5ih74ey7L8LGKF2YDwAOtI4+ZKBKCzZ/DqiPgv/7pKaE1bvayRGaLboWdF1UkukGXKAg/m9Y4ZN7JMx6ZP/9ViNkBpWTRvkqjXvLHoRpiym2VwHsVkzsH3xo0EdtX7R';
const REQ_CHECKSUM = '37291954914994ad6f9013c49279ee7f';
const IPN_RAW = '{"data":[{"merchant_id":12345,"merchant_request_id":"CF261015-00042-ab12","payment_id":987654,"transaction_id":"T-1","payment_token":"tok/en","time_performed":"2026-10-15 16:40:00","amount":79000,"fee":0,"status":2,"transaction_detail":{"order_amount":79000,"user_fee":0,"description":"Thanh toán đơn CF261015-00042 \\u00e1\\u00e0","authorization_code":null}}],"checksum":"x"}';
const IPN_PHP_JSON = '[{"merchant_id":12345,"merchant_request_id":"CF261015-00042-ab12","payment_id":987654,"transaction_id":"T-1","payment_token":"tok\\/en","time_performed":"2026-10-15 16:40:00","amount":79000,"fee":0,"status":2,"transaction_detail":{"order_amount":79000,"user_fee":0,"description":"Thanh to\\u00e1n \\u0111\\u01a1n CF261015-00042 \\u00e1\\u00e0","authorization_code":null}}]';
const IPN_CHECKSUM = '284aeff49594773b5c939c55e73c80e7';
const IPN_CHECKSUM_UNESCAPED = '18767bf30b7493a37187419201b412b3';

test('encrypt reproduces the PHP SDK output byte for byte (same salt), and decrypt reverses it', () => {
  assert.equal(c.encrypt(REQ_JSON, SECRET, SALT), REQ_DATA);
  assert.equal(c.decrypt(REQ_DATA, SECRET), REQ_JSON);
  assert.equal(c.checksum(APP, REQ_DATA, SECRET), REQ_CHECKSUM, 'request checksum = md5(app_id + data + secret)');
});

test('OpenSSL compatibility: a container made by `openssl enc -aes-256-cbc -md md5` decrypts', () => {
  // echo -n "hello PayOn / tiếng Việt" | openssl enc -aes-256-cbc -md md5 -S 0102030405060708 -pass pass:S3cretKey -a -A
  const body = 's8bcSEKAdyZ+uvAgZuvyp6vvvGuULQYx0OGqV0IoGgU=';
  const container = Buffer.concat([Buffer.from('Salted__'), SALT, Buffer.from(body, 'base64')]).toString('base64');
  assert.equal(c.decrypt(container, SECRET), 'hello PayOn / tiếng Việt');
});

test('decrypt returns null for a wrong key, a missing container or garbage; a random salt makes each ciphertext differ', () => {
  assert.equal(c.decrypt(REQ_DATA, 'other'), null);
  assert.equal(c.decrypt('aGVsbG8=', SECRET), null);
  assert.equal(c.decrypt('%%%', SECRET), null);
  const a = c.encrypt('x', SECRET);
  assert.notEqual(a, c.encrypt('x', SECRET));
  assert.equal(c.decrypt(a, SECRET), 'x');
});

test('phpJsonEncode matches PHP json_encode for slashes and non-ASCII (incl. astral characters)', () => {
  const body = JSON.parse(IPN_RAW);
  assert.equal(c.phpJsonEncode(body.data), IPN_PHP_JSON);
  assert.equal(c.phpJsonEncode('a/b ☕ 😀'), '"a\\/b \\u2615 \\ud83d\\ude00"');
});

test('rawDataMember cuts the data member out of the body exactly as sent, whatever it contains', () => {
  assert.equal(c.rawDataMember('{"data": [1, {"a":"]\\"}"}] ,"checksum":"x"}'), '[1, {"a":"]\\"}"}]');
  assert.equal(c.rawDataMember('{"checksum":"x","data":"abc"}'), '"abc"');
  assert.equal(c.rawDataMember('{"nothing":1}'), null);
  assert.equal(c.rawDataMember('{"data":[1,2'), null);
});

test('a notification signed by PHP verifies in all the spellings a sender can use; tampering or a wrong secret does not', () => {
  const body = JSON.parse(IPN_RAW);
  const check = (checksum, raw = IPN_RAW, secret = SECRET) => {
    const rawBody = raw.replace('"checksum":"x"', `"checksum":"${checksum}"`);
    return c.verifyNotification({ appId: APP, secret, body: JSON.parse(rawBody), rawBody });
  };
  assert.deepEqual(check(IPN_CHECKSUM), { ok: true, how: 'php' });
  // a Java/Node sender that does not escape (JSON as it is written in the body)
  const unescapedRaw = '{"data":' + JSON.stringify(body.data) + ',"checksum":"x"}';
  assert.equal(check(IPN_CHECKSUM_UNESCAPED, unescapedRaw).ok, true);
  assert.equal(check(IPN_CHECKSUM, IPN_RAW, 'wrong-secret').ok, false);
  const tampered = IPN_RAW.replace('"amount":79000,"fee"', '"amount":1,"fee"');
  assert.equal(check(IPN_CHECKSUM, tampered).ok, false, 'a changed amount breaks the checksum');
  assert.equal(c.verifyNotification({ appId: APP, secret: SECRET, body: { data: [] }, rawBody: '{}' }).ok, false, 'no checksum');
  assert.equal(c.verifyNotification({ appId: APP, secret: SECRET, body: null, rawBody: '' }).ok, false);
});

test('a notification whose data is an encrypted string is checked like a request: md5(app_id + data + secret)', () => {
  const res = c.verifyNotification({ appId: APP, secret: SECRET, body: { data: REQ_DATA, checksum: REQ_CHECKSUM }, rawBody: '' });
  assert.deepEqual(res, { ok: true, how: 'encrypted-string' });
});
