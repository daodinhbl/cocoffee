#!/usr/bin/env node
/**
 * Resets an admin password from the machine itself (the PC administrator's way out when the recovery code is lost; the Windows manager
 * calls it).   node scripts/reset-admin-password.js [username]   (default: the first admin)
 * Prints a random temporary password and a NEW recovery code; the old code and every session of that account stop working.
 * The temporary password is 16 characters, so the account is not forced to change it, but do change it in Cài đặt.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { defaultPool } = require('../src/config/db');
const userModel = require('../src/models/userModel');
const recovery = require('../src/services/passwordRecovery');

(async () => {
  const name = process.argv[2];
  let user = name ? await userModel.findByUsername(name) : null;
  if (!name) {
    const [rows] = await defaultPool.query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1");
    user = rows[0] ? await userModel.findById(rows[0].id) : null;
  }
  if (!user || user.role !== 'admin') throw new Error(name ? `Không có tài khoản quản trị "${name}".` : 'Chưa có tài khoản quản trị nào.');
  const password = crypto.randomBytes(12).toString('base64url');
  await userModel.setPassword(user.id, await bcrypt.hash(password, 12));
  const code = await recovery.issueFor(user.id);
  console.log(`Tài khoản: ${user.username}\nMật khẩu tạm: ${password}\nMã khôi phục mới: ${code}`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => defaultPool.end());
