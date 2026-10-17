const fs = require('fs');
const path = require('path');
const env = require('../config/env');

/**
 * Finished jobs shown on /ky-thuat. The owner drops photos into public/cong-trinh/ and lists them in
 * public/cong-trinh/projects.json:  [{ "title": "...", "place": "...", "type": "camera|dien|nuoc|smarthome|solar", "photo": "ten-anh.jpg", "note": "..." }]
 * Missing / malformed file or a photo that is not there = the entry (or the whole gallery) is simply left out.
 */
const DIR = path.join(env.rootDir, 'public', 'cong-trinh');
const TYPES = new Set(['camera', 'dien', 'nuoc', 'smarthome', 'solar']);

function list() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8')); } catch (_) { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 24).map((p) => {
    const photo = String(p?.photo ?? '');
    if (!/^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i.test(photo) || !fs.existsSync(path.join(DIR, photo))) return null;
    return {
      title: String(p.title ?? '').slice(0, 80),
      place: String(p.place ?? '').slice(0, 80),
      note: String(p.note ?? '').slice(0, 200),
      type: TYPES.has(p.type) ? p.type : 'dien',
      photo: `/cong-trinh/${photo}`,
    };
  }).filter((p) => p && p.title);
}

module.exports = { list, TYPES };
