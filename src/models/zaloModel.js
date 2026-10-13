const { pool } = require('../config/db');

const db = (conn) => conn || pool;

// ---------------------------------------------------------------- sessions
const sessionModel = {
  /** Find-or-create the (chat, sender) row and lock it for the rest of the transaction. */
  async lockOrCreate(conn, { chatType, chatId, userId }) {
    await conn.query(
      `INSERT INTO zalo_sessions (chat_type, chat_id, zalo_user_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [chatType, chatId, userId]
    );
    return this.find(conn, { chatType, chatId, userId }, { forUpdate: true });
  },

  async find(conn, { chatType, chatId, userId }, { forUpdate = false } = {}) {
    const [rows] = await db(conn).query(
      `SELECT s.*, (s.expires_at IS NOT NULL AND s.expires_at < NOW()) AS is_expired
         FROM zalo_sessions s
        WHERE s.chat_type = ? AND s.chat_id = ? AND s.zalo_user_id = ? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [chatType, chatId, userId]
    );
    return rows[0] || null;
  },

  async setDraft(conn, sessionId, orderId, msgId, ttlMinutes) {
    await conn.query(
      `UPDATE zalo_sessions
          SET state = 'awaiting_confirm', draft_order_id = ?, last_msg_id = ?,
              last_activity_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
        WHERE id = ?`,
      [orderId, msgId || null, ttlMinutes, sessionId]
    );
  },

  async clearDraft(conn, sessionId) {
    await conn.query(
      `UPDATE zalo_sessions
          SET state = 'idle', draft_order_id = NULL, expires_at = NULL, last_activity_at = NOW()
        WHERE id = ?`,
      [sessionId]
    );
  },
};

// ------------------------------------------------------------------ events
const eventModel = {
  /** @returns {Promise<boolean>} true when the event is new, false when it is a retry/duplicate */
  async insertIfNew({ key, eventName, chatId, senderId, payload, numRetry }) {
    const [res] = await pool.query(
      `INSERT IGNORE INTO zalo_events (event_key, event_name, chat_id, sender_id, payload, num_retry)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [key, eventName, chatId || null, senderId || null, JSON.stringify(payload), numRetry || 0]
    );
    return res.affectedRows === 1;
  },

  async mark(key, status, error = null) {
    await pool.query(
      'UPDATE zalo_events SET status = ?, error = ?, processed_at = NOW() WHERE event_key = ?',
      [status, error ? String(error).slice(0, 500) : null, key]
    );
  },
};

// ------------------------------------------------------------------ tokens
const tokenModel = {
  async get(conn, { forUpdate = false } = {}) {
    const [rows] = await db(conn).query(
      `SELECT access_token, refresh_token, access_expires_at,
              (access_expires_at < DATE_ADD(NOW(), INTERVAL 10 MINUTE)) AS needs_refresh
         FROM zalo_tokens WHERE id = 1${forUpdate ? ' FOR UPDATE' : ''}`
    );
    return rows[0] || null;
  },

  async save(conn, { accessToken, refreshToken, expiresInSeconds }) {
    await conn.query(
      `INSERT INTO zalo_tokens (id, access_token, refresh_token, access_expires_at)
       VALUES (1, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
       ON DUPLICATE KEY UPDATE access_token = VALUES(access_token), refresh_token = VALUES(refresh_token),
                               access_expires_at = VALUES(access_expires_at)`,
      [accessToken, refreshToken, expiresInSeconds]
    );
  },
};

module.exports = { sessionModel, eventModel, tokenModel };
