const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const { defaultPool, makePool } = require('../config/db');
const cloudSync = require('./cloudSync');
const logger = require('../utils/logger');

/**
 * Runs the local -> cloud push on a timer when CLOUD_SYNC_ENABLED=true (the Windows installer sets it). Each run first checks that the
 * cloud database answers; offline is not an error, it simply tries again at the next tick. The outcome of the last run is written to
 * CLOUD_SYNC_STATUS_FILE (JSON) so the Windows manager can show it without touching the database.
 */
const cfg = () => env.cloudSync;
const enabled = () => Boolean(cfg().enabled && cfg().host && cfg().name && cfg().user);

let remote = null;
const remotePool = () => {
  if (!remote) remote = makePool({ host: cfg().host, port: cfg().port, user: cfg().user, password: cfg().password, database: cfg().name }, 3);
  return remote;
};

const status = { state: 'idle', lastRunAt: null, lastOkAt: null, lastRows: 0, error: null, running: false };

function writeStatus() {
  const file = cfg().statusFile;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...status, enabled: enabled(), host: cfg().host, name: cfg().name, intervalMinutes: cfg().minutes }));
  } catch (err) {
    logger.warn('Cloud sync status file not written', err);
  }
}

async function reachable() {
  try {
    const conn = await Promise.race([remotePool().getConnection(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    try { await conn.query('SELECT 1'); } finally { conn.release(); }
    return true;
  } catch (_) {
    return false;
  }
}

/** One push. @returns {'ok'|'offline'|'failed'|'busy'|'disabled'} */
async function runOnce({ dir = 'push', full = false } = {}) {
  if (!enabled()) return 'disabled';
  if (status.running) return 'busy';
  status.running = true;
  status.lastRunAt = new Date().toISOString();
  try {
    if (!(await reachable())) {
      status.state = 'offline';
      status.error = 'Không kết nối được CSDL trên Hostinger (mất mạng hoặc IP chưa được phép). Sẽ thử lại.';
      return 'offline';
    }
    const from = dir === 'push' ? defaultPool : remotePool();
    const to = dir === 'push' ? remotePool() : defaultPool;
    const r = await cloudSync.sync({ from, to, local: defaultPool, dir, full });
    status.state = 'ok';
    status.lastOkAt = new Date().toISOString();
    status.lastRows = r.rows;
    status.error = null;
    return 'ok';
  } catch (err) {
    status.state = 'failed';
    status.error = err.message;
    logger.error('Cloud sync failed', err);
    return 'failed';
  } finally {
    status.running = false;
    writeStatus();
  }
}

function startScheduler() {
  if (!enabled()) return;
  const tick = () => runOnce().catch((err) => logger.error('Cloud sync scheduler', err));
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, Math.max(1, cfg().minutes) * 60 * 1000).unref();
  logger.info(`Cloud sync on: local -> ${cfg().host}/${cfg().name} every ${cfg().minutes} min`);
  writeStatus();
}

module.exports = { enabled, runOnce, startScheduler, status, remotePool };
