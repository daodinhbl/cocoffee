import 'package:cocoffee_mobile/core/widgets/common.dart';
import 'package:cocoffee_mobile/features/inventory/inventory_screen.dart';
import 'package:flutter/material.dart' hide Thumb;
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'inventory_fixtures.dart';

void main() {
  late MockApi api;

  setUp(() {
    api = MockApi();
    when(() => api.get('/inventory', query: any(named: 'query'))).thenAnswer((inv) async {
      final q = inv.namedArguments[#query] as Map<String, dynamic>?;
      return q?['all'] == '1' ? inventoryAllResponse() : inventoryActiveResponse();
    });
  });

  testWidgets('phone: summary cards, pills, item cards; Sắp hết pill and accent-free search filter the list', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const InventoryScreen(), api: api));
    await tester.pumpAndSettle();

    final q = verify(() => api.get('/inventory', query: captureAny(named: 'query'))).captured.single as Map;
    expect(q, {'all': '1'});

    expect(find.text('Nguyên liệu'), findsOneWidget);
    expect(find.text('Thêm nguyên liệu'), findsOneWidget);
    expect(find.text('MẶT HÀNG ĐANG DÙNG'), findsOneWidget);
    expect(find.text('1 ngừng dùng'), findsOneWidget);
    expect(find.text('DƯỚI MỨC TỐI THIỂU'), findsOneWidget);
    expect(find.text('Cần nhập thêm →'), findsOneWidget);

    // Pills: Tất cả 5 / Sắp hết 2 (active and at or below the minimum).
    expect(find.descendant(of: find.byKey(const ValueKey('pill-all')), matching: find.text('5')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('pill-low')), matching: find.text('2')), findsOneWidget);

    // Row card for the coffee: quantity + unit, value, status badge, the three actions.
    final coffee = find.byKey(const ValueKey('inv-row-1'));
    expect(coffee, findsOneWidget);
    expect(find.descendant(of: coffee, matching: find.text('CF-ROBUSTA · g')), findsOneWidget);
    expect(find.descendant(of: coffee, matching: find.text('987.000đ')), findsOneWidget);
    expect(find.descendant(of: coffee, matching: find.text('Đủ')), findsOneWidget);
    expect(find.descendant(of: coffee, matching: find.text('Nhập')), findsOneWidget);
    expect(find.descendant(of: coffee, matching: find.text('Kiểm kê')), findsOneWidget);
    expect(find.descendant(of: coffee, matching: find.text('Sửa')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('pill-low')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('inv-row-1')), findsNothing);
    expect(find.byKey(const ValueKey('inv-row-2')), findsOneWidget);
    expect(find.byKey(const ValueKey('inv-row-3')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('inv-row-2')), matching: find.text('Sắp hết')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('inv-row-3')), matching: find.text('Hết hàng')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('pill-all')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('inventory-search')), 'tra den');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('inv-row-4')), findsOneWidget);
    expect(find.byKey(const ValueKey('inv-row-1')), findsNothing);

    await tester.enterText(find.byKey(const ValueKey('inventory-search')), 'khong-co');
    await tester.pumpAndSettle();
    expect(find.text('Không có mặt hàng phù hợp.'), findsOneWidget);
  });

  testWidgets('phone: Thêm nguyên liệu validates the opening cost, then POSTs /inventory', (tester) async {
    await setSurface(tester, phone);
    when(() => api.post('/inventory', any())).thenAnswer((_) async => {
          'item': {'id': 9, 'sku': 'DUONG', 'name': 'Đường cát', 'unit': 'g', 'quantity_on_hand': 5000, 'avg_cost': 22, 'min_stock': 1000, 'is_active': 1},
        });
    await tester.pumpWidget(await testApp(const InventoryScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('add-item')));
    await tester.pumpAndSettle();
    expect(find.text('Tồn đầu kỳ'), findsOneWidget);
    expect(find.text('Chỉ dùng khi thêm mới. Sau đó tồn kho thay đổi qua Nhập kho và Kiểm kê.'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('item-name')), 'Đường cát');
    await tester.enterText(find.byKey(const ValueKey('item-sku')), 'duong');
    await tester.enterText(find.byKey(const ValueKey('item-unit')), 'g');
    await tester.enterText(find.byKey(const ValueKey('item-min')), '1000');
    await tester.enterText(find.byKey(const ValueKey('item-qty')), '5000');
    await tester.tap(find.text('Lưu'));
    await tester.pumpAndSettle();
    expect(find.text('Nhập giá vốn (đ/đơn vị) cho tồn đầu kỳ.'), findsOneWidget);
    verifyNever(() => api.post(any(), any()));

    await tester.enterText(find.byKey(const ValueKey('item-cost')), '22');
    await tester.tap(find.text('Lưu'));
    await tester.pumpAndSettle();

    final body = verify(() => api.post('/inventory', captureAny())).captured.single as Map;
    expect(body, {
      'sku': 'DUONG',
      'name': 'Đường cát',
      'unit': 'g',
      'min_stock': 1000,
      'quantity_on_hand': 5000,
      'avg_cost': 22,
      'is_active': true,
    });
    verifyNever(() => api.put(any(), any()));
    expect(find.text('Đã thêm nguyên liệu Đường cát.'), findsOneWidget);
    // The list is reloaded after the write.
    verify(() => api.get('/inventory', query: any(named: 'query'))).called(2);
  });

  testWidgets('tablet: table with level bars; Kiểm kê dialog POSTs /inventory/:id/adjust as waste', (tester) async {
    await setSurface(tester, tablet);
    when(() => api.post('/inventory/2/adjust', any())).thenAnswer((_) async => {'quantity_on_hand': 3, 'delta': -1});
    await tester.pumpWidget(await testApp(const InventoryScreen(), api: api));
    await tester.pumpAndSettle();

    for (final h in ['MẶT HÀNG', 'TỒN KHO', 'TỐI THIỂU', 'GIÁ VỐN BQ', 'GIÁ TRỊ', 'TÌNH TRẠNG']) {
      expect(find.text(h), findsOneWidget, reason: h);
    }
    expect(find.text('1.766.000đ'), findsOneWidget);
    expect(find.text('HẾT HÀNG'), findsOneWidget);
    expect(find.text('Ngừng dùng'), findsOneWidget);
    expect(find.byType(LevelBar), findsNWidgets(5));

    await tester.tap(find.byKey(const ValueKey('adjust-2')));
    await tester.pumpAndSettle();
    expect(find.text('Kiểm kê — Sữa đặc Ông Thọ'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('adjust-type')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Hao hụt / hỏng (đặt lại số còn lại)').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('adjust-qty')), '3');
    await tester.enterText(find.byKey(const ValueKey('adjust-note')), 'Móp 1 lon');
    await tester.tap(find.text('Ghi nhận'));
    await tester.pumpAndSettle();

    final body = verify(() => api.post('/inventory/2/adjust', captureAny())).captured.single as Map;
    expect(body, {'new_quantity': 3, 'type': 'waste', 'note': 'Móp 1 lon'});
    expect(find.text('Đã điều chỉnh tồn kho (−1).'), findsOneWidget);
    expect(find.text('Kiểm kê — Sữa đặc Ông Thọ'), findsNothing);
  });

  testWidgets('cashier: active items from GET /inventory, no admin actions', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const InventoryScreen(), api: api, user: cashierUser));
    await tester.pumpAndSettle();

    final q = verify(() => api.get('/inventory', query: captureAny(named: 'query'))).captured.single;
    expect(q, isNull);
    expect(find.text('Thêm nguyên liệu'), findsNothing);
    expect(find.text('Kiểm kê'), findsNothing);
    expect(find.descendant(of: find.byKey(const ValueKey('pill-all')), matching: find.text('4')), findsOneWidget);
    // Stock value computed from quantity x average cost when the API does not send it.
    expect(find.descendant(of: find.byKey(const ValueKey('inv-row-1')), matching: find.text('987.000đ')), findsOneWidget);
  });
}
