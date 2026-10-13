const { AppError } = require('../utils/httpError');
const logger = require('../utils/logger');

const notFound = (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} not found` } });

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  if (err.errno === 1062) { // ER_DUP_ENTRY
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with the same unique value already exists' } });
  }
  if (err.errno === 1451 || err.errno === 1452) { // FK violations
    return res.status(409).json({ error: { code: 'CONSTRAINT', message: 'Record is referenced by, or references, other data' } });
  }
  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

module.exports = { notFound, errorHandler };
