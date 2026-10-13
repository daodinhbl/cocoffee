/**
 * SAMPLE data behind the admin UI shell. Numbers mirror database/seed.sql so the screens look real,
 * but nothing here is read from MySQL: the /admin pages are intentionally unauthenticated until the
 * admin login is built, so they must never render real business data.
 */

// VND per ONE base unit (same values as seed.sql)
const INGREDIENTS = [
  { id: 1, name: 'Cà phê rang xay', unit: 'g', unitCost: 280 },
  { id: 2, name: 'Sữa đặc', unit: 'g', unitCost: 70 },
  { id: 3, name: 'Sữa tươi', unit: 'ml', unitCost: 30 },
  { id: 4, name: 'Syrup đào', unit: 'ml', unitCost: 90 },
  { id: 5, name: 'Trà đen', unit: 'g', unitCost: 180 },
  { id: 6, name: 'Đường nước', unit: 'ml', unitCost: 20 },
  { id: 7, name: 'Đá viên', unit: 'g', unitCost: 2 },
  { id: 8, name: 'Ly nhựa + nắp', unit: 'pcs', unitCost: 900 },
  { id: 9, name: 'Đào miếng ngâm', unit: 'pcs', unitCost: 3000 },
];
const ING = new Map(INGREDIENTS.map((i) => [i.id, i]));

// [ingredientId, quantity]
const DRINKS = [
  { id: 1, sku: 'CF-DEN-DA', name: 'Cà phê đen đá', price: 20000, lines: [[1, 18], [6, 10], [7, 150], [8, 1]] },
  { id: 2, sku: 'CF-SUA-DA', name: 'Cà phê sữa đá', price: 25000, lines: [[1, 18], [2, 30], [7, 150], [8, 1]] },
  { id: 3, sku: 'BAC-XIU', name: 'Bạc xỉu', price: 29000, lines: [[1, 10], [2, 25], [3, 60], [7, 150], [8, 1]] },
  { id: 4, sku: 'TRA-DAO', name: 'Trà đào', price: 35000, lines: [[5, 8], [4, 30], [9, 2], [6, 15], [7, 150], [8, 1]] },
  { id: 5, sku: 'TRA-DA', name: 'Trà đá', price: 8000, lines: [[5, 5], [7, 150], [8, 1]] },
];

const toRecipe = (d) => {
  const ingredients = d.lines.map(([id, qty]) => ({ ref: id, name: ING.get(id).name, unit: ING.get(id).unit, qty, cost: ING.get(id).unitCost * qty }));
  const cogs = ingredients.reduce((s, i) => s + i.cost, 0);
  return { id: d.id, sku: d.sku, name: d.name, price: d.price, ingredients, cogs, margin: ((d.price - cogs) / d.price) * 100 };
};

const drinks = DRINKS.map(toRecipe);
const byId = new Map(drinks.map((d) => [d.id, d]));

// Combos are made of products, so their "ingredients" are the products (qty = number of items).
const COMBOS = [
  { id: 101, sku: 'CB-2CF', name: 'Combo 2 Cà phê sữa', price: 45000, items: [[2, 2]] },
  { id: 102, sku: 'CB-SANG', name: 'Combo Sáng (Cà phê đen + Bạc xỉu)', price: 45000, items: [[1, 1], [3, 1]] },
  { id: 103, sku: 'CB-CHILL', name: 'Combo Chill (Trà đào + Trà đá)', price: 40000, items: [[4, 1], [5, 1]] },
];
const combos = COMBOS.map((c) => {
  const ingredients = c.items.map(([pid, qty]) => ({ ref: pid, name: byId.get(pid).name, unit: 'ly', qty, cost: byId.get(pid).cogs * qty }));
  const cogs = ingredients.reduce((s, i) => s + i.cost, 0);
  return { id: c.id, sku: c.sku, name: c.name, price: c.price, ingredients, cogs, margin: ((c.price - cogs) / c.price) * 100 };
});

// What the create/edit dialog offers per tab: raw ingredients for drinks, finished drinks for combos.
const catalog = {
  drink: INGREDIENTS.map((i) => ({ id: i.id, name: i.name, unit: i.unit, unitCost: i.unitCost })),
  combo: drinks.map((d) => ({ id: d.id, name: d.name, unit: 'ly', unitCost: Math.round(d.cogs) })),
};

const all = [...drinks, ...combos];
const stats = {
  total: all.length,
  missing: 0,
  avgMargin: all.reduce((s, r) => s + r.margin, 0) / all.length,
};

const dashboard = {
  kpis: [
    { label: 'Doanh thu hôm nay', value: 4_820_000, delta: '+12,4% so với hôm qua', tone: 'good' },
    { label: 'Giá vốn (COGS)', value: 1_512_400, delta: '31,4% doanh thu', tone: 'neutral' },
    { label: 'Lãi gộp', value: 3_307_600, delta: '68,6% biên lợi nhuận', tone: 'good' },
    { label: 'Đơn Zalo chờ thu', value: 3, delta: '2 đơn chờ khách xác nhận', tone: 'warn', plain: true },
  ],
  recentOrders: [
    { code: 'CF261013-00042', channel: 'zalo', total: 79000, status: 'Chờ thu', tone: 'warn', time: '14:05' },
    { code: 'CF261013-00041', channel: 'pos', total: 145000, status: 'Đã thu', tone: 'good', time: '13:52' },
    { code: 'CF261013-00040', channel: 'pos', total: 58000, status: 'Đã thu', tone: 'good', time: '13:40' },
    { code: 'CF261013-00039', channel: 'zalo', total: 35000, status: 'Đã thu', tone: 'good', time: '13:21' },
    { code: 'CF261013-00038', channel: 'pos', total: 92000, status: 'Đã thu', tone: 'good', time: '13:05' },
  ],
  lowStock: [
    { name: 'Sữa tươi', unit: 'ml', onHand: 420, min: 500 },
    { name: 'Ly nhựa + nắp', unit: 'pcs', onHand: 48, min: 50 },
    { name: 'Syrup đào', unit: 'ml', onHand: 260, min: 300 },
    { name: 'Thuốc lá 555', unit: 'bao', onHand: 8, min: 10 },
  ],
};

const notifications = [
  { id: 1, text: 'Sữa tươi dưới mức tồn tối thiểu', time: '5 phút trước', tone: 'warn' },
  { id: 2, text: 'Đơn Zalo CF261013-00042 chờ thu tiền', time: '12 phút trước', tone: 'info' },
  { id: 3, text: 'Bill Zalo gửi lỗi — CF261013-00031', time: '1 giờ trước', tone: 'bad' },
];

module.exports = { INGREDIENTS, drinks, combos, catalog, stats, dashboard, notifications };
