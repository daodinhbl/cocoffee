/**
 * Chatbot parser: cases found by running real customer messages against the printed menu. The catalog mirrors the
 * keywords of the shop's real products (including the ones that make ambiguity: Cacao / Cacao Đá Xay, Trà Đào /
 * Trà Đào Cam Sả, Yaourt 3 Tầng).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../src/utils/text');
const { detectCommand, isStrictMenu, parseOrder, extractQuantity, splitByQuantity, suggest } = require('../src/webhooks/zalo/zaloOrderParser');

const kw = (...a) => new Set(a.map(normalize));
const catalog = [
  { id: 1, name: 'Cà Phê Đen', keywords: kw('Cà Phê Đen', 'ca phe den da', 'cafe den', 'cf den', 'đen đá', 'đen') },
  { id: 2, name: 'Cà Phê Sữa', keywords: kw('Cà Phê Sữa', 'cf sua', 'ca phe sua da', 'cafe sua', 'nau da', 'nâu') },
  { id: 3, name: 'Cà Phê Muối Kem Tươi', keywords: kw('Cà Phê Muối Kem Tươi', 'cf muoi kem tuoi', 'cafe muoi kem tuoi') },
  { id: 4, name: 'Bạc Xỉu', keywords: kw('Bạc Xỉu', 'bac siu') },
  { id: 5, name: 'Trà Đào', keywords: kw('Trà Đào') },
  { id: 6, name: 'Trà Đào Cam Sả', keywords: kw('Trà Đào Cam Sả') },
  { id: 7, name: 'Yaourt 3 Tầng', keywords: kw('Yaourt 3 Tầng') },
  { id: 8, name: 'Yaourt Đá', keywords: kw('Yaourt Đá') },
  { id: 9, name: 'Cacao', keywords: kw('Cacao') },
  { id: 10, name: 'Cacao Đá Xay', keywords: kw('Cacao Đá Xay') },
  { id: 11, name: 'Sinh Tố Bơ', keywords: kw('Sinh Tố Bơ') },
  { id: 12, name: 'Sinh Tố Dâu', keywords: kw('Sinh Tố Dâu') },
  { id: 13, name: 'Thuốc lá 555', keywords: kw('Thuốc lá 555', '555', 'thuoc 555') },
  { id: 14, name: 'Yaourt Xoài', keywords: kw('Yaourt Xoài') },
  { id: 15, name: 'Yaourt Dâu', keywords: kw('Yaourt Dâu') },
  { id: 16, name: 'Nước Ép Cam', keywords: kw('Nước Ép Cam', 'ép cam') },
  { id: 17, name: 'Nước Ép Cam Cà Rốt', keywords: kw('Nước Ép Cam Cà Rốt', 'ép cam cà rốt') },
];
const flat = (r) => r.items.map((i) => `${i.productId}x${i.quantity}${i.note ? `(${i.note})` : ''}`);

test('several items typed with no separator: "2 cf sữa 1 cf đen"', () => {
  assert.deepEqual(flat(parseOrder('2 cf sữa 1 cf đen', catalog)), ['2x2', '1x1']);
  assert.deepEqual(flat(parseOrder('cho mình 2 cà phê sữa 1 bạc xỉu nha', catalog)), ['2x2', '4x1']);
  assert.deepEqual(flat(parseOrder('1 trà đào 2 bạc xỉu 3 cf đen', catalog)), ['5x1', '4x2', '1x3']);
  assert.deepEqual(flat(parseOrder('2 cf sữa ít đường 1 bạc xỉu', catalog)), ['2x2(ít đường)', '4x1'], 'an option stays with its own item');
  assert.deepEqual(flat(parseOrder('1 ly cf sữa 2 ly bạc xỉu', catalog)), ['2x1', '4x2'], 'units after the number do not hide the next item');
});

test('a number that is NOT the start of a new item stays where it is', () => {
  assert.deepEqual(flat(parseOrder('yaourt 3 tầng', catalog)), ['7x1'], 'a digit inside a product name');
  assert.deepEqual(flat(parseOrder('2 yaourt 3 tầng', catalog)), ['7x2']);
  assert.deepEqual(flat(parseOrder('cà phê sữa 2 ly', catalog)), ['2x2'], 'trailing quantity with a unit');
  assert.deepEqual(flat(parseOrder('cf sữa 2', catalog)), ['2x2'], 'trailing bare quantity');
  assert.deepEqual(flat(parseOrder('thêm 1 trà đào', catalog)), ['5x1']);
  assert.equal(parseOrder('thêm 1 trà đào', catalog).append, true, '"thêm" is still the append marker');
  assert.deepEqual(splitByQuantity('cf sữa 2 ly', catalog), ['cf sữa 2 ly']);
  assert.deepEqual(splitByQuantity('2 cf sữa 1 cf đen', catalog), ['2 cf sữa', '1 cf đen']);
  assert.deepEqual(splitByQuantity('hello there my friend 2 x', catalog).length, 1, 'no product on either side: untouched');
});

test('quantity forms: 2x, x2, bare trailing number, size is not a quantity', () => {
  assert.deepEqual(extractQuantity('2x ca phe sua'), { quantity: 2, name: 'ca phe sua' });
  assert.deepEqual(extractQuantity('ca phe sua 2x'), { quantity: 2, name: 'ca phe sua' });
  assert.deepEqual(extractQuantity('ca phe sua x2'), { quantity: 2, name: 'ca phe sua' });
  assert.deepEqual(extractQuantity('ca phe sua 2'), { quantity: 2, name: 'ca phe sua' });
  assert.deepEqual(extractQuantity('2 ca phe sua 3'), { quantity: 2, name: 'ca phe sua 3' }, 'a leading quantity wins');
  assert.deepEqual(extractQuantity('ca phe sua size 2'), { quantity: 1, name: 'ca phe sua size 2' });
  assert.deepEqual(extractQuantity('555'), { quantity: 1, name: '555' });
  assert.deepEqual(extractQuantity('thuoc 555'), { quantity: 1, name: 'thuoc 555' }, '3-digit numbers are names');
});

test('a shortened name that starts exactly one product: "cf muối"; ambiguous ones stay unmatched with suggestions', () => {
  assert.deepEqual(flat(parseOrder('1 cf muối', catalog)), ['3x1']);
  assert.deepEqual(flat(parseOrder('cà phê muối', catalog)), ['3x1']);
  const r = parseOrder('sinh tố', catalog);
  assert.deepEqual(r.items, [], 'two sinh tố: ask instead of guessing');
  assert.deepEqual(r.unmatched, ['sinh tố']);
  assert.deepEqual(r.suggestions, [['Sinh Tố Bơ', 'Sinh Tố Dâu']]);
  assert.deepEqual(flat(parseOrder('cacao đá', catalog)), ['9x1'], 'the plain Cacao keeps winning over Cacao Đá Xay');
  assert.deepEqual(flat(parseOrder('cacao đá xay', catalog)), ['10x1']);
  assert.deepEqual(flat(parseOrder('trà đào cam sả', catalog)), ['6x1']);
});

test('suggest(): shared words, best first, capped, nothing for noise', () => {
  assert.deepEqual(suggest('sinh tố xoài', catalog), ['Sinh Tố Bơ', 'Sinh Tố Dâu', 'Yaourt Xoài']);
  assert.deepEqual(suggest('xyz qwerty', catalog), []);
  assert.deepEqual(suggest('', catalog), []);
  assert.ok(suggest('cà phê', catalog, 2).length <= 2);
  const mixed = parseOrder('2 cf sữa và 1 sinh tố xoài', catalog);
  assert.deepEqual(flat(mixed), ['2x2']);
  assert.deepEqual(mixed.unmatched, ['1 sinh tố xoài']);
  assert.ok(mixed.suggestions[0].length >= 2 && mixed.suggestions[0].length <= 3);
});

test('more ways to confirm and to ask for the menu, without turning orders into commands', () => {
  for (const t of ['ok em nha', 'ok bạn nhé', 'oke anh', 'chốt', 'chốt đơn', 'chốt đơn nhé', 'đúng rồi', 'xác nhận', 'xác nhận đơn', 'đặt luôn', 'ok luôn nha']) {
    assert.equal(detectCommand(t), 'confirm', t);
  }
  for (const t of ['ok cho 2 cf sua', 'chốt 2 cf sữa', 'đúng', '2 ok', 'ko ok', 'okela anh oi', 'dat 2 cf sua']) assert.notEqual(detectCommand(t), 'confirm', t);
  for (const t of ['menu', 'xem menu', 'cho mình xin menu', 'gửi menu', 'xin menu nhé', 'thực đơn', 'quán có gì', 'quán có gì uống', 'có gì uống', 'có gì uống không', 'quán bán gì']) {
    assert.equal(detectCommand(t), 'menu', t);
  }
  for (const t of ['menu 2 cf sua', 'có 2 cf sữa không', 'quán có gì ngon 2 ly']) assert.notEqual(detectCommand(t), 'menu', t);
});

test('"name quantity name quantity" without separators: the number belongs to the item BEFORE it', () => {
  assert.deepEqual(flat(parseOrder('cf sữa 2 bạc xỉu 1', catalog)), ['2x2', '4x1']);
  assert.deepEqual(flat(parseOrder('cf đen 1 cf sữa 2', catalog)), ['1x1', '2x2']);
  assert.deepEqual(flat(parseOrder('yaourt xoài 2 yaourt dâu 3', catalog)), ['14x2', '15x3']);
  assert.deepEqual(flat(parseOrder('cf sữa 2 ly bạc xỉu 1 ly', catalog)), ['2x2', '4x1']);
  assert.deepEqual(flat(parseOrder('cf sữa 2x bạc xỉu 1x', catalog)), ['2x2', '4x1']);
  assert.deepEqual(flat(parseOrder('cf sữa x2 bạc xỉu x1', catalog)), ['2x2', '4x1']);
  assert.deepEqual(flat(parseOrder('cho mình cf sữa 2 bạc xỉu 1 nha', catalog)), ['2x2', '4x1']);
  assert.deepEqual(flat(parseOrder('2 cf sữa 1 bạc xỉu', catalog)), ['2x2', '4x1'], 'the quantity-first style is unchanged');
});

test('a digit of a product name is never a cut point', () => {
  assert.deepEqual(flat(parseOrder('yaourt 3 tầng 2 cf sữa', catalog)), ['7x2', '2x1'], 'name-first style: the 2 belongs to the yaourt');
  assert.deepEqual(flat(parseOrder('1 yaourt 3 tầng 2 cf sữa', catalog)), ['7x1', '2x2'], 'quantity-first style');
  assert.deepEqual(flat(parseOrder('1 yaourt 3 tầng 1 cf sữa', catalog)), ['7x1', '2x1']);
  assert.deepEqual(flat(parseOrder('2 yaourt 3 tầng', catalog)), ['7x2']);
});

test('"0 đường" is an option, not a quantity; percentages, times, tables and dates are not quantities', () => {
  assert.deepEqual(flat(parseOrder('2 cf sữa 0 đường 1 bạc xỉu', catalog)), ['2x2(không đường)', '4x1']);
  assert.deepEqual(flat(parseOrder('cf sữa 50%', catalog)), ['2x1']);
  assert.deepEqual(flat(parseOrder('2 cf sữa 70% đường', catalog)), ['2x2']);
  assert.deepEqual(flat(parseOrder('trà đào bàn 5', catalog)), ['5x1']);
  assert.deepEqual(flat(parseOrder('cf sữa phòng 2', catalog)), ['2x1']);
  assert.deepEqual(flat(parseOrder('cf sữa lúc 8:30', catalog)), ['2x1']);
  assert.deepEqual(flat(parseOrder('cf sữa giao 5/10', catalog)), ['2x1']);
  assert.deepEqual(flat(parseOrder('cf sữa 2', catalog)), ['2x2'], 'a real trailing quantity still works');
});

test('polite words before the quantity, and "cho thêm" is an append', () => {
  assert.deepEqual(flat(parseOrder('dạ cho mình 2 cf sữa', catalog)), ['2x2']);
  assert.deepEqual(flat(parseOrder('vâng em lấy 3 bạc xỉu nha', catalog)), ['4x3']);
  const a = parseOrder('cho thêm 2 trà đào', catalog);
  assert.deepEqual([a.append, ...flat(a)], [true, '5x2']);
  const b = parseOrder('mình thêm 1 bạc xỉu', catalog);
  assert.deepEqual([b.append, ...flat(b)], [true, '4x1']);
  assert.equal(parseOrder('thêm đường cf sữa', catalog).append, true, 'a leading "thêm" is still the marker');
  assert.equal(parseOrder('1 cf sữa thêm đá', catalog).append, false, '"thêm" later in the sentence is not');
});

test('the longer product keeps its own name; a long message costs bounded work', () => {
  assert.deepEqual(flat(parseOrder('ép cam cà rốt', catalog)), ['17x1']);
  assert.deepEqual(flat(parseOrder('1 ép cam', catalog)), ['16x1']);
  const long = 'a 1 '.repeat(500);
  const t0 = process.hrtime.bigint();
  parseOrder(long, catalog);
  parseOrder('cf 1 '.repeat(400), catalog);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 150, `2000 chars of numbers took ${ms.toFixed(0)} ms`);
});

test('only the plain "menu" forms are for groups; chatty questions need a private chat or a mention', () => {
  for (const t of ['menu', 'xem menu', 'thực đơn', '[@bot] menu']) assert.equal(isStrictMenu(t), true, t);
  for (const t of ['quán có gì', 'có gì uống', 'cho mình xin menu', 'quán bán gì']) assert.equal(isStrictMenu(t), false, t);
});
