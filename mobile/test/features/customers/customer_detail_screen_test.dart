import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/customers/customer_detail_screen.dart';
import 'package:cocoffee_mobile/features/customers/customer_models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'customer_fixtures.dart';

void main() {
  late MockApi api;
  late int detailCalls;
  late bool paidOff;

  setUp(() {
    api = MockApi();
    detailCalls = 0;
    paidOff = false;
    when(() => api.get('/admin/customers/7')).thenAnswer((_) async {
      detailCalls++;
      return paidOff ? customerDetail(balance: 0, settled: true) : customerDetail();
    });
  });

  testWidgets('phone: header, balance hero, ledger with running balance, orders', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomerDetailScreen(id: 7), api: api));
    await tester.pumpAndSettle();

    // Header
    expect(find.text('Nguyễn Văn An'), findsNWidgets(2)); // app bar + H1
    expect(find.text('VA'), findsOneWidget);
    expect(find.text('0901234567'), findsOneWidget);
    expect(find.text('Khách từ 01/09/2026 09:00'), findsOneWidget);
    expect(find.text('Văn phòng tầng 3'), findsOneWidget);
    expect(find.byTooltip('Biên bản đối chiếu'), findsOneWidget);
    expect(find.byTooltip('Sửa'), findsOneWidget);

    // Hero
    expect(find.text('SỐ DƯ CÔNG NỢ'), findsOneWidget);
    expect(find.text('150.000đ'), findsOneWidget);
    expect(find.text('1 đơn chưa thu · 120.000đ'), findsOneWidget);
    expect(find.text('Tổng phát sinh'), findsOneWidget);
    expect(find.text('Đã thu'), findsOneWidget);
    expect(find.text('50.000đ'), findsOneWidget);
    expect(find.byIcon(Icons.payments_outlined), findsOneWidget); // 'Thu nợ' only when the customer owes
    expect(find.text('Điều chỉnh công nợ thủ công'), findsOneWidget);

    // Ledger: newest first, running balance after each row
    await tester.scrollUntilVisible(find.text('Dư 80.000đ'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Sổ công nợ'), findsOneWidget);
    expect(find.text('3 dòng'), findsOneWidget);
    expect(find.text('−50.000đ'), findsOneWidget);
    expect(find.text('Dư 150.000đ'), findsOneWidget);
    expect(find.text('+120.000đ'), findsOneWidget);
    expect(find.text('Dư 200.000đ'), findsOneWidget);
    expect(find.text('+80.000đ'), findsOneWidget);
    expect(find.text('Phát sinh nợ'), findsOneWidget);
    expect(find.text('Điều chỉnh'), findsOneWidget);
    expect(find.text('Tiền mặt'), findsOneWidget);
    expect(find.text('01/10/2026 08:00 · boss · nợ cũ ghi sổ tay'), findsOneWidget);
    expect(find.textContaining('Nợ đơn '), findsNothing); // auto notes are hidden

    // Orders
    await tester.scrollUntilVisible(find.text('CF261010-00040'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Đơn hàng của khách'), findsOneWidget);
    expect(find.text('2 đơn'), findsOneWidget);
    expect(find.text('Chờ thu tiền'), findsOneWidget);
    expect(find.text('Hoàn tất'), findsOneWidget);
    expect(find.text('POS'), findsOneWidget);
    expect(find.text('45.000đ'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('phone: Thu nợ sheet — "Thu hết", method, note, confirm -> POST collect, settled orders shown', (tester) async {
    when(() => api.post('/admin/customers/7/collect', any())).thenAnswer((_) async {
      paidOff = true;
      return {'amount': 150000, 'balance': 0, 'settled': ['CF261012-00042']};
    });
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomerDetailScreen(id: 7), api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.payments_outlined));
    await tester.pumpAndSettle();
    expect(find.text('Số tiền thu (đ)'), findsOneWidget);
    expect(find.text('Nguyễn Văn An · Số dư 150.000đ'), findsOneWidget);

    final amount = find.byKey(const ValueKey('collect-amount'));
    expect(tester.widget<EditableText>(find.descendant(of: amount, matching: find.byType(EditableText))).controller.text, '150000');
    await tester.enterText(amount, '200000');
    await tester.tap(find.text('Ghi nhận thu nợ'));
    await tester.pumpAndSettle();
    expect(find.text('Số tiền thu lớn hơn số nợ hiện tại (150.000đ).'), findsOneWidget);
    await tester.tap(find.text('Thu hết'));
    await tester.pump();
    expect(tester.widget<EditableText>(find.descendant(of: amount, matching: find.byType(EditableText))).controller.text, '150000');

    await tester.tap(find.text('Chuyển khoản'));
    await tester.enterText(find.byKey(const ValueKey('collect-note')), 'CK Vietcombank');
    await tester.tap(find.text('Ghi nhận thu nợ'));
    await tester.pumpAndSettle();
    expect(find.text('Ghi nhận thu nợ của Nguyễn Văn An?'), findsOneWidget);
    await tester.tap(find.text('Đồng ý'));
    await tester.pumpAndSettle();

    verify(() => api.post('/admin/customers/7/collect', {'amount': 150000, 'method': 'transfer', 'note': 'CK Vietcombank'})).called(1);
    expect(find.text('Đã thu 150.000đ. Còn nợ 0đ.'), findsOneWidget);
    expect(find.text('Đã tất toán 1 đơn:'), findsOneWidget);
    expect(detailCalls, 2); // detail reloaded after the write
    expect(find.text('Không còn nợ'), findsOneWidget);
    expect(find.byIcon(Icons.payments_outlined), findsNothing);
  });

  testWidgets('phone: collect error from the server stays inside the sheet', (tester) async {
    when(() => api.post('/admin/customers/7/collect', any()))
        .thenThrow(ApiException(code: 'NO_DEBT', status: 409, message: 'Khách hàng này không còn nợ.'));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomerDetailScreen(id: 7), api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.payments_outlined));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Ghi nhận thu nợ'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Đồng ý'));
    await tester.pumpAndSettle();
    expect(find.text('Khách hàng này không còn nợ.'), findsOneWidget);
    expect(find.text('Số tiền thu (đ)'), findsOneWidget); // sheet still open
  });

  testWidgets('tablet: two columns; Điều chỉnh dialog validates, then POST adjust (decrease)', (tester) async {
    when(() => api.post('/admin/customers/7/adjust', any()))
        .thenAnswer((_) async => {'balance': 130000, 'amount': -20000, 'note': 'xóa nợ lẻ', 'notify': null});
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const CustomerDetailScreen(id: 7), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Biên bản đối chiếu'), findsOneWidget);
    expect(find.text('Sửa'), findsOneWidget);
    expect(find.text('Sổ công nợ'), findsOneWidget);
    expect(find.text('Đơn hàng của khách'), findsOneWidget);
    // Hero (left column) and ledger (right column) sit side by side.
    expect(tester.getTopLeft(find.text('Sổ công nợ')).dx, greaterThan(tester.getTopLeft(find.text('SỐ DƯ CÔNG NỢ')).dx + 300));
    expect(tester.takeException(), isNull);

    await tester.tap(find.byIcon(Icons.tune_rounded));
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsOneWidget);
    await tester.tap(find.text('Lưu điều chỉnh'));
    await tester.pumpAndSettle();
    expect(find.text('Số tiền điều chỉnh phải khác 0.'), findsOneWidget);
    expect(find.text('Ghi rõ lý do điều chỉnh.'), findsOneWidget);
    verifyNever(() => api.post('/admin/customers/7/adjust', any()));

    await tester.tap(find.text('Giảm nợ (−)'));
    await tester.enterText(find.byKey(const ValueKey('adjust-amount')), '20000');
    await tester.enterText(find.byKey(const ValueKey('adjust-note')), 'xóa nợ lẻ');
    await tester.tap(find.text('Lưu điều chỉnh'));
    await tester.pumpAndSettle();
    expect(find.text('Điều chỉnh công nợ của Nguyễn Văn An?'), findsOneWidget);
    await tester.tap(find.text('Đồng ý'));
    await tester.pumpAndSettle();

    verify(() => api.post('/admin/customers/7/adjust', {'amount': 20000, 'direction': 'decrease', 'note': 'xóa nợ lẻ'})).called(1);
    expect(find.text('Đã điều chỉnh công nợ. Số dư mới 130.000đ.'), findsOneWidget);
    expect(detailCalls, 2);
  });

  testWidgets('phone: Sửa opens the form; saving PUTs and reloads the customer', (tester) async {
    when(() => api.put('/admin/customers/7', any())).thenAnswer((_) async => {'customer': customerJson(note: 'Ghi sổ cuối tuần')});
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomerDetailScreen(id: 7), api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Sửa'));
    await tester.pumpAndSettle();
    expect(find.text('Sửa: Nguyễn Văn An'), findsNWidgets(2));
    await tester.enterText(find.byKey(const ValueKey('form-note')), 'Ghi sổ cuối tuần');
    await tester.tap(find.text('Lưu thay đổi'));
    await tester.pumpAndSettle();

    verify(() => api.put('/admin/customers/7', {
          'name': 'Nguyễn Văn An',
          'phone': '0901234567',
          'zalo_user_id': 'zl_123456',
          'note': 'Ghi sổ cuối tuần',
        })).called(1);
    expect(find.text('SỐ DƯ CÔNG NỢ'), findsOneWidget); // back on the detail
    expect(detailCalls, 2);
  });

  testWidgets('customer without debt: white hero, no Thu nợ, empty lists', (tester) async {
    when(() => api.get('/admin/customers/8')).thenAnswer((_) async => {
          'customer': customerJson(id: 8, name: 'Trần Thị Bình', phone: null, zalo: null, note: null, balance: 0, orders: 0),
          'ledger': [],
          'orders': [],
        });
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomerDetailScreen(id: 8), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Không còn nợ'), findsOneWidget);
    expect(find.byIcon(Icons.payments_outlined), findsNothing);
    expect(find.text('TB'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Chưa có đơn nào liên kết với khách này.'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Chưa có phát sinh công nợ.'), findsOneWidget);
  });

  test('adjust flash appends the Zalo notice like the web', () {
    expect(adjustMessage(250000, {'customer': 'not_linked', 'owner': 'sent'}),
        'Đã điều chỉnh công nợ. Số dư mới 250.000đ. Khách chưa liên kết Zalo nên chưa nhận được tin. Đã báo chủ quán qua Zalo.');
    expect(adjustMessage(0, null), 'Đã điều chỉnh công nợ. Số dư mới 0đ.');
  });

  test('running balance and hero totals follow the web formulas', () {
    final d = CustomerDetail.fromJson(customerDetail());
    expect(d.ledger.map((l) => l.after).toList(), [150000, 200000, 80000]);
    expect(d.debtTotal, 120000);
    expect(d.paidTotal, 50000);
    expect(d.unpaid.length, 1);
    expect(d.customer.initials, 'VA');
  });
}
