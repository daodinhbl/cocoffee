import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/features/pos/pos_models.dart';
import 'package:cocoffee_mobile/features/pos/pos_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'pos_test_data.dart';

void main() {
  test('quick cash follows the web: exact, round up to 50k / 100k, +100k, 500k; >= total, unique, max 4', () {
    expect(quickCash(79000), [79000, 100000, 200000, 500000]);
    expect(quickCash(50000), [50000, 100000, 200000, 500000]);
    expect(quickCash(620000), [620000, 650000, 700000, 800000]);
    expect(quickCash(500000), [500000, 600000]);
  });

  test('search and emoji ignore Vietnamese accents', () {
    expect(norm('Trà Đào Cam Sả'), 'tra dao cam sa');
    expect(norm('Cà phê sữa đá'), 'ca phe sua da');
    expect(norm('Cà phê'), 'ca phe'); // decomposed input
    expect(emojiOf('Bạc xỉu'), '🥛');
    expect(emojiOf('Trà đào'), '🍑');
    expect(emojiOf('Bánh mì'), '🍰');
    expect(emojiOf('Món lạ'), '☕');
    expect(userInitials('Nguyễn Thu Ngân'), 'TN');
    expect(userInitials('boss'), 'B');
  });

  test('bootstrap parsing keeps only categories with products and reads printer VAT', () {
    final d = PosData.fromJson(bootstrap());
    expect(d.usedCategories.map((c) => c.name), ['Cà phê', 'Trà']);
    expect(d.vatRate, 8);
    expect(d.table(2)!.busy, isTrue);
    expect(d.table(3)!.label, 'B03');
    expect(d.product(21)!.imageUrl, isNull); // '' = photo removed
    expect(d.drafts.single.orderCode, 'CF261014-00042');
    expect(d.zaloLabel, 'Zalo bot OK');
  });

  test('cart: plain lines merge, noted lines stay apart, 99 cap, discount clamp and VAT', () {
    final api = MockApi();
    final c = ProviderContainer(overrides: [apiProvider.overrideWithValue(api), currentUserProvider.overrideWithValue(cashierUser)]);
    addTearDown(c.dispose);
    final n = c.read(cartProvider.notifier);
    final d = PosData.fromJson(bootstrap());
    final latte = d.product(11)!;

    n.add(latte);
    n.add(latte);
    n.setLineNote(0, 'ít đá');
    n.add(latte);
    var s = c.read(cartProvider);
    expect(s.lines.length, 2);
    expect(s.qtyOf(11), 3);
    expect(s.lines.first.toJson(), {'product_id': 11, 'quantity': 2, 'note': 'ít đá'});

    n.changeQty(1, 200);
    expect(c.read(cartProvider).lines[1].qty, 99);
    n.changeQty(1, -99);
    expect(c.read(cartProvider).lines.length, 1);

    n.setDiscount(80000.4);
    s = c.read(cartProvider);
    expect(s.subtotal, 50000);
    expect(s.discountApplied, 50000);
    expect(s.total, 0);
    n.setDiscount(10000);
    s = c.read(cartProvider);
    expect(s.total, 40000);
    expect(s.vat(8).round(), 2963);
    expect(s.dirty, isTrue);
  });

  test('checkout of a just-created order cancels it when the payment fails', () async {
    final api = MockApi();
    when(() => api.post('/orders', any())).thenAnswer((_) async => orderRes(9, 'open', 25000));
    when(() => api.post('/orders/9/pay', any()))
        .thenAnswer((_) async => throw ApiException(code: 'INSUFFICIENT_PAYMENT', status: 422, message: 'x'));
    when(() => api.post('/orders/9/cancel', any())).thenAnswer((_) async => orderRes(9, 'cancelled', 25000));
    final c = ProviderContainer(overrides: [apiProvider.overrideWithValue(api), currentUserProvider.overrideWithValue(cashierUser)]);
    addTearDown(c.dispose);
    final n = c.read(cartProvider.notifier);
    n.add(PosData.fromJson(bootstrap()).product(11)!);

    await expectLater(n.checkout(const PayRequest(method: 'cash', tendered: 1000)), throwsA(isA<ApiException>()));
    verify(() => api.post('/orders/9/cancel', any())).called(1);
    final s = c.read(cartProvider);
    expect(s.orderId, isNull);
    expect(s.busy, isFalse);
    expect(s.lines.length, 1);
    expect(posError(ApiException(code: 'INSUFFICIENT_PAYMENT', message: 'x')), 'Tiền khách đưa chưa đủ.');
  });
}
