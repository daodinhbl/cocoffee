const crypto = require('crypto');

/**
 * Automatic SKU for a new item when the form's SKU box is left empty: PREFIX-NAME-IN-CAPITALS, e.g.
 * "Đường cát" in group raw -> RM-DUONG-CAT. If the code is taken, -2, -3 ... is appended; after 50 tries a random
 * suffix (the UNIQUE key on sku is still the final guard against two people saving at once).
 */
const MAX_LEN = 40;                     // sku column is VARCHAR(40)
const MAX_NAME_PART = 22;

function slug(name, max = MAX_NAME_PART) {
  const s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/-[^-]*$/, '') || s.slice(0, max);       // cut at a word boundary when possible
}

/**
 * @param {{ prefix: string, name: string, exists: (sku: string) => Promise<boolean> }} p
 * @returns {Promise<string>} a SKU that does not exist yet
 */
async function generate({ prefix, name, exists }) {
  const base = `${prefix}-${slug(name) || 'MOI'}`.slice(0, MAX_LEN);
  if (!(await exists(base))) return base;
  for (let n = 2; n <= 50; n += 1) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_LEN - suffix.length) + suffix;
    if (!(await exists(candidate))) return candidate;
  }
  return `${base.slice(0, MAX_LEN - 5)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

module.exports = { slug, generate };
