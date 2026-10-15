import 'package:cocoffee_mobile/core/notify/new_order_watcher.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('one order: code, customer, item count and total', () {
    final t = describeNewOrders([const NewOrder(id: 5, code: 'CF-5', total: 79000, itemCount: 3, customer: 'Chị Lan')]);
    expect(t.title, 'Đơn mới CF-5');
    expect(t.body, contains('Chị Lan'));
    expect(t.body, contains('3 món'));
    expect(t.body, contains('79.000'));
  });

  test('several orders are grouped into one notification', () {
    final t = describeNewOrders([
      const NewOrder(id: 5, code: 'CF-5', total: 30000, itemCount: 1),
      const NewOrder(id: 6, code: 'CF-6', total: 40000, itemCount: 2),
    ]);
    expect(t.title, '2 đơn mới');
    expect(t.body, contains('CF-5, CF-6'));
    expect(t.body, contains('70.000'));
  });
}
