const crypto = require('crypto');

/**
 * PayOn (NextPay) wire format, as implemented by the vendor's own SDKs (nextpaygroup/payon-php-sdk, mervick/aes-everywhere):
 *  - `data` of a request = base64("Salted__" + 8-byte salt + AES-256-CBC/PKCS7(JSON)), the key and IV derived from the merchant
 *    secret with OpenSSL's EVP_BytesToKey (MD5, one round);
 *  - request checksum = md5_hex(app_id + data + secret);
 *  - notification (IPN) checksum = md5_hex(app_id + json_encode(data) + secret), where `json_encode` is PHP's (escaped
 *    slashes and \uXXXX for non-ASCII), computed by PayOn over the array it sends.
 * Reference vectors in test/payon-crypto.test.js were produced with PHP 8.2 running the same algorithm.
 */
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8'))))).digest();

function keyAndIv(secret, salt) {
  let out = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (out.length < 48) {
    prev = md5(prev, secret, salt);
    out = Buffer.concat([out, prev]);
  }
  return { key: out.subarray(0, 32), iv: out.subarray(32, 48) };
}

/** AES-256-CBC, OpenSSL "Salted__" container, base64. `salt` is for tests only. */
function encrypt(text, secret, salt = crypto.randomBytes(8)) {
  const { key, iv } = keyAndIv(secret, salt);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__'), salt, body]).toString('base64');
}

/** @returns {string|null} the plaintext, or null when the input is not a valid container for this secret */
function decrypt(encoded, secret) {
  try {
    const raw = Buffer.from(String(encoded), 'base64');
    if (raw.length < 32 || raw.subarray(0, 8).toString('latin1') !== 'Salted__') return null;
    const { key, iv } = keyAndIv(secret, raw.subarray(8, 16));
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
  } catch (_) {
    return null; // wrong key / corrupted: bad padding
  }
}

/** md5 hex of the parts joined together. */
const checksum = (...parts) => md5(...parts).toString('hex');

/** PHP's json_encode with default flags: "/" escaped, every non-ASCII UTF-16 unit as \uXXXX (lower-case hex). */
function phpJsonEncode(value) {
  return JSON.stringify(value)
    .replace(/\//g, '\\/')
    .replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The raw text of the top-level "data" member of a JSON object, exactly as received. Strings and nested values are skipped
 * properly (a "data" key inside a string or a nested object is not the member), and a body with the member TWICE yields
 * null: JSON.parse would keep the last one while a naive search finds the first, which would let a signed payload be
 * swapped for another one under the same checksum.
 * @returns {string|null} null when absent, malformed, or duplicated
 */
function rawDataMember(rawBody) {
  const text = String(rawBody || '');
  let i = 0;
  const skipWs = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i += 1; };
  const readString = () => { // at the opening quote: moves past the closing quote, returns the decoded value
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) throw new Error('unterminated string');
    i += 1;
    return JSON.parse(text.slice(start, i));
  };
  const skipValue = () => { // moves past one JSON value and returns its raw text
    skipWs();
    const start = i;
    if (text[i] === '"') {
      readString();
    } else if (text[i] === '{' || text[i] === '[') {
      let depth = 0;
      while (i < text.length) {
        const c = text[i];
        if (c === '"') { readString(); continue; }
        if (c === '{' || c === '[') depth += 1;
        else if (c === '}' || c === ']') depth -= 1;
        i += 1;
        if (depth === 0) break;
      }
      if (depth !== 0) throw new Error('unbalanced');
    } else {
      while (i < text.length && !',}] \t\r\n'.includes(text[i])) i += 1;
    }
    return text.slice(start, i);
  };
  try {
    skipWs();
    if (text[i] !== '{') return null;
    i += 1;
    skipWs();
    if (text[i] === '}') return null;
    let found = null;
    for (;;) {
      skipWs();
      if (text[i] !== '"') return null;
      const key = readString();
      skipWs();
      if (text[i] !== ':') return null;
      i += 1;
      const value = skipValue();
      if (key === 'data') {
        if (found !== null) return null; // twice: ambiguous, refuse
        found = value;
      }
      skipWs();
      if (text[i] === ',') { i += 1; continue; }
      if (text[i] === '}') break;
      return null;
    }
    return found;
  } catch (_) {
    return null;
  }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a).toLowerCase());
  const y = Buffer.from(String(b).toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Verifies the checksum of a notification. PayOn's wording is "MD5(APP_ID + JSON(data) + SECRET)" without saying how
 * the JSON is spelled, so the spellings a sender can plausibly use are all accepted: the member exactly as received,
 * PHP's json_encode (escaped) and the unescaped / JS forms. Each one still needs the secret to be produced.
 * `data` given as an encrypted string (like the request format) is checked as md5(app_id + data + secret).
 * @returns {{ok:boolean, how?:string, data?:any}} `data` is what was signed — the caller must act on this, not on `body.data`
 */
function verifyNotification({ appId, secret, body, rawBody }) {
  if (!body || typeof body !== 'object' || typeof body.checksum !== 'string' || body.data === undefined) return { ok: false };
  try {
    const candidates = [];
    let rawItems = null;
    if (typeof body.data === 'string') {
      candidates.push(['encrypted-string', body.data]);
    } else {
      const raw = rawDataMember(rawBody);
      if (raw) {
        candidates.push(['raw', raw]);
        try { rawItems = JSON.parse(raw); } catch (_) { rawItems = null; }
      }
      candidates.push(['php', phpJsonEncode(body.data)], ['js', JSON.stringify(body.data)],
        ['php-unescaped', JSON.stringify(body.data).replace(/\//g, '\\/')]);
    }
    for (const [how, text] of candidates) {
      if (safeEqual(checksum(appId, text, secret), body.checksum)) {
        return { ok: true, how, data: how === 'raw' && rawItems !== null ? rawItems : body.data };
      }
    }
  } catch (_) {
    return { ok: false }; // e.g. absurdly nested JSON that cannot be re-encoded
  }
  return { ok: false };
}

module.exports = { encrypt, decrypt, checksum, phpJsonEncode, rawDataMember, verifyNotification };
