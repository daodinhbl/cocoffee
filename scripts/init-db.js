/**
 * Local helper: applies database/schema.sql (+ seed.sql with --seed) using the credentials in .env.
 *   npm run db:init -- --seed
 * WARNING: schema.sql DROPS and recreates every table. On Hostinger import the files with phpMyAdmin instead.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../src/config/env');

(async () => {
  if (env.nodeEnv === 'production' && !process.argv.includes('--force')) {
    console.error('Refusing to drop tables while NODE_ENV=production. Re-run with --force if you really mean it.');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password,
    database: env.db.name, multipleStatements: true, charset: 'utf8mb4',
  });
  const files = ['schema.sql', ...(process.argv.includes('--seed') ? ['seed.sql'] : [])];
  for (const f of files) {
    await conn.query(fs.readFileSync(path.join(__dirname, '..', 'database', f), 'utf8'));
    console.log(`applied ${f}`);
  }
  await conn.end();
})().catch((err) => { console.error(err.message); process.exit(1); });
