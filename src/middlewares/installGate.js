const installService = require('../services/installService');

const OPEN = [/^\/cai-dat(\/|$)/, /^\/health$/, /^\/favicon/, /^\/brand\//, /^\/install\//];

/** Sends every request to /cai-dat until the shop has been set up (see services/installService.js). */
async function installGate(req, res, next) {
  if (OPEN.some((re) => re.test(req.path))) return next();
  if (await installService.isInstalled()) return next();
  if (req.path.startsWith('/api/')) return res.status(503).json({ error: { code: 'NOT_INSTALLED', message: 'The site has not been set up yet. Open /cai-dat in a browser.' } });
  return res.redirect(302, '/cai-dat');
}

module.exports = { installGate };
