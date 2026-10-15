import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/customers/customers_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'customer_fixtures.dart';

Finder _mainScroll() => find.descendant(of: find.byType(RefreshIndicator), matching: find.byType(Scrollable)).first;

void main() {
  late MockApi api;
  late List<Map<String, dynamic>?> queries;

  setUp(() {
    api = MockApi();
    queries = [];
    when(() => api.get('/admin/customers', query: any(named: 'query'))).thenAnswer((inv) async {
      final q = inv.namedArguments[#query] as Map<String, dynamic>?;
      queries.add(q);
      final page = int.tryParse('${q?['page'] ?? 1}') ?? 1;
      return customersPage(page: page);
    });
  });

  testWidgets('phone: stats, filter, result line and customer cards', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomersScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Khách hàng'), findsOneWidget);
    expect(find.text('60'), findsOneWidget);
    expect(find.text('Khách đang nợ →'), findsOneWidget);
    expect(find.text('1.250.000đ', skipOffstage: false), findsOneWidget); // third card of the swipe strip
    expect(find.text('Tên, số điện thoại hoặc Zalo ID'), findsOneWidget);
    expect(find.text('Mọi khách'), findsOneWidget);
    expect(find.text('Mọi kênh'), findsOneWidget);
    expect(find.text('Hiển thị 1–25 / 60 khách hàng'), findsOneWidget);
    expect(find.text('Nguyễn Văn An'), findsOneWidget);
    expect(find.text('Văn phòng tầng 3'), findsOneWidget);
    expect(find.text('0901234567'), findsOneWidget);
    expect(find.text('Zalo'), findsOneWidget);
    expect(find.text('150.000đ'), findsOneWidget);
    expect(find.text('14/10/2026 09:30'), findsWidgets);
    expect(find.text('Thêm khách hàng'), findsOneWidget); // FAB
    expect(find.byTooltip('Đối chiếu công nợ'), findsOneWidget);
    expect(tester.takeException(), isNull);

    // Initial request: no filters, page 1.
    expect(queries.single, {'q': null, 'debt': null, 'zalo': null, 'page': null});
  });

  testWidgets('phone: "Còn nợ" select and search re-query with debt=1 and q', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomersScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Mọi khách'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Còn nợ').last);
    await tester.pumpAndSettle();
    expect(queries.last, {'q': null, 'debt': '1', 'zalo': null, 'page': null});
    expect(find.text('Xóa'), findsOneWidget); // a filter is set

    await tester.enterText(find.byType(TextField).first, '0901');
    await tester.tap(find.text('Lọc'));
    await tester.pumpAndSettle();
    expect(queries.last, {'q': '0901', 'debt': '1', 'zalo': null, 'page': null});

    await tester.tap(find.text('Xóa'));
    await tester.pumpAndSettle();
    expect(queries.last, {'q': null, 'debt': null, 'zalo': null, 'page': null});
  });

  testWidgets('phone: "Còn công nợ" card links to ?debt=1; pagination asks for page 2', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomersScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Khách đang nợ →'));
    await tester.pumpAndSettle();
    expect(queries.last?['debt'], '1');

    await tester.scrollUntilVisible(find.text('Sau →'), 300, scrollable: _mainScroll());
    await tester.drag(_mainScroll(), const Offset(0, -400)); // past the FAB
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sau →'));
    await tester.pumpAndSettle();
    expect(queries.last, {'q': null, 'debt': '1', 'zalo': null, 'page': '2'});
    expect(find.text('Hiển thị 26–50 / 60 khách hàng'), findsOneWidget); // back at the top
    await tester.scrollUntilVisible(find.text('← Trước'), 300, scrollable: _mainScroll());
    expect(find.text('← Trước'), findsOneWidget);
  });

  testWidgets('phone: tapping a customer opens the detail screen', (tester) async {
    when(() => api.get('/admin/customers/7')).thenAnswer((_) async => customerDetail());
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomersScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Nguyễn Văn An'));
    await tester.pumpAndSettle();
    expect(find.text('SỐ DƯ CÔNG NỢ'), findsOneWidget);
    verify(() => api.get('/admin/customers/7')).called(1);
  });

  testWidgets('phone: empty result shows the web empty state', (tester) async {
    when(() => api.get('/admin/customers', query: any(named: 'query')))
        .thenAnswer((_) async => customersPage(customers: [], total: 0, pages: 1));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomersScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Không tìm thấy khách hàng nào.'), findsOneWidget);
    expect(find.text('Không có khách hàng nào'), findsOneWidget);
    expect(find.text('Thêm khách hàng đầu tiên bằng nút bên trên.'), findsOneWidget);
  });

  testWidgets('phone: API error shows the Vietnamese message with Thử lại, filter stays usable', (tester) async {
    var fail = true;
    when(() => api.get('/admin/customers', query: any(named: 'query'))).thenAnswer((_) async {
      if (fail) throw ApiException(code: 'OFFLINE', message: 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
      return customersPage();
    });
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomersScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.'), findsOneWidget);
    expect(find.text('Lọc'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Thử lại'));
    await tester.pumpAndSettle();
    expect(find.text('Nguyễn Văn An'), findsOneWidget);
  });

  testWidgets('tablet: table with headers, header buttons, reconciliation pushed from the app bar', (tester) async {
    when(() => api.get('/admin/customers/reconciliation', query: any(named: 'query'))).thenAnswer((_) async => reconciliationJson());
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const CustomersScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('TÊN KHÁCH HÀNG'), findsOneWidget);
    expect(find.text('LIÊN HỆ / ZALO'), findsOneWidget);
    expect(find.text('SỐ DƯ NỢ'), findsOneWidget);
    expect(find.text('Lê Minh Châu'), findsOneWidget);
    expect(find.text('−20.000đ'), findsOneWidget);
    expect(find.text('—'), findsOneWidget); // Trần Thị Bình has neither phone nor Zalo
    expect(find.text('Xem'), findsNWidgets(3));
    expect(find.text('Thêm khách hàng'), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsNothing);
    expect(tester.takeException(), isNull);

    await tester.tap(find.text('Đối chiếu công nợ'));
    await tester.pumpAndSettle();
    expect(find.text('Tổng cộng (2 khách)'), findsOneWidget);
  });

  testWidgets('phone: "Ghi nợ" on a card adds debt only (no direction choice), one POST, the list reloads', (tester) async {
    await setSurface(tester, phone);
    when(() => api.post('/admin/customers/7/adjust', any(), any())).thenAnswer((_) async => {
          'balance': 270000,
          'amount': 120000,
          'note': 'lấy hàng chưa trả',
          'notify': {'customer': 'sent', 'owner': 'not_configured'},
        });
    await tester.pumpWidget(await testApp(const CustomersScreen(), api: api));
    await tester.pumpAndSettle();
    final before = queries.length;

    await tester.ensureVisible(find.byKey(const ValueKey('add-debt-7')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('add-debt-7')));
    await tester.pumpAndSettle();
    expect(find.text('Ghi nợ cho khách'), findsOneWidget);
    expect(find.text('Nguyễn Văn An · Số dư 150.000đ'), findsOneWidget);
    expect(find.text('Loại'), findsNothing, reason: 'increase only');
    expect(find.text('Tăng nợ (+)'), findsNothing);

    await tester.tap(find.widgetWithText(OutlinedButton, 'Ghi nợ'));
    await tester.pumpAndSettle();
    expect(find.text('Số tiền điều chỉnh phải khác 0.'), findsOneWidget);
    expect(find.text('Ghi rõ lý do điều chỉnh.'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('adjust-amount')), '120000');
    await tester.enterText(find.byKey(const ValueKey('adjust-note')), 'lấy hàng chưa trả');
    await tester.tap(find.widgetWithText(OutlinedButton, 'Ghi nợ'));
    await tester.pumpAndSettle();
    expect(find.text('Ghi nợ 120.000đ cho Nguyễn Văn An?'), findsOneWidget);
    await tester.tap(find.text('Đồng ý'));
    await tester.pumpAndSettle();

    final body = verify(() => api.post('/admin/customers/7/adjust', captureAny(), any())).captured.single;
    expect(body, {'amount': 120000, 'direction': 'increase', 'note': 'lấy hàng chưa trả'});
    expect(find.textContaining('Đã điều chỉnh công nợ. Số dư mới 270.000đ. Đã gửi Zalo cho khách.'), findsOneWidget);
    expect(queries.length, greaterThan(before), reason: 'the list was reloaded');
  });

  testWidgets('tablet: every row has a "Ghi nợ" button', (tester) async {
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const CustomersScreen(), api: api));
    await tester.pumpAndSettle();
    for (final id in [7, 8, 9]) {
      expect(find.byKey(ValueKey('add-debt-$id')), findsOneWidget);
    }
    expect(find.byTooltip('Ghi nợ'), findsNWidgets(3));
    expect(tester.takeException(), isNull);
  });
}
