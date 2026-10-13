class AppError extends Error {
  /**
   * @param {number} status  HTTP status
   * @param {string} code    machine-readable code (e.g. INSUFFICIENT_STOCK)
   * @param {string} message human readable
   * @param {object} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = { AppError };
