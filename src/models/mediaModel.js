const { pool } = require('../config/db');

const db = (conn) => conn || pool;

/** Photos uploaded from the Web Admin (table media_files). Bytes stay in MySQL so a redeploy never loses them. */
async function create({ folder, mime, bytes }, conn) {
  const [res] = await db(conn).query(
    'INSERT INTO media_files (folder, mime, bytes, size) VALUES (?, ?, ?, ?)',
    [folder, mime, bytes, bytes.length]
  );
  return res.insertId;
}

/** @returns {Promise<{id:number, mime:string, bytes:Buffer}|null>} */
async function get(id, conn) {
  const [rows] = await db(conn).query('SELECT id, mime, bytes FROM media_files WHERE id = ?', [id]);
  return rows[0] || null;
}

async function remove(id, conn) {
  await db(conn).query('DELETE FROM media_files WHERE id = ?', [id]);
}

module.exports = { create, get, remove };
