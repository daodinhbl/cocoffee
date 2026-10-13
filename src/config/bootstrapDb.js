const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('./env');
const logger = require('../utils/logger');

const DB_DIR = path.join(env.rootDir, 'database');

/**
 * First-boot database setup for hosts that cannot import SQL (Hostinger's API only gives a phpMyAdmin
 * link, and the platform-generated DB password is never shown to anyone).
 *
 * Safety contract:
 *   - does nothing unless AUTO_BOOTSTRAP_DB=true;
 *   - runs ONLY when the target database has ZERO tables. schema.sql starts with DROP TABLE IF EXISTS,
 *     so the emptiness check is what guarantees a redeploy can never wipe real data;
 *   - SEED_DEMO=true additionally loads seed.sql (demo menu/BOM/tables + the default admin account).
 * Failures are logged, never thrown: the API still starts and /health reports the database state.
 *
 * @returns {Promise<'disabled'|'skipped-not-empty'|'applied'|'failed'>}
 */
async function bootstrapIfEmpty() {
  if (!env.db.autoBootstrap) return 'disabled';

  let conn;
  try {
    conn = await mysql.createConnection({
      host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password,
      database: env.db.name, multipleStatements: true, charset: 'utf8mb4',
    });
    const [[{ tables }]] = await conn.query(
      'SELECT COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = DATABASE()'
    );
    if (tables > 0) {
      logger.info(`DB bootstrap skipped: database already has ${tables} table(s)`);
      return 'skipped-not-empty';
    }

    const files = ['schema.sql', ...(env.db.seedDemo ? ['seed.sql'] : [])];
    for (const f of files) {
      await conn.query(fs.readFileSync(path.join(DB_DIR, f), 'utf8'));
      logger.info(`DB bootstrap applied ${f}`);
    }
    return 'applied';
  } catch (err) {
    logger.error('DB bootstrap failed', err);
    return 'failed';
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

module.exports = { bootstrapIfEmpty };
