/**
 * Classification of stock items for the tabs on Web Admin > Nguyên liệu. The group is stored in
 * inventory_items.group_code; while it is NULL ("Tự động") it is guessed from the SKU / name, so a freshly imported
 * list is already sorted sensibly and a person only fixes the exceptions.
 */
const GROUPS = [
  { code: 'raw', label: 'Nguyên liệu pha chế' },
  { code: 'packaging', label: 'Bao bì & vật dụng' },
  { code: 'retail', label: 'Hàng bán lẻ' },
  { code: 'other', label: 'Khác' },
];
const CODES = GROUPS.map((g) => g.code);

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const PACKAGING = /(^|[^a-z])(ly|nap|ong hut|cup|lid|straw|tui|bao bi|hop|khay|giay|khan|mang boc|bag|napkin|tray)([^a-z]|$)/;

/** Group code for an item: the stored one, else a guess (GD- = goods sold as they are, RM- = raw material). */
function groupOf(item) {
  if (CODES.includes(item.group_code)) return item.group_code;
  const sku = String(item.sku || '').toUpperCase();
  const text = fold(`${item.name} ${item.sku}`);
  if (sku.startsWith('GD-') || sku.startsWith('GD_')) return 'retail';
  if (PACKAGING.test(text)) return 'packaging';
  if (sku.startsWith('RM-') || sku.startsWith('RM_')) return 'raw';
  return 'other';
}

const labelOf = (code) => (GROUPS.find((g) => g.code === code) || {}).label || '';

module.exports = { GROUPS, CODES, groupOf, labelOf };
