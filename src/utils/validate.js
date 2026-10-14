const { AppError } = require('./httpError');

const fail = (msg) => { throw new AppError(400, 'VALIDATION', msg); };

const str = (v, name, { max = 255, required = true } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) fail(`${name} is required`); return undefined; }
  if (typeof v !== 'string' || v.trim().length > max) fail(`${name} must be a string up to ${max} chars`);
  return v.trim();
};

const num = (v, name, { min = 0, max = 1e12, required = true, integer = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) fail(`${name} is required`); return undefined; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) fail(`${name} must be a number between ${min} and ${max}`);
  return n;
};

const oneOf = (v, name, allowed, { required = true } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) fail(`${name} is required`); return undefined; }
  if (!allowed.includes(v)) fail(`${name} must be one of: ${allowed.join(', ')}`);
  return v;
};

// JSON booleans or 0/1; the strings '0' and 'false' mean 0 (plain truthiness would turn them into 1).
const flag = (v) => (v === undefined || v === null ? undefined : (v === '0' || v === 'false' ? 0 : (v ? 1 : 0)));

const id = (v, name = 'id') => num(v, name, { min: 1, integer: true });

module.exports = { str, num, oneOf, flag, id, fail };
