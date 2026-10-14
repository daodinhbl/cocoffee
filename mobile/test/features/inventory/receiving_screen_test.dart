import 'package:cocoffee_mobile/features/inventory/receiving_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'inventory_fixtures.dart';

void main() {
  late MockApi api;

  setUp(() {
    api = MockApi();
    when(() => api.get('/inventory', query: any(named: 'query'))).thenAnswer((_) async => inventoryActiveResponse());
    when(() => api.get('/inventory/purchases', query: any(named: 'query'))).thenAnswer((_) async => purchasesResponse());
  });

  testWidgets('phone: ?item preselects; line total is turned into the unit cost; POST /inventory/:id/receive', (tester) async {
    await setSurface(tester, phone);
    when(() => api.post('/inventory/1/receive', any())).thenAnswer((_) async => {'quantity_on_hand': 5525, 'avg_cost': 280.86});
    await tester.pumpWidget(await testApp(const ReceivingScreen(itemId: 1), api: api));
    await tester.pumpAndSettle();

    final q = verify(() => api.get('/inventory', query: captureAny(named: 'query'))).captured.single;
    expect(q, isNull);
    expect(verify(() => api.get('/inventory/purchases', query: captureAny(named: 'query'))).captured.single, {'limit': '30'});

    expect(find.text('Phiếu nhập'), findsOneWidget);
    expect(find.text('Cà phê Robusta (tồn 3.525 g)'), findsOneWidget);

    await tester.tap(find.text('Theo thành tiền'));
    await tester.pumpAndSettle();
    expect(find.text('Thành tiền (đ)'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('receive-qty')), '2.000');
    await tester.enterText(find.byKey(const ValueKey('receive-cost')), '570.000');
    await tester.enterText(find.byKey(const ValueKey('receive-note')), 'NCC Thành Phát · HĐ 0013');
    await tester.pump();
    expect(find.text('Đơn giá 285đ / g'), findsOneWidget);

    await tester.ensureVisible(find.byKey(const ValueKey('receive-submit')));
    await tester.tap(find.byKey(const ValueKey('receive-submit')));
    await tester.pumpAndSettle();

    final body = verify(() => api.post('/inventory/1/receive', captureAny())).captured.single as Map;
    expect(body, {'quantity': 2000, 'unit_cost': 285, 'note': 'NCC Thành Phát · HĐ 0013'});
    expect(find.text('Đã nhập kho. Tồn mới: 5.525, giá vốn bình quân: 281đ.'), findsOneWidget);
    // Form cleared, item and purchases reloaded.
    expect(find.text('Đơn giá 285đ / g'), findsNothing);
    verify(() => api.get('/inventory', query: any(named: 'query'))).called(1);
    verify(() => api.get('/inventory/purchases', query: any(named: 'query'))).called(1);
  });

  testWidgets('phone: recent purchases as cards', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const ReceivingScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.byKey(const ValueKey('purchase-99')), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Lần nhập gần đây'), findsOneWidget);
    final row = find.byKey(const ValueKey('purchase-103'));
    expect(find.descendant(of: row, matching: find.text('10/10/2026 09:30')), findsOneWidget);
    expect(find.descendant(of: row, matching: find.text('+2.000 g')), findsOneWidget);
    expect(find.descendant(of: row, matching: find.text('285đ')), findsOneWidget);
    expect(find.descendant(of: row, matching: find.text('Chủ Quán')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('purchase-99')), matching: find.text('—')), findsOneWidget);
  });

  testWidgets('tablet: form beside the table; submit without an item shows the error and sends nothing', (tester) async {
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const ReceivingScreen(), api: api));
    await tester.pumpAndSettle();

    for (final h in ['THỜI GIAN', 'NGUYÊN LIỆU', 'SỐ LƯỢNG', 'ĐƠN GIÁ', 'NGƯỜI NHẬP']) {
      expect(find.text(h), findsOneWidget, reason: h);
    }
    expect(find.text('Sữa đặc Ông Thọ'), findsOneWidget);
    expect(find.text('— chọn —'), findsOneWidget);
    expect(find.text('Đơn giá nhập (đ / đơn vị)'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('receive-qty')), '10');
    await tester.enterText(find.byKey(const ValueKey('receive-cost')), '26000');
    await tester.pump();
    expect(find.text('Thành tiền 260.000đ'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('receive-submit')));
    await tester.pumpAndSettle();
    expect(find.text('Chọn nguyên liệu.'), findsOneWidget);
    verifyNever(() => api.post(any(), any()));

    await tester.tap(find.byType(DropdownButtonFormField<int>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sữa đặc Ông Thọ (tồn 4 lon)').last);
    await tester.pumpAndSettle();
    when(() => api.post('/inventory/2/receive', any())).thenAnswer((_) async => {'quantity_on_hand': 14, 'avg_cost': 26000});
    await tester.tap(find.byKey(const ValueKey('receive-submit')));
    await tester.pumpAndSettle();
    final body = verify(() => api.post('/inventory/2/receive', captureAny())).captured.single as Map;
    expect(body, {'quantity': 10, 'unit_cost': 26000});
  });
}
