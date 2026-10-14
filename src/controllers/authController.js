const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');
const apiToken = require('../services/apiToken');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');
// DUMMY_HASH: always run bcrypt, even for unknown users, at the same cost as real hashes (12), or unknown usernames
// answer measurably faster.
const { isDemoAccount, MIN_PASSWORD, DUMMY_HASH } = require('./admin/authPages');

/** What the app may see of a user (never the password hash or its stamp). */
const publicUser = (user, mustChangePassword) => ({
  id: user.id, username: user.username, full_name: user.full_name, role: user.role, is_active: user.is_active,
  must_change_password: Boolean(mustChangePassword),
});

async function login(req, res) {
  const username = v.str(req.body?.username, 'username', { max: 50 });
  const password = v.str(req.body?.password, 'password', { max: 200 });
  const user = await userModel.findByUsername(username);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !user.is_active || !ok) throw new AppError(401, 'BAD_CREDENTIALS', 'Wrong username or password');

  // Same rule as the Web Admin: an admin still on a short (factory) password must replace it first; never cashiers
  // or the public demo account.
  const weak = user.role === 'admin' && password.length < MIN_PASSWORD && !isDemoAccount(user);
  const token = apiToken.issue(user, { mustChangePassword: weak });
  res.json({
    token,
    must_change_password: weak,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, must_change_password: weak },
  });
}

const me = (req, res) => res.json({ user: publicUser(req.user, req.auth?.mustChangePassword) });

/** Replace the caller's own password. Answers a fresh token: every token issued before is revoked. */
async function changePassword(req, res) {
  const current = v.str(req.body?.current_password, 'current_password', { max: 200 });
  const next = v.str(req.body?.new_password, 'new_password', { max: 200 });
  if (next.length < MIN_PASSWORD) throw new AppError(400, 'WEAK_PASSWORD', `new_password must be at least ${MIN_PASSWORD} characters`);

  const user = await userModel.findByUsername(req.user.username);
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Account disabled');
  if (isDemoAccount(user)) throw new AppError(403, 'DEMO_ACCOUNT', 'The demo account password cannot be changed');
  if (!(await bcrypt.compare(current, user.password_hash))) throw new AppError(401, 'BAD_CREDENTIALS', 'Current password is wrong');
  if (next === current) throw new AppError(400, 'VALIDATION', 'new_password must differ from current_password');
  const hash = await bcrypt.hash(next, 12);
  await userModel.setPassword(user.id, hash);
  res.json({ ok: true, token: apiToken.issue({ ...user, password_hash: hash }, { mustChangePassword: false }) });
}

module.exports = { login, me, changePassword, publicUser };
