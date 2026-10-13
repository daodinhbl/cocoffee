/**
 * Create (or reset the password of) a staff account.
 *   node scripts/create-admin.js <username> "<full name>" [admin|cashier] [--allow-weak]
 * The password is read from the ADMIN_PASSWORD env var, or prompted without echo.
 */
const bcrypt = require('bcryptjs');
const readline = require('readline');
const { pool } = require('../src/config/db');

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const out = rl.output;
    rl._writeToOutput = (s) => { if (s.includes(question)) out.write(s); };   // suppress echo of typed chars
    rl.question(question, (answer) => { rl.close(); out.write('\n'); resolve(answer); });
  });
}

(async () => {
  const [username, fullName = username, role = 'admin'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!username || !['admin', 'cashier'].includes(role)) {
    console.error('Usage: node scripts/create-admin.js <username> "<full name>" [admin|cashier]');
    process.exit(1);
  }
  const password = process.env.ADMIN_PASSWORD || (await promptHidden('Password (min 10 chars): '));
  const weakOk = process.argv.includes('--allow-weak');
  if (!password || (password.length < 10 && !weakOk)) {
    console.error('Password must be at least 10 characters (pass --allow-weak to override, e.g. for a dev box).');
    process.exit(1);
  }
  if (password.length < 10) console.warn('WARNING: weak password accepted. Change it before going public.');

  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), full_name = VALUES(full_name), role = VALUES(role), is_active = 1`,
    [username, hash, fullName, role]
  );
  console.log(`User "${username}" saved with role ${role}.`);
  await pool.end();
})().catch((err) => { console.error(err.message); process.exit(1); });
