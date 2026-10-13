// stdout/stderr end up in Passenger's log (cPanel > Setup Node.js App > log file).
const line = (level, msg, meta) => {
  const extra = meta === undefined ? '' : ` ${meta instanceof Error ? meta.stack || meta.message : JSON.stringify(meta)}`;
  return `${new Date().toISOString()} [${level}] ${msg}${extra}`;
};

module.exports = {
  info: (msg, meta) => console.log(line('info', msg, meta)),
  warn: (msg, meta) => console.warn(line('warn', msg, meta)),
  error: (msg, meta) => console.error(line('error', msg, meta)),
};
