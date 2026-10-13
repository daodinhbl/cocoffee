const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { AppError } = require('../utils/httpError');
const userModel = require('../models/userModel');

/** Bearer JWT (issued by POST /api/auth/login) -> req.user. */
async function requireAuth(req, _res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Missing bearer token');
  let payload;
  try {
    payload = jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'] });
  } catch (_) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }
  const user = await userModel.findById(payload.sub);
  if (!user || !user.is_active) throw new AppError(401, 'UNAUTHORIZED', 'Account disabled');
  req.user = user;
  next();
}

const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user?.role)) throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
  next();
};

module.exports = { requireAuth, requireRole };
