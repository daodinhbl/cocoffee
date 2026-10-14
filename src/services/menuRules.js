const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');

/**
 * Menu business rules shared by the Web Admin forms and the JSON API (/api/products, /api/categories), so both
 * entry points accept and store exactly the same things.
 */
const MAX_ALIASES = 30;
const MAX_ALIAS_LEN = 100;
const MAX_RECIPE_LINES = 50;

const aliasError = () => new AppError(400, 'VALIDATION', `Tối đa ${MAX_ALIASES} từ khóa, mỗi từ khóa tối đa ${MAX_ALIAS_LEN} ký tự.`);

/** Chat keywords as an array of strings (the API body): trimmed, blanks dropped, limits enforced. */
function checkAliases(list) {
  if (!Array.isArray(list)) throw new AppError(400, 'VALIDATION', 'aliases must be an array of strings');
  if (list.some((a) => typeof a !== 'string')) throw new AppError(400, 'VALIDATION', 'aliases must be an array of strings');
  const clean = list.map((a) => a.trim()).filter(Boolean);
  if (clean.length > MAX_ALIASES || clean.some((a) => a.length > MAX_ALIAS_LEN)) throw aliasError();
  return clean;
}

/** Textarea "a, b\nc" -> ['a','b','c'] (the model de-duplicates by normalized form). */
function parseAliases(raw) {
  if (typeof raw !== 'string') return [];
  return checkAliases(raw.split(/[\n,;]+/));
}

/** Category code: lowercased, letters / digits / underscore only. */
function categoryCode(raw, label = 'Mã nhóm') {
  const code = v.str(raw, label, { max: 30 }).toLowerCase();
  if (!/^[a-z0-9_]+$/.test(code)) throw new AppError(400, 'VALIDATION', 'Mã nhóm chỉ gồm chữ thường, số và dấu gạch dưới.');
  return code;
}

/**
 * Recipe lines [{ inventory_item_id, quantity }] -> validated lines, duplicates of one ingredient merged,
 * quantities rounded to 4 decimals, at most 50 lines.
 */
function mergeRecipe(lines, { item = 'Nguyên liệu', qty = 'Định lượng' } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new AppError(400, 'VALIDATION', 'Công thức cần ít nhất một nguyên liệu.');
  if (lines.length > MAX_RECIPE_LINES) throw new AppError(400, 'VALIDATION', `Công thức tối đa ${MAX_RECIPE_LINES} dòng.`);
  const merged = new Map();
  for (const l of lines) {
    const id = v.id(l?.inventory_item_id, item);
    const quantity = v.num(l?.quantity, qty, { min: 0.0001, max: 1e7 });
    merged.set(id, (merged.get(id) || 0) + quantity);
  }
  return [...merged].map(([inventory_item_id, quantity]) => ({ inventory_item_id, quantity: Math.round(quantity * 1e4) / 1e4 }));
}

module.exports = { checkAliases, parseAliases, categoryCode, mergeRecipe, MAX_ALIASES, MAX_ALIAS_LEN, MAX_RECIPE_LINES };
