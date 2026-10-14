import 'package:cocoffee_mobile/features/inventory/inventory_detail_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'inventory_fixtures.dart';

void main() {
  late MockApi api;

  setUp(() {
    api = MockApi();
    when(() => api.get('/inventory/1', query: any(named: 'query'))).thenAnswer((_) async => inventoryDetailResponse());
  });

  testWidgets('phone: header, key numbers, chart tooltip, drinks, ledger type pills', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const InventoryDetailScreen(id: 1), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Cà phê Robusta'), findsOneWidget);
    expect(find.text('Đủ'), findsOneWidget);
    expect(find.textContaining('đơn vị g · dùng trong 3 món'), findsOneWidget);
    expect(find.byKey(const ValueKey('detail-receive')), findsOneWidget);
    expect(find.text('Kiểm kê'), findsWidgets);
    expect(find.text('Sửa'), findsOneWidget);

    expect(find.text('3.525 g'), findsOneWidget);
    expect(find.text('Tối thiểu 3.000 g'), findsOneWidget);
    expect(find.text('280đ / g'), findsOneWidget);
    expect(find.text('Nhập gần nhất 285đ · 10/10/2026'), findsOneWidget);

    // Swipe the KPI strip to the usage card.
    await tester.drag(find.text('TỒN KHO'), const Offset(-600, 0));
    await tester.pumpAndSettle();
    expect(find.text('TIÊU HAO 30 NGÀY'), findsOneWidget);
    expect(find.text('2.400 g'), findsOneWidget);
    expect(find.text('TB 80 g/ngày · đủ dùng khoảng 44 ngày · hao hụt 200'), findsOneWidget);

    // Chart: 6 movements + the opening point; tap the left edge for the first point's tooltip.
    expect(find.text('Diễn biến tồn kho'), findsOneWidget);
    expect(find.text('Tồn sau mỗi lần xuất nhập · 6 lần gần nhất'), findsOneWidget);
    expect(find.text('Mức tối thiểu '), findsOneWidget);
    final paint = find.byKey(const ValueKey('stock-trend-paint'));
    await tester.tapAt(tester.getTopLeft(paint) + const Offset(1, 80));
    await tester.pump();
    expect(find.text('Tồn trước lần đầu · 01/10/2026 09:00'), findsOneWidget);
    await tester.tapAt(tester.getTopRight(paint) + const Offset(-1, 80));
    await tester.pump();
    expect(find.text('Bán hàng −25 · 14/10/2026 10:15'), findsOneWidget);

    await tester.scrollUntilVisible(find.text('Dùng trong món'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('25 g / phần'), findsOneWidget);
    expect(find.text('7.000đ'), findsOneWidget); // 25 g x 280đ
    expect(find.text('20 g / phần · ngừng bán'), findsOneWidget);

    await tester.scrollUntilVisible(find.byKey(const ValueKey('ledger-sale')), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Lịch sử xuất nhập'), findsOneWidget);
    expect(find.text('6 lần'), findsOneWidget);
    expect(find.byKey(const ValueKey('ledger-return')), findsNothing); // no rows of that type, no pill
    await tester.tap(find.byKey(const ValueKey('ledger-sale')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('mv-106')), findsOneWidget);
    expect(find.byKey(const ValueKey('mv-104')), findsOneWidget);
    expect(find.byKey(const ValueKey('mv-103')), findsNothing);
    expect(find.descendant(of: find.byKey(const ValueKey('mv-104')), matching: find.text('#4180')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('mv-104')), matching: find.text('Tự động (đơn hàng)')), findsOneWidget);
  });

  testWidgets('tablet: ledger table; Sửa dialog PUTs /inventory/:id', (tester) async {
    await setSurface(tester, tablet);
    when(() => api.put('/inventory/1', any())).thenAnswer((_) async => {'item': inventoryDetailResponse()['item']});
    await tester.pumpWidget(await testApp(const InventoryDetailScreen(id: 1), api: api));
    await tester.pumpAndSettle();

    expect(find.text('GIÁ TRỊ TỒN'), findsOneWidget);
    expect(find.text('987.000đ'), findsOneWidget);
    expect(find.text('CHỨNG TỪ / GHI CHÚ'), findsOneWidget);
    expect(find.text('NGƯỜI GHI'), findsOneWidget);
    expect(find.text('NCC Thành Phát · HĐ 0012'), findsOneWidget);
    expect(find.text('+2.000 g'), findsNWidgets(2));
    expect(find.text('Ẩm mốc'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('detail-edit')));
    await tester.pumpAndSettle();
    expect(find.text('Sửa nguyên liệu'), findsOneWidget);
    expect(find.byKey(const ValueKey('item-qty')), findsNothing); // opening stock is for new items only
    await tester.enterText(find.byKey(const ValueKey('item-name')), 'Cà phê Robusta Đắk Lắk');
    await tester.enterText(find.byKey(const ValueKey('item-min')), '4000');
    await tester.tap(find.byKey(const ValueKey('item-active')));
    await tester.tap(find.text('Lưu'));
    await tester.pumpAndSettle();

    final body = verify(() => api.put('/inventory/1', captureAny())).captured.single as Map;
    expect(body, {'name': 'Cà phê Robusta Đắk Lắk', 'unit': 'g', 'min_stock': 4000, 'is_active': false});
    expect(find.text('Đã cập nhật nguyên liệu.'), findsOneWidget);
    verify(() => api.get('/inventory/1', query: any(named: 'query'))).called(2);
  });

  testWidgets('empty item: placeholders for chart, drinks and ledger', (tester) async {
    await setSurface(tester, tablet);
    when(() => api.get('/inventory/7', query: any(named: 'query'))).thenAnswer((_) async => {
          'item': {'id': 7, 'sku': 'ONG-HUT', 'name': 'Ống hút giấy', 'unit': 'cái', 'quantity_on_hand': 0, 'avg_cost': 0, 'min_stock': 0, 'is_active': 1},
          'usage': {'days': 30, 'used': 0, 'wasted': 0, 'received': 0, 'lastPurchase': null},
          'used_in': [],
          'movements': [],
        });
    await tester.pumpWidget(await testApp(const InventoryDetailScreen(id: 7), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Hết hàng'), findsOneWidget);
    expect(find.text('Chưa đặt mức tối thiểu'), findsOneWidget);
    expect(find.text('Chưa có phiếu nhập kho'), findsOneWidget);
    expect(find.text('Chưa xuất bán trong 30 ngày qua'), findsOneWidget);
    expect(find.text('Biểu đồ sẽ hiện khi có nhập kho, bán hàng hoặc kiểm kê.'), findsOneWidget);
    expect(find.text('Chưa có món nào dùng nguyên liệu này.'), findsOneWidget);
    expect(find.text('Chưa có biến động nào. Nhập kho lần đầu để bắt đầu theo dõi.'), findsOneWidget);
  });
}
