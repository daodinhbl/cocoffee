const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');
const { AppError } = require('../utils/httpError');

/**
 * Product / ingredient photos uploaded from the Web Admin.
 * The browser already crops and compresses the picture (square JPEG, ~400px) and sends it as a data URL in a
 * normal form field (`image_data`), so no multipart parser is needed. Here we only accept real JPEG/PNG/WebP
 * bytes up to 600 KB and write them under public/uploads/<dir>/ (the same folders scripts/sync_images.js uses).
 */
const MAX_BYTES = 600 * 1024;
const DIRS = { products: 'products', ingredients: 'ingredients' };
const UPLOAD_ROOT = path.join(env.rootDir, 'public', 'uploads');

const MAGIC = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', test: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
];

function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'anh';
}

/** Decode + validate a data URL; returns { buf, ext } or throws a user-facing error. */
function decode(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new AppError(400, 'VALIDATION', 'Ảnh không hợp lệ: chỉ nhận JPEG, PNG hoặc WebP.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > MAX_BYTES) throw new AppError(400, 'VALIDATION', 'Ảnh quá lớn hoặc bị hỏng (tối đa 600 KB sau khi nén).');
  const kind = MAGIC.find((k) => k.test(buf));
  if (!kind) throw new AppError(400, 'VALIDATION', 'Tệp tải lên không phải là ảnh.');
  return { buf, ext: kind.ext };
}

/** Save and return the public URL, e.g. /uploads/products/ca-phe-sua-da-2-1a2b3c.jpg */
function save(dataUrl, dirKey, id, name) {
  const dir = DIRS[dirKey];
  if (!dir) throw new Error(`unknown image folder ${dirKey}`);
  const { buf, ext } = decode(dataUrl);
  const file = `${slugify(name)}-${id}-${crypto.randomBytes(3).toString('hex')}.${ext}`;   // new name: browsers never show a stale cached photo
  fs.mkdirSync(path.join(UPLOAD_ROOT, dir), { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_ROOT, dir, file), buf);
  return `/uploads/${dir}/${file}`;
}

/** Delete a previously stored photo; only files inside public/uploads are ever touched. */
function remove(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  const file = path.normalize(path.join(env.rootDir, 'public', url));
  if (!file.startsWith(UPLOAD_ROOT + path.sep)) return;
  fs.rm(file, { force: true }, () => {});
}

/**
 * Apply the image fields of a submitted form to one record.
 *   image_data   - new photo (data URL) -> saved, old file removed
 *   image_remove - '1' -> photo cleared
 * @returns {Promise<string|null|undefined>} the new image_url, null when cleared, undefined when unchanged
 */
async function applyFromForm(body, { dirKey, id, name, currentUrl, setImage }) {
  if (body.image_data) {
    const url = save(body.image_data, dirKey, id, name);
    await setImage(id, url);
    if (currentUrl && currentUrl !== url) remove(currentUrl);
    return url;
  }
  if (body.image_remove === '1' && currentUrl) {
    await setImage(id, null);
    remove(currentUrl);
    return null;
  }
  return undefined;
}

module.exports = { save, remove, decode, applyFromForm, slugify, MAX_BYTES };
