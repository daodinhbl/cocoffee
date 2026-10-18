const fsp = require('fs/promises');
const nodemailer = require('nodemailer');
const env = require('../config/env');
const settingsModel = require('../models/settingsModel');
const backupService = require('./backupService');
const logger = require('../utils/logger');

/**
 * Daily database backup by e-mail: at BACKUP_MAIL_HOUR (default 02:00 shop time) a fresh dump of the whole database is
 * mailed as an attachment (.sql.gz, restorable from Admin > Sao lưu & khôi phục) to BACKUP_MAIL_TO. Needs an SMTP account
 * (SMTP_HOST / SMTP_USER / SMTP_PASS); without one nothing is sent and the status says so. The last successful day is kept in
 * app_settings, so a restart inside the hour never sends twice and a missed hour is made up the same day.
 */
const KEY_DAY = 'backup.mail.lastDay';
const status = { at: null, error: null, lastDay: null, skipped: null };

const cfg = () => env.backupMail;
const configured = () => Boolean(cfg().smtpHost && cfg().smtpUser && cfg().smtpPass && cfg().to);

let transportFactory = (c) => nodemailer.createTransport({
  host: c.smtpHost, port: c.smtpPort, secure: c.smtpSecure, auth: { user: c.smtpUser, pass: c.smtpPass }, connectionTimeout: 20000, socketTimeout: 60000,
});
/** Tests plug in a fake transport. */
const setTransportFactory = (f) => { transportFactory = f; };

/** Shop time = UTC+7. */
function shopNow(now = new Date()) {
  const t = new Date(now.getTime() + 7 * 3600 * 1000);
  return { day: t.toISOString().slice(0, 10), hour: t.getUTCHours() };
}

async function lastDay() {
  try { return (await settingsModel.getByPrefix(KEY_DAY))[KEY_DAY] || null; } catch (_) { return null; }
}

/** Dumps the database and mails it. @returns {{ sent: boolean, name, size, reason? }} */
async function sendNow({ now = new Date() } = {}) {
  if (!configured()) { status.skipped = 'SMTP chưa cấu hình (SMTP_HOST, SMTP_USER, SMTP_PASS)'; return { sent: false, reason: status.skipped }; }
  const c = cfg();
  const dump = await backupService.createTemp();
  try {
    const { size } = await fsp.stat(dump.file);
    const tooBig = size > c.maxAttachmentMb * 1024 * 1024;
    const { day } = shopNow(now);
    const shop = env.business.shopName || 'CoCoffee';
    const transport = transportFactory(c);
    await transport.sendMail({
      from: c.from || c.smtpUser,
      to: c.to,
      subject: `[${shop}] Sao lưu cơ sở dữ liệu ${day}`,
      text: tooBig
        ? `Bản sao lưu ngày ${day} (${(size / 1048576).toFixed(1)} MB) lớn hơn ${c.maxAttachmentMb} MB nên không đính kèm. Tải về ở Admin > Sao lưu & khôi phục.`
        : `Bản sao lưu cơ sở dữ liệu của ${shop} ngày ${day}, ${(size / 1024).toFixed(0)} KB. Khôi phục: Admin > Sao lưu & khôi phục > Tải lên. Giữ file ở nơi an toàn: trong đó có dữ liệu khách hàng và doanh thu.`,
      attachments: tooBig ? [] : [{ filename: dump.name, path: dump.file }],
    });
    return { sent: true, name: dump.name, size, attached: !tooBig };
  } finally {
    await dump.cleanup();
  }
}

/** Once a day, in the first half hour of BACKUP_MAIL_HOUR (or later the same day when that was missed). Never throws. */
async function runIfDue(now = new Date()) {
  if (!configured()) return 'not-configured';
  const { day, hour } = shopNow(now);
  if (hour < cfg().hour) return 'too-early';
  if ((status.lastDay || (status.lastDay = await lastDay())) === day) return 'done-today';
  try {
    const r = await sendNow({ now });
    if (r.sent) {
      status.at = now; status.error = null; status.lastDay = day;
      await settingsModel.setMany({ [KEY_DAY]: day }, null);
      logger.info(`Backup e-mailed to ${cfg().to}: ${r.name} (${r.size} bytes)`);
      return 'sent';
    }
    return 'skipped';
  } catch (err) {
    status.error = err.message;
    logger.error('Backup e-mail failed', err);
    return 'failed';
  }
}

/** Checks every 10 minutes. Never keeps the process alive. */
function startScheduler() {
  if (!configured()) { logger.info('Backup e-mail off: set SMTP_HOST, SMTP_USER and SMTP_PASS to turn it on'); return; }
  const tick = () => runIfDue().catch((err) => logger.error('Backup mail scheduler', err));
  setTimeout(tick, 2 * 60 * 1000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
}

module.exports = { configured, sendNow, runIfDue, startScheduler, setTransportFactory, shopNow, status };
