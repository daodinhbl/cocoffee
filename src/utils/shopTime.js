const env = require('../config/env');

/** "+07:00" -> 420 (minutes east of UTC). Falls back to UTC+7 for anything unparsable. */
function offsetMinutes(tz = env.db.timezone) {
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(String(tz).trim());
  if (!m) return 420;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Shop-local calendar day ("YYYY-MM-DD") of `date`, shifted by `addDays`. */
function shopDay(date = new Date(), addDays = 0) {
  const d = new Date(new Date(date).getTime() + offsetMinutes() * 60000);
  d.setUTCDate(d.getUTCDate() + addDays);
  return ymd(d);
}

/** Strict "YYYY-MM-DD" check (rejects 2026-02-31). Returns the string or null. */
function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || ymd(d) !== value ? null : value;
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

/** Inclusive day range -> half-open DATETIME bounds usable in `col >= ? AND col < ?`. */
function dayBounds(fromDay, toDay) {
  return { from: `${fromDay} 00:00:00`, to: `${addDays(toDay, 1)} 00:00:00` };
}

/** "5 phút trước" style relative time (Vietnamese). */
function ago(date, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(date).getTime()) / 1000));
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

module.exports = { shopDay, parseDay, addDays, dayBounds, ago, offsetMinutes };
