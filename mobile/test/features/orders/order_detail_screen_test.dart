import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/orders/order_detail_screen.dart';
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
    when(() => api.get('/orders/42', query: any(named: 'query'))).thenAnswer((_) async => openOrderResponse());
    when(() => api.get('/orders/77', query: any(named: 'query'))).thenAnswer((_) async => zaloUnpaidResponse());
    when(() => api.get('/orders/9', query: any(named: 'query'))).thenAnswer((_) async => paidOrderResponse());
  });

  Finder mainList() => find.descendant(of: find.byKey(const Key('order-detail-list')), matching: find.byType(Scrollable)).first;

  Future<void> scrollTo(WidgetTester tester, Finder f) => tester.scrollUntilVisible(f, 250, scrollable: mainList());

  testWidgets('phone: open POS order renders header, KPIs, items, info, pay and other actions', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrderDetailScreen(id: 42), api: api));
    await tester.pumpAndSettle();

    verify(() => api.get('/orders/42', query: {'include': 'payments'})).called(1);
    expect(find.text('CF261014-00042'), findsOneWidget);
    expect(find.text('Đang phục vụ'), findsWidgets);
    expect(find.text('POS'), findsWidgets);
    expect(find.text('Mở trên POS'), findsOneWidget);
    expect(find.text('In hóa đơn'), findsOneWidget);
    expect(find.text('Tạo lúc 14/10/2026 09:30'), findsOneWidget);
    expect(find.text('Bàn 3'), findsWidgets);
    // KPIs
    expect(find.text('TỔNG CỘNG'), findsOneWidget);
    expect(find.text('79.000đ'), findsWidgets);
    expect(find.text('GIẢM GIÁ'), findsOneWidget);
    expect(find.text('—'), findsOneWidget);
    expect(find.text('THANH TOÁN'), findsOneWidget);
    expect(find.text('Chưa thu'), findsWidgets);
    // items (phone cards) with the note
    await scrollTo(tester, find.text('MÓN ĐÃ GỌI (2)'));
    await scrollTo(tester, find.text('📝 Ít đá, ít ngọt'));
    expect(find.text('Cà phê sữa đá'), findsOneWidget);
    expect(find.text('50.000đ'), findsOneWidget);
    await scrollTo(tester, find.text('Tạm tính'));
    expect(find.text('Tổng cộng'), findsOneWidget);
    expect(find.text('Giá vốn (COGS)'), findsNothing); // only for completed orders
    // info card
    await scrollTo(tester, find.text('Khách quen, mang ra sân'));
    expect(find.text('THÔNG TIN'), findsOneWidget);
    // pay card and other actions
    await scrollTo(tester, find.text('Thu tiền sẽ hoàn tất đơn: trừ kho theo định mức và chốt giá vốn.'));
    expect(find.text('Thu tiền & hoàn tất đơn'), findsOneWidget);
    await scrollTo(tester, find.text('Hủy đơn'));
    expect(find.text('THAO TÁC KHÁC'), findsOneWidget);
    expect(find.text('Gửi lại bill qua Zalo'), findsNothing);
  });

  testWidgets('pay sheet: transfer with a discount and a reference posts the contract body', (tester) async {
    when(() => api.post('/orders/42/pay', any())).thenAnswer((_) async => {
          'order': {...openOrderResponse()['order'] as Map<String, dynamic>, 'status': 'completed', 'payment_status': 'paid'},
          'change': 0,
        });
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrderDetailScreen(id: 42), api: api));
    await tester.pumpAndSettle();

    await scrollTo(tester, find.byKey(const Key('open-pay')));
    await tester.tap(find.byKey(const Key('open-pay')));
    await tester.pumpAndSettle();

    expect(find.text('Thu tiền và hoàn tất đơn CF261014-00042? Số tiền = tạm tính − giảm giá đã nhập.'), findsOneWidget);
    expect(find.text('Hình thức thanh toán'), findsOneWidget);
    expect(find.text('Khác'), findsOneWidget); // admins get all four methods
    await tester.tap(find.byKey(const Key('pay-method-transfer')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Khách đưa'), findsNothing); // cash box only for cash

    await tester.enterText(find.byKey(const Key('pay-discount')), '4000');
    await tester.pump();
    expect(tester.widget<Text>(find.byKey(const Key('pay-due'))).data, '75.000đ');

    // a discount above the subtotal is refused before calling the API
    await tester.enterText(find.byKey(const Key('pay-discount')), '90000');
    await tester.pump();
    expect(find.text('Giảm giá không được lớn hơn tạm tính của đơn.'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('pay-discount')), '4000');
    await tester.enterText(find.byKey(const Key('pay-reference')), 'FT26101400123');
    await tester.pump();

    await tester.ensureVisible(find.byKey(const Key('pay-submit')));
    await tester.tap(find.byKey(const Key('pay-submit')));
    await tester.pumpAndSettle();

    final body = verify(() => api.post('/orders/42/pay', captureAny())).captured.single as Map<String, dynamic>;
    expect(body, {'method': 'transfer', 'discount': 4000, 'reference': 'FT26101400123'});
    expect(find.text('Đã ghi nhận thanh toán đơn CF261014-00042.'), findsOneWidget);
    // detail re-read after the write
    verify(() => api.get('/orders/42', query: {'include': 'payments'})).called(2);
  });

  testWidgets('pay sheet: cash with the amount tendered shows the change and sends tendered', (tester) async {
    when(() => api.post('/orders/42/pay', any())).thenAnswer((_) async => {
          'order': {...openOrderResponse()['order'] as Map<String, dynamic>, 'status': 'completed', 'payment_status': 'paid'},
          'change': 21000,
        });
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrderDetailScreen(id: 42), api: api));
    await tester.pumpAndSettle();

    await scrollTo(tester, find.byKey(const Key('open-pay')));
    await tester.tap(find.byKey(const Key('open-pay')));
    await tester.pumpAndSettle();

    expect(find.textContaining('Khách đưa'), findsOneWidget);
    expect(find.text('Đủ tiền'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('pay-tendered')), '50000');
    await tester.pump();
    expect(find.text('Còn thiếu'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('pay-submit'))).onPressed, isNull);

    await tester.tap(find.text('100.000đ'));
    await tester.pump();
    expect(find.text('Tiền thối'), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('pay-change'))).data, '21.000đ');

    await tester.ensureVisible(find.byKey(const Key('pay-submit')));
    await tester.tap(find.byKey(const Key('pay-submit')));
    await tester.pumpAndSettle();

    final body = verify(() => api.post('/orders/42/pay', captureAny())).captured.single as Map<String, dynamic>;
    expect(body, {'method': 'cash', 'discount': 0, 'tendered': 100000});
    expect(find.text('Đã ghi nhận thanh toán đơn CF261014-00042. Thối 21.000đ.'), findsOneWidget);
  });

  testWidgets('pay sheet: a server refusal stays in the sheet in Vietnamese', (tester) async {
    final details = {
      'short': [
        {'inventory_item_id': 3, 'name': 'Sữa đặc', 'needed': 60, 'available': 20, 'unit': 'ml'},
      ],
      'products': ['Cà phê sữa đá'],
    };
    // ApiClient turns the 409 body into an ApiException with the Vietnamese text.
    when(() => api.post('/orders/42/pay', any())).thenThrow(ApiException(
        code: 'INSUFFICIENT_STOCK',
        status: 409,
        details: details,
        serverMessage: 'Insufficient stock: Sữa đặc',
        message: vietnameseFor('INSUFFICIENT_STOCK', 'Insufficient stock: Sữa đặc', details)));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrderDetailScreen(id: 42), api: api));
    await tester.pumpAndSettle();

    await scrollTo(tester, find.byKey(const Key('open-pay')));
    await tester.tap(find.byKey(const Key('open-pay')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('pay-submit')));
    await tester.tap(find.byKey(const Key('pay-submit')));
    await tester.pumpAndSettle();

    expect(find.text('Không đủ tồn kho: Sữa đặc (cần 60, còn 20 ml)'), findsOneWidget);
    expect(find.byKey(const Key('pay-submit')), findsOneWidget); // sheet still open
  });

  testWidgets('cancel: confirm sheet then POST /orders/:id/cancel', (tester) async {
    when(() => api.post('/orders/42/cancel', any())).thenAnswer(
        (_) async => {'order': {...openOrderResponse()['order'] as Map<String, dynamic>, 'status': 'cancelled'}});
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrderDetailScreen(id: 42), api: api));
    await tester.pumpAndSettle();

    await scrollTo(tester, find.text('Hủy đơn'));
    await tester.ensureVisible(find.text('Hủy đơn'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Hủy đơn'));
    await tester.pumpAndSettle();
    expect(find.text('Hủy đơn CF261014-00042? Đơn chưa trừ kho nên không ảnh hưởng tồn kho.'), findsOneWidget);

    await tester.tap(find.byKey(const Key('confirm-yes')));
    await tester.pumpAndSettle();

    verify(() => api.post('/orders/42/cancel', any())).called(1);
    expect(find.text('Đã hủy đơn CF261014-00042.'), findsOneWidget);
  });

  testWidgets('tablet: delivered Zalo order, two columns, margin, receipt error and resend failure', (tester) async {
    when(() => api.post('/orders/77/resend-receipt', any())).thenAnswer((_) async => {'sent': false, 'error': 'Zalo API timeout'});
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const OrderDetailScreen(id: 77), api: api));
    await tester.pumpAndSettle();

    expect(find.text('CF261013-00077'), findsOneWidget);
    expect(find.text('Chờ thu tiền'), findsWidgets);
    expect(find.text('Zalo'), findsWidgets);
    expect(find.text('Mở trên POS'), findsNothing);
    expect(find.text('Chị Lan'), findsWidgets);
    expect(find.text('hoàn tất 13/10/2026 10:10'), findsOneWidget);
    // completed: "Lãi gộp" KPI with the margin (70%: green)
    expect(find.text('LÃI GỘP'), findsOneWidget);
    expect(find.text('84.000đ'), findsOneWidget);
    expect(find.text('70,0%'), findsOneWidget);
    // items table + totals with COGS
    expect(find.text('THÀNH TIỀN'), findsOneWidget);
    expect(find.text('📝 Size L, 50% đường'), findsOneWidget);
    expect(find.text('Giá vốn (COGS)'), findsOneWidget);
    expect(find.text('84.000đ (70,0%)'), findsOneWidget);
    // info: Zalo rows
    expect(find.text('Nhóm chat'), findsOneWidget);
    expect(find.text('Gửi lỗi'), findsOneWidget);
    expect(find.text('Zalo API timeout'), findsOneWidget);
    // pay card for a delivered order
    expect(find.text('Đơn Zalo đã trừ kho; chỉ ghi nhận tiền đã thu.'), findsOneWidget);
    expect(find.text('Thu 120.000đ'), findsOneWidget);
    expect(find.text('Hủy đơn'), findsNothing);

    // the two columns sit side by side
    final items = tester.getTopLeft(find.text('MÓN ĐÃ GỌI (1)'));
    final info = tester.getTopLeft(find.text('THÔNG TIN'));
    expect(info.dx, greaterThan(items.dx + 300));

    await tester.ensureVisible(find.text('Gửi lại bill qua Zalo'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Gửi lại bill qua Zalo'));
    await tester.pumpAndSettle();
    verify(() => api.post('/orders/77/resend-receipt', any())).called(1);
    expect(find.text('Gửi bill thất bại: Zalo API timeout'), findsOneWidget);
  });

  testWidgets('tablet: paid order lists its payments and has no pay card', (tester) async {
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const OrderDetailScreen(id: 9), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Hoàn tất'), findsWidgets);
    expect(find.text('−4.000đ'), findsWidgets);
    expect(find.text('LỊCH SỬ THU TIỀN'), findsOneWidget);
    expect(find.text('Tiền mặt'), findsWidgets);
    expect(find.text('14/10/2026 10:00 · Thu Ngân'), findsOneWidget);
    expect(find.text('Thu lúc'), findsOneWidget);
    expect(find.byKey(const Key('pay-card')), findsNothing);
    expect(find.text('THAO TÁC KHÁC'), findsNothing);
  });

  testWidgets('cashier: no debt settlement, no cancel, no cost data', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrderDetailScreen(id: 77), api: api, user: cashierUser));
    await tester.pumpAndSettle();

    expect(find.text('LÃI GỘP'), findsNothing);
    expect(find.text('THANH TOÁN'), findsOneWidget);
    await scrollTo(tester, find.text('Gửi lại bill qua Zalo'));
    expect(find.byKey(const Key('pay-card')), findsNothing);
    expect(find.text('Hủy đơn'), findsNothing);
    expect(find.text('Giá vốn (COGS)'), findsNothing);
  });

  testWidgets('cashier: open order pays with the POS methods only', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const OrderDetailScreen(id: 42), api: api, user: cashierUser));
    await tester.pumpAndSettle();

    await scrollTo(tester, find.byKey(const Key('open-pay')));
    expect(find.text('Hủy đơn'), findsNothing);
    await tester.tap(find.byKey(const Key('open-pay')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('pay-method-cash')), findsOneWidget);
    expect(find.byKey(const Key('pay-method-other')), findsNothing);
  });

  testWidgets('"Mở trên POS" opens /pos?order=<id> and the customer opens /customers/<id>', (tester) async {
    await setSurface(tester, tablet);
    final router = GoRouter(initialLocation: '/orders/42', routes: [
      GoRoute(path: '/orders/:id', builder: (_, s) => OrderDetailScreen(id: int.parse(s.pathParameters['id']!))),
      GoRoute(path: '/pos', builder: (_, s) => stubPage(s)),
      GoRoute(path: '/customers/:id', builder: (_, s) => stubPage(s)),
    ]);
    addTearDown(router.dispose);
    await tester.pumpWidget(await routerTestApp(router, api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('open-pos')));
    await tester.pumpAndSettle();
    expect(find.text('stub /pos?order=42'), findsOneWidget);

    router.go('/orders/77');
    await tester.pumpAndSettle();
    await tester.tap(find.text('Chị Lan').first);
    await tester.pumpAndSettle();
    expect(find.text('stub /customers/5'), findsOneWidget);
  });
}
