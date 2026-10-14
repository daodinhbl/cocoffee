import 'package:cocoffee_mobile/features/orders/orders_providers.dart';
import 'package:cocoffee_mobile/features/orders/orders_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'orders_fixtures.dart';

void main() {
  late MockApi api;

  setUp(() {
    api = MockApi();
    when(() => api.get('/orders', query: any(named: 'query'))).thenAnswer((_) async => ordersResponse());
  });

  Finder tabs() => find.descendant(of: find.byKey(const Key('orders-tabs')), matching: find.byType(Scrollable)).first;

  Finder tab(String label) => find.descendant(of: find.byKey(const Key('orders-tabs')), matching: find.text(label));

  Finder mainList() => find.descendant(of: find.byKey(const Key('orders-list')), matching: find.byType(Scrollable)).first;

  /// Every query sent to GET /api/orders, in order.
  List<Map<String, dynamic>> queries() =>
      verify(() => api.get('/orders', query: captureAny(named: 'query'))).captured.cast<Map<String, dynamic>>();

  testWidgets('phone: summary cards, status tabs with counts, filters and order cards', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrdersScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Đơn hàng'), findsOneWidget);
    expect(find.text('Bán hàng (POS)'), findsOneWidget);
    // summary cards (first two visible in the swipe strip)
    expect(find.text('TỔNG SỐ ĐƠN'), findsOneWidget);
    expect(find.text('60'), findsWidgets);
    expect(find.text('Tất cả thời gian · 4 chờ xác nhận'), findsOneWidget);
    expect(find.text('DOANH THU HOÀN TẤT'), findsOneWidget);
    expect(find.text('975.000đ'), findsOneWidget);
    // status tabs in the web order with counts
    for (final t in ['Tất cả', 'Chờ xác nhận', 'Đang phục vụ', 'Chưa thu', 'Hoàn tất', 'Đã hủy']) {
      await tester.scrollUntilVisible(tab(t), 120, scrollable: tabs());
      expect(tab(t), findsOneWidget);
    }
    // filter card
    expect(find.text('Tìm mã đơn (VD: CF261013)'), findsOneWidget);
    expect(find.text('Mọi kênh'), findsOneWidget);
    expect(find.text('Từ ngày'), findsOneWidget);
    expect(find.text('Đến ngày'), findsOneWidget);
    expect(find.text('Lọc'), findsOneWidget);
    expect(find.text('Xóa'), findsNothing);
    expect(find.text('Hôm nay'), findsOneWidget);
    expect(find.text('7 ngày'), findsOneWidget);

    await tester.scrollUntilVisible(find.text('Hiển thị 1–5 / 60 đơn'), 300, scrollable: mainList());
    expect(find.text('Hiển thị 1–5 / 60 đơn'), findsOneWidget);

    // first card: open POS order at table B03
    await tester.scrollUntilVisible(find.text('CF261014-00012'), 200, scrollable: mainList());
    expect(find.text('14/10/2026 09:30'), findsWidgets);
    expect(find.text('Bàn B03'), findsOneWidget);
    expect(find.text('79.000đ'), findsOneWidget);
    // Zalo order delivered but not paid, with a failed receipt and a customer
    await tester.scrollUntilVisible(find.text('Chị Lan'), 200, scrollable: mainList());
    expect(find.text('Chờ thu tiền'), findsOneWidget);
    expect(find.text('Bill lỗi'), findsOneWidget);
    // draft Zalo without customer/table
    await tester.scrollUntilVisible(find.text('Khách Zalo'), 200, scrollable: mainList());
    expect(find.text('Chờ khách xác nhận'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('CF261014-00008'), 200, scrollable: mainList());
    expect(find.text('Đã hủy'), findsWidgets);
    expect(find.text('Mang đi'), findsWidgets);

    // pagination like the web
    await tester.scrollUntilVisible(find.text('Sau →'), 200, scrollable: mainList());
    expect(find.text('← Trước'), findsNothing);

    final q = queries().single;
    expect(q['page'], 1);
    expect(q['status'], isNull);
    expect(q['payment'], isNull);
  });

  testWidgets('phone: the "Chưa thu" tab asks for completed + unpaid, keeping other filters', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrdersScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(tab('Chưa thu'), 120, scrollable: tabs());
    await tester.ensureVisible(tab('Chưa thu'));
    await tester.pumpAndSettle();
    await tester.tap(tab('Chưa thu'));
    await tester.pumpAndSettle();

    final q = queries().last;
    expect(q['status'], 'completed');
    expect(q['payment'], 'unpaid');
    expect(q['page'], 1);
    // a tab is a filter, so "Xóa" shows up
    expect(find.text('Xóa'), findsOneWidget);
  });

  testWidgets('phone: order-code search, quick range and page buttons call GET /orders with the contract keys', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrdersScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('orders-q')), 'CF2610');
    await tester.tap(find.text('Lọc'));
    await tester.pumpAndSettle();
    expect(queries().last['q'], 'CF2610');

    await tester.tap(find.text('Hôm nay'));
    await tester.pumpAndSettle();
    var q = queries().last;
    final today = shopDayIso();
    expect(q['date_from'], today);
    expect(q['date_to'], today);
    expect(q['q'], 'CF2610');
    expect(find.text('Trong khoảng ngày đã chọn · 4 chờ xác nhận'), findsOneWidget);

    await tester.scrollUntilVisible(find.byKey(const ValueKey('page-2')), 300, scrollable: mainList());
    await tester.ensureVisible(find.byKey(const ValueKey('page-2')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('page-2')));
    await tester.pumpAndSettle();
    q = queries().last;
    expect(q['page'], 2);
    expect(q['date_from'], today);

    // "Xóa" drops every filter
    await tester.scrollUntilVisible(find.text('Xóa'), -300, scrollable: mainList());
    await tester.tap(find.text('Xóa'));
    await tester.pumpAndSettle();
    q = queries().last;
    expect(q['q'], '');
    expect(q['date_from'], isNull);
    expect(q['page'], 1);
  });

  testWidgets('tablet: four summary cards, web table and source filter', (tester) async {
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const OrdersScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('CẦN THU TIỀN'), findsOneWidget);
    expect(find.text('165.000đ'), findsOneWidget);
    expect(find.text('2 đơn đã giao · Xem danh sách →'), findsOneWidget);
    expect(find.text('ĐANG PHỤC VỤ'), findsOneWidget);
    expect(find.text('210.000đ'), findsOneWidget);
    // table header
    for (final h in ['MÃ ĐƠN', 'KÊNH', 'BÀN / KHÁCH', 'MÓN', 'TỔNG TIỀN', 'TRẠNG THÁI']) {
      expect(find.text(h), findsOneWidget);
    }
    expect(find.text('CF261014-00011'), findsOneWidget);
    expect(find.text('Xem'), findsNWidgets(5));

    // the "Đang phục vụ" summary card is a link to the open tab
    await tester.tap(find.text('3 đơn đang mở · Xem danh sách →'));
    await tester.pumpAndSettle();
    expect(queries().last['status'], 'open');

    await tester.tap(find.text('Mọi kênh'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Zalo').last);
    await tester.pumpAndSettle();
    final q = queries().last;
    expect(q['source'], 'zalo');
    expect(q['status'], 'open');
  });

  testWidgets('empty result: web empty state', (tester) async {
    when(() => api.get('/orders', query: any(named: 'query')))
        .thenAnswer((_) async => ordersResponse(orders: [], total: 0, pages: 1));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrdersScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('Không có đơn nào'), 300, scrollable: mainList());
    expect(find.text('Không có đơn phù hợp.'), findsOneWidget);
    expect(find.text('Đơn từ POS và Zalo sẽ hiện ở đây.'), findsOneWidget);
  });

  testWidgets('tapping an order opens /orders/<id>', (tester) async {
    await setSurface(tester, tablet);
    final router = GoRouter(routes: [
      GoRoute(path: '/', builder: (_, _) => const OrdersScreen()),
      GoRoute(path: '/orders/:id', builder: (_, s) => stubPage(s)),
    ]);
    addTearDown(router.dispose);
    await tester.pumpWidget(await routerTestApp(router, api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('CF261014-00012'));
    await tester.pumpAndSettle();
    expect(find.text('stub /orders/12'), findsOneWidget);
  });
}
