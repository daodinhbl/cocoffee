const { AppError } = require('../utils/httpError');
const userModel = require('../models/userModel');
const apiToken = require('../services/apiToken');

// While the token says "must change password" (mcp), only these paths (relative to /api) answer.
const MCP_ALLOWED = new Set(['/auth/me', '/auth/change-password']);

/**
 * Bearer JWT (issued by POST /api/auth/login or /api/auth/change-password) -> req.user.
 *  - audience/issuer checked (the Web Admin cookie JWT is refused);
 *  - the password stamp must match the user's current password (older tokens die on a change or reset);
 *  - the role always comes from the database row, not from the token.
 */
async function requireAuth(req, _res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Missing bearer token');
  let payload;
  try {
    payload = apiToken.verify(token);
  } catch (_) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }
  const user = await userModel.findById(payload.sub);
  if (!user || !user.is_active) throw new AppError(401, 'UNAUTHORIZED', 'Account disabled');
  if (typeof payload.pws !== 'string' || payload.pws !== user.pw_stamp) throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  const mustChangePassword = payload.mcp === 1;
  if (mustChangePassword && !MCP_ALLOWED.has(req.path)) {
    throw new AppError(403, 'MUST_CHANGE_PASSWORD', 'Change the default password before using the app');
  }
  req.user = user;
  req.auth = { mustChangePassword };
  next();
}

const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user?.role)) throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
  next();
};

module.exports = { requireAuth, requireRole };
