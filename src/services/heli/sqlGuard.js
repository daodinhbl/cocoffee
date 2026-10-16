/**
 * Heli may only READ a short allowlist of shop tables. Allowlist, not blocklist: a table nobody listed
 * (app_settings holds the Zalo / PayOn secrets, users the password hashes) is refused by default.
 * `check(sql)` returns { ok: true, sql } or { ok: false, reason }.
 */
const ALLOWED_TABLES = [
  'orders', 'order_items', 'payments', 'products', 'categories', 'product_aliases', 'recipes',
  'inventory_items', 'inventory_movements', 'customers', 'customer_ledger', 'dining_tables',
];
const ALLOWED = new Set(ALLOWED_TABLES);

// Never legitimate in a read for Heli, wherever they appear outside a string literal.
const FORBIDDEN_WORDS = new Set([
  'insert', 'update', 'delete', 'replace', 'drop', 'alter', 'create', 'truncate', 'rename', 'grant', 'revoke', 'call', 'do',
  'set', 'into', 'outfile', 'dumpfile', 'load_file', 'load', 'handler', 'lock', 'unlock', 'procedure', 'sleep', 'benchmark',
  'get_lock', 'release_lock', 'information_schema', 'mysql', 'performance_schema', 'sys', 'password', 'password_hash', 'pw_stamp',
  'with',
]);

const DENY = 'Từ chối: chỉ được MỘT câu SELECT / SHOW TABLES / DESCRIBE trên các bảng bán hàng và kho.';

/** Replaces every quoted string with '' (so words inside text are not mistaken for SQL) and fails on a broken quote. */
function stripStrings(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (; j < sql.length; j += 1) {
        if (sql[j] === String.fromCharCode(92)) { j += 1; continue; }
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 1; continue; } break; }
      }
      if (j >= sql.length) return null; // unterminated
      out += "''";
      i = j + 1;
    } else { out += ch; i += 1; }
  }
  return out;
}

function check(raw) {
  const text = String(raw || '').trim().replace(/;\s*$/, '').trim();
  if (!text || text.length > 2000) return { ok: false, reason: DENY };
  const bare = stripStrings(text);
  if (bare === null) return { ok: false, reason: DENY };
  // no comments (hide-and-seek tricks), no second statement, no variables, no hex/charset tricks
  if (/--|\/\*|\*\/|#|;|@|[\x5c]/.test(bare)) return { ok: false, reason: DENY };
  const flat = bare.toLowerCase();
  const first = flat.split(/\s+/, 1)[0];

  if (first === 'show') {
    if (/^show\s+tables\s*$/.test(flat)) return { ok: true, sql: null, virtual: 'tables' };
    return { ok: false, reason: DENY };
  }
  if (first === 'describe' || first === 'desc') {
    const m = /^(?:describe|desc)\s+`?(\w+)`?\s*$/.exec(flat);
    if (!m || !ALLOWED.has(m[1])) return { ok: false, reason: DENY };
    return { ok: true, sql: `DESCRIBE \`${m[1]}\`` };
  }
  if (first !== 'select') return { ok: false, reason: DENY };

  const words = flat.match(/[a-z_][a-z0-9_]*/g) || [];
  if (words.some((w) => FORBIDDEN_WORDS.has(w) || /^(zalo|payon)_/.test(w))) return { ok: false, reason: DENY };
  if (/\bfor\s+(update|share)\b|\block\s+in\b/.test(flat)) return { ok: false, reason: DENY };
  // every FROM / JOIN target must be an allowlisted table (or a sub-select, whose own FROM is checked too)
  const re = /\b(from|join)\s+(\(|`?([a-z_][a-z0-9_]*)`?(?:\s*\.\s*`?[a-z_][a-z0-9_]*`?)?)/g;
  let m;
  let sawFrom = false;
  while ((m = re.exec(flat)) !== null) {
    sawFrom = true;
    if (m[2] === '(') continue;
    if (m[0].includes('.') || !ALLOWED.has(m[3])) return { ok: false, reason: DENY };
  }
  if (/\bfrom\s+`?\w+`?(\s+(as\s+)?`?\w+`?)?\s*,/.test(flat)) return { ok: false, reason: DENY }; // comma joins hide a second table
  if (!sawFrom && /\b(select\s+.*\bfrom\b)/.test(flat)) return { ok: false, reason: DENY };
  return { ok: true, sql: text };
}

module.exports = { check, ALLOWED_TABLES, DENY };
