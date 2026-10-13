/** lowercase, strip Vietnamese diacritics, keep [a-z0-9], collapse whitespace. */
function normalize(input) {
  return String(input ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** 1234567 -> "1.234.567" (no Intl/ICU dependency). */
function formatVnd(amount) {
  const n = Math.round(Number(amount) || 0);
  return `${n < 0 ? '-' : ''}${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

/** Sørensen–Dice similarity on character bigrams, 0..1. */
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const g = b.slice(i, i + 2);
    const c = grams.get(g) || 0;
    if (c > 0) { grams.set(g, c - 1); overlap += 1; }
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

/** Wall-clock string "dd/mm/yyyy HH:MM" in UTC+7 regardless of server TZ. */
function formatShopTime(date, offsetHours = 7) {
  const d = new Date(new Date(date).getTime() + offsetHours * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

module.exports = { normalize, formatVnd, dice, formatShopTime };
