const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, formatVnd, formatShopTime } = require('../src/utils/text');
const { detectCommand, parseOrder, extractQuantity } = require('../src/webhooks/zalo/zaloOrderParser');

const kw = (...a) => new Set(a.map(normalize));
const catalog = [
  { id: 1, name: 'Cà phê đen đá', keywords: kw('Cà phê đen đá', 'cà phê đen', 'cafe đen', 'cf đen') },
  { id: 2, name: 'Cà phê sữa đá', keywords: kw('Cà phê sữa đá', 'cà phê sữa', 'cafe sữa', 'cf sữa', 'nâu đá') },
  { id: 3, name: 'Bạc xỉu', keywords: kw('Bạc xỉu', 'bạc sỉu') },
  { id: 4, name: 'Trà đào', keywords: kw('Trà đào', 'trà đào cam sả') },
  { id: 6, name: 'Thuốc lá 555', keywords: kw('Thuốc lá 555', '555', 'thuốc 555') },
  { id: 7, name: 'Marlboro', keywords: kw('Marlboro', 'malboro') },
];
const flat = (r) => r.items.map((i) => `${i.productId}x${i.quantity}`);

test('normalize strips Vietnamese diacritics', () => {
  assert.equal(normalize('  Cà phê SỮA, đá!! '), 'ca phe sua da');
  assert.equal(normalize('Đào'), 'dao');
});

test('confirm commands: ok / oke and variants', () => {
  for (const t of ['ok', 'OK', 'oke', 'Oke!', 'okie', 'okay', 'oki', 'okkk', 'okee', 'ok nhé', 'oke em', 'ok.', ' Ok ']) {
    assert.equal(detectCommand(t), 'confirm', t);
  }
  for (const t of ['ok cho 2 cf sua', 'oc', 'ko ok', '2 ok', 'okela anh oi']) assert.notEqual(detectCommand(t), 'confirm', t);
});

test('cancel / menu commands', () => {
  assert.equal(detectCommand('huy'), 'cancel');
  assert.equal(detectCommand('Hủy đơn'), 'cancel');
  assert.equal(detectCommand('menu'), 'menu');
  assert.equal(detectCommand('thực đơn'), 'menu');
});

test('quantity extraction forms', () => {
  assert.deepEqual(extractQuantity('2 cf sua'), { quantity: 2, name: 'cf sua' });
  assert.deepEqual(extractQuantity('cf sua x2'), { quantity: 2, name: 'cf sua' });
  assert.deepEqual(extractQuantity('cf sua x 3'), { quantity: 3, name: 'cf sua' });
  assert.deepEqual(extractQuantity('ca phe sua 2 ly'), { quantity: 2, name: 'ca phe sua' });
  assert.deepEqual(extractQuantity('1 bao 555'), { quantity: 1, name: '555' });
  assert.deepEqual(extractQuantity('hai ly bac xiu'), { quantity: 2, name: 'bac xiu' });
  assert.deepEqual(extractQuantity('cho minh 3 tra dao nhe'), { quantity: 3, name: 'tra dao' });
  assert.deepEqual(extractQuantity('bac xiu'), { quantity: 1, name: 'bac xiu' });
  assert.equal(extractQuantity('99 ly cf').quantity, 50, 'quantity is capped');
  assert.deepEqual(extractQuantity('555 den'), { quantity: 1, name: '555 den' }, '3-digit numbers are names, not quantities');
});

test('multi-item order with separators, diacritics and unit words', () => {
  const r = parseOrder('2 cà phê sữa, 1 bạc xỉu và 3 trà đào', catalog);
  assert.deepEqual(flat(r), ['2x2', '3x1', '4x3']);
  assert.deepEqual(r.unmatched, []);
});

test('bare keyword that looks like a number (555) is a product, not a quantity', () => {
  assert.deepEqual(flat(parseOrder('555', catalog)), ['6x1']);
  assert.deepEqual(flat(parseOrder('2 bao 555', catalog)), ['6x2']);
  assert.deepEqual(flat(parseOrder('thuốc 555 x3', catalog)), ['6x3']);
});

test('aliases, typos and duplicates merge', () => {
  assert.deepEqual(flat(parseOrder('2 cf sua, 1 cafe sua', catalog)), ['2x3']);
  assert.deepEqual(flat(parseOrder('1 malboro', catalog)), ['7x1']);
  assert.deepEqual(flat(parseOrder('1 marlbro', catalog)), ['7x1'], 'fuzzy match survives a typo');
});

test('unmatched segments are reported, matched ones kept', () => {
  const r = parseOrder('1 bac xiu, 2 pizza hai san', catalog);
  assert.deepEqual(flat(r), ['3x1']);
  assert.deepEqual(r.unmatched, ['2 pizza hai san']);
});

test('"thêm" prefix switches to append mode', () => {
  const r = parseOrder('thêm 1 trà đào', catalog);
  assert.equal(r.append, true);
  assert.deepEqual(flat(r), ['4x1']);
  assert.equal(parseOrder('1 trà đào', catalog).append, false);
});

test('group @mentions are ignored', () => {
  assert.deepEqual(flat(parseOrder('[@607812198688816074] 2 cf den', catalog)), ['1x2']);
  assert.equal(detectCommand('[@607812198688816074] ok'), 'confirm');
});

test('chit-chat produces no items', () => {
  assert.deepEqual(parseOrder('chào shop, hôm nay mấy giờ đóng cửa vậy', catalog).items, []);
});

test('money / time formatting', () => {
  assert.equal(formatVnd(1234567), '1.234.567');
  assert.equal(formatVnd(79000), '79.000');
  assert.equal(formatVnd(0), '0');
  assert.equal(formatShopTime(new Date('2026-10-13T07:05:00Z')), '13/10/2026 14:05');
});
