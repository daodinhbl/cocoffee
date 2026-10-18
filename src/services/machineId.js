const crypto = require('crypto');
const { execFile } = require('child_process');

/**
 * The id of this PC as the Windows manager (desktop/lib/core/machine_id.dart) computes it, so the web pages can show the same
 * "mã máy" the owner sends to the licence issuer: the first 128 bits of SHA-256("tasotek-pos|<machine guid lower>|<system drive
 * serial UPPER>") as 8 groups of 4 hex characters. Only available on Windows; null elsewhere (Hostinger, Linux dev boxes).
 */
function machineIdFrom({ guid, volumeSerial }) {
  const hex = crypto.createHash('sha256').update(`tasotek-pos|${String(guid).trim().toLowerCase()}|${String(volumeSerial).trim().toUpperCase()}`).digest('hex').slice(0, 32).toUpperCase();
  return hex.match(/.{4}/g).join('-');
}

const parseMachineGuid = (out) => (/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/.exec(String(out)) || [])[1] || null;

function parseVolumeSerial(out) {
  const all = [...String(out).matchAll(/\b([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})\s*$/gm)];
  return all.length ? all[all.length - 1][1] : null;
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout)));

let cached;

/** @returns {Promise<string|null>} */
async function read() {
  if (cached !== undefined) return cached;
  if (process.platform !== 'win32') { cached = null; return cached; }
  const [reg, vol] = await Promise.all([
    run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']),
    run('cmd', ['/c', 'vol', 'C:']),
  ]);
  const guid = parseMachineGuid(reg);
  const serial = parseVolumeSerial(vol);
  cached = guid && serial ? machineIdFrom({ guid, volumeSerial: serial }) : null;
  return cached;
}

module.exports = { read, machineIdFrom, parseMachineGuid, parseVolumeSerial, reset: () => { cached = undefined; } };
