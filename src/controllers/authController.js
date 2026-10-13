const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const userModel = require('../models/userModel');
const { AppError } = require('../utils/httpError');
const v = require('../utils/validate');

// Constant-time-ish: always run bcrypt, even for unknown users.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

async function login(req, res) {
  const username = v.str(req.body?.username, 'username', { max: 50 });
  const password = v.str(req.body?.password, 'password', { max: 200 });
  const user = await userModel.findByUsername(username);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !user.is_active || !ok) throw new AppError(401, 'BAD_CREDENTIALS', 'Wrong username or password');

  const token = jwt.sign({ sub: user.id, role: user.role }, env.jwt.secret, { algorithm: 'HS256', expiresIn: env.jwt.expiresIn });
  res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role } });
}

const me = (req, res) => res.json({ user: req.user });

/** Lets the default admin/admin be replaced right after first login. */
async function changePassword(req, res) {
  const current = v.str(req.body?.current_password, 'current_password', { max: 200 });
  const next = v.str(req.body?.new_password, 'new_password', { max: 200 });
  if (next.length < 10) throw new AppError(400, 'WEAK_PASSWORD', 'new_password must be at least 10 characters');

  const user = await userModel.findByUsername(req.user.username);
  if (!(await bcrypt.compare(current, user.password_hash))) throw new AppError(401, 'BAD_CREDENTIALS', 'Current password is wrong');
  await userModel.setPassword(user.id, await bcrypt.hash(next, 12));
  res.json({ ok: true });
}

module.exports = { login, me, changePassword };
