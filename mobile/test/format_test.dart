import 'package:cocoffee_mobile/core/format.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('money and quantities match the Web Admin', () {
    expect(money(1250000), '1.250.000đ');
    expect(money('25000.00'), '25.000đ');
    expect(money(0), '0đ');
    expect(money(-30000), '−30.000đ');
    expect(qty(1234.5), '1.234,5');
    expect(qty(18), '18');
    expect(qty(0.25), '0,25');
    expect(qty('37600.000'), '37.600');
    expect(signed(1000), '+1.000');
    expect(signed(-600), '−600');
    expect(pct(66.64), '66,6%');
  });

  test('shop time is UTC+7 whatever the device zone', () {
    expect(shopTime('2026-10-13T15:07:41.000Z'), '13/10/2026 22:07');
    expect(shopDay('2026-10-13T18:30:00.000Z'), '14/10/2026');
    expect(shopClock('2026-10-14T01:56:58Z'), '08:56');
    expect(shopTime(null), '—');
  });

  test('initial of a Vietnamese name', () {
    expect(initial('đá viên'), 'Đ');
    expect(initial(''), '?');
  });
}
