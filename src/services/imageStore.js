const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const logger = require('../utils/logger');
const mediaModel = require('../models/mediaModel');
const { AppError } = require('../utils/httpError');

/**
 * Product / ingredient photos uploaded from the Web Admin.
 * The browser already crops and compresses the picture (square JPEG, ~400px) and sends it as a data URL in a
 * normal form field (`image_data`), so no multipart parser is needed. Here we only accept real JPEG/PNG/WebP
 * bytes up to 600 KB and store them in MySQL (media_files): a Hostinger Node.js redeploy replaces public_html,
 * which would wipe anything written under public/. They are served at /media/<id>-<slug>.<ext> (routes/mediaRoutes.js).
 * Older photos under /uploads/ (scripts/sync_images.js before this change) keep working and are still cleaned up.
 */
const MAX_BYTES = 600 * 1024;
const FOLDERS = new Set(['products', 'ingredients']);
const UPLOAD_ROOT = path.join(env.rootDir, 'public', 'uploads');
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MEDIA_URL = /^\/media\/(\d+)-[a-z0-9-]+\.(jpg|png|webp)$/;

const MAGIC = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', test: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
];

function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'anh';
}

/** Validate raw image bytes; returns { buf, ext } or throws a user-facing error. */
function check(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf.length > MAX_BYTES) {
    throw new AppError(400, 'VALIDATION', 'Ảnh quá lớn hoặc bị hỏng (tối đa 600 KB sau khi nén).');
  }
  const kind = MAGIC.find((k) => k.test(buf));
  if (!kind) throw new AppError(400, 'VALIDATION', 'Tệp tải lên không phải là ảnh.');
  return { buf, ext: kind.ext };
}

/** Decode + validate a data URL; returns { buf, ext } or throws a user-facing error. */
function decode(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new AppError(400, 'VALIDATION', 'Ảnh không hợp lệ: chỉ nhận JPEG, PNG hoặc WebP.');
  return check(Buffer.from(m[2], 'base64'));
}

/** Store validated bytes and return the public URL, e.g. /media/12-ca-phe-sua-da.jpg */
async function saveBuffer(buf, folder, name) {
  if (!FOLDERS.has(folder)) throw new Error(`unknown image folder ${folder}`);
  const { ext } = check(buf);
  const id = await mediaModel.create({ folder, mime: MIME[ext], bytes: buf });
  return `/media/${id}-${slugify(name)}.${ext}`;   // a new id per upload: browsers never show a stale cached photo
}

/** Store a data URL from the photo field; returns the public URL. */
function save(dataUrl, folder, name) {
  return saveBuffer(decode(dataUrl).buf, folder, name);
}

/** media_files id behind a /media/ URL, or null. */
function mediaIdOf(url) {
  const m = MEDIA_URL.exec(String(url || ''));
  return m ? Number(m[1]) : null;
}

/** Delete a previously stored photo. Only our own photos are touched: /media/ rows and files inside public/uploads. */
async function remove(url) {
  const id = mediaIdOf(url);
  if (id) {
    await mediaModel.remove(id).catch((err) => logger.warn(`Could not delete photo ${url}`, err));
    return;
  }
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  const file = path.normalize(path.join(env.rootDir, 'public', url));
  if (!file.startsWith(UPLOAD_ROOT + path.sep)) return;
  fs.rm(file, { force: true }, () => {});
}

/**
 * Apply the image fields of a submitted form to one record.
 *   image_data   - new photo (data URL) -> saved, old photo removed
 *   image_remove - '1' -> photo removed: image_url = '' (not NULL), so the shipped illustration that
 *                  config/menuPhotos.js gives items without a photo (NULL) is not put back at the next boot
 * @returns {Promise<string|undefined>} the new image_url ('' when removed), undefined when unchanged
 */
async function applyFromForm(body, { dirKey, id, name, currentUrl, setImage }) {
  if (body.image_data) {
    const url = await save(body.image_data, dirKey, name);
    await setImage(id, url);
    if (currentUrl && currentUrl !== url) await remove(currentUrl);
    return url;
  }
  if (body.image_remove === '1' && currentUrl) {
    await setImage(id, '');
    await remove(currentUrl);
    return '';
  }
  return undefined;
}

module.exports = { save, saveBuffer, remove, decode, check, mediaIdOf, applyFromForm, slugify, MAX_BYTES, MIME };
