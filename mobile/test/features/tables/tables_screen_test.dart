import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/menu/form_sheet.dart';
import 'package:cocoffee_mobile/features/tables/tables_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';

class MockGoRouter extends Mock implements GoRouter {}

Map<String, dynamic> tablesRes() => {
      'tables': [
        {
          'id': 1, 'code': 'B01', 'name': 'Bàn 1', 'capacity': 4, 'status': 'available', 'current_order_id': null, 'is_active': 1,
          'current_order_code': null, 'current_order_total': null,
        },
        {
          'id': 2, 'code': 'B02', 'name': 'Bàn 2', 'capacity': 2, 'status': 'serving', 'current_order_id': 42, 'is_active': 1,
          'current_order_code': 'CF261014-00042', 'current_order_total': 85000,
        },
        {
          'id': 3, 'code': 'SAN', 'name': 'Sân vườn', 'capacity': 8, 'status': 'available', 'current_order_id': null, 'is_active': 0,
          'current_order_code': null, 'current_order_total': null,
        },
      ],
    };

Finder field(String label) =>
    find.descendant(of: find.widgetWithText(LabeledField, label), matching: find.byType(TextFormField));

Future<void> tapVisible(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
}

void main() {
  late MockApi api;

  setUp(() {
    api = MockApi();
    when(() => api.get('/tables', query: any(named: 'query'))).thenAnswer((_) async => tablesRes());
    when(() => api.post(any(), any())).thenAnswer((_) async => {'table': <String, dynamic>{}});
    when(() => api.put(any(), any())).thenAnswer((_) async => {'table': <String, dynamic>{}});
  });

  testWidgets('admin phone: counts, status badges, current order and actions like tables.ejs', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const TablesScreen(), api: api));
    await tester.pumpAndSettle();

    expect(verify(() => api.get('/tables', query: captureAny(named: 'query'))).captured.single, {'all': 1});
    expect(find.text('2 bàn đang dùng · 1 bàn có khách. Trạng thái bàn do máy POS cập nhật khi mở và thanh toán đơn.'), findsOneWidget);
    expect(find.text('+ Thêm bàn'), findsOneWidget);
    expect(find.text('Trống'), findsOneWidget);
    expect(find.text('Có khách'), findsOneWidget);
    expect(find.text('Ngừng sử dụng'), findsOneWidget);
    expect(find.text('CF261014-00042'), findsOneWidget);
    expect(find.text('85.000đ'), findsOneWidget);
    expect(find.text('4 chỗ'), findsOneWidget);
    expect(find.text('Sửa'), findsNWidgets(3));
    expect(find.text('Ngừng dùng'), findsOneWidget); // the serving table has no toggle
    expect(find.text('Dùng lại'), findsOneWidget);
  });

  testWidgets('tablet: table layout with the web columns', (tester) async {
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const TablesScreen(), api: api));
    await tester.pumpAndSettle();

    for (final h in ['BÀN', 'SỨC CHỨA', 'TRẠNG THÁI', 'ĐƠN HIỆN TẠI']) {
      expect(find.text(h), findsOneWidget, reason: h);
    }
    expect(find.text('Sân vườn'), findsOneWidget);
  });

  testWidgets('mid width (720 dp): two card columns, add button beside the description', (tester) async {
    await setSurface(tester, const Size(720, 1024));
    await tester.pumpWidget(await testApp(const TablesScreen(), api: api));
    await tester.pumpAndSettle();

    expect(tester.getTopLeft(find.text('Bàn 1')).dy, tester.getTopLeft(find.text('Bàn 2')).dy);
    expect(find.text('+ Thêm bàn'), findsOneWidget);
  });

  testWidgets('+ Thêm bàn posts code, name, capacity', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const TablesScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('+ Thêm bàn'));
    expect(find.text('Thêm bàn'), findsOneWidget);
    await tester.enterText(field('Mã bàn'), 'B03');
    await tester.enterText(field('Tên bàn'), 'Bàn 3');
    await tester.enterText(field('Sức chứa'), '6');
    await tapVisible(tester, find.text('Lưu'));

    expect(verify(() => api.post('/tables', captureAny())).captured.single, {'code': 'B03', 'name': 'Bàn 3', 'capacity': 6});
    expect(find.text('Đã thêm bàn B03.'), findsOneWidget);
  });

  testWidgets('Sửa bàn puts the edited fields', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const TablesScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.byTooltip('Sửa Bàn 1'));
    expect(find.text('Sửa bàn'), findsOneWidget);
    await tester.enterText(field('Sức chứa'), '0');
    await tapVisible(tester, find.text('Lưu'));
    expect(find.text('Sức chứa từ 1 đến 100'), findsOneWidget);

    await tester.enterText(field('Sức chứa'), '5');
    await tapVisible(tester, find.text('Lưu'));
    expect(verify(() => api.put('/tables/1', captureAny())).captured.single, {'code': 'B01', 'name': 'Bàn 1', 'capacity': 5});
    expect(find.text('Đã cập nhật bàn.'), findsOneWidget);
  });

  testWidgets('Ngừng dùng asks first, then PUT is_active false; a busy table shows the web message', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const TablesScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('Ngừng dùng'));
    expect(find.text('Ngừng sử dụng Bàn 1? Bàn sẽ ẩn khỏi sơ đồ POS.'), findsOneWidget);
    await tapVisible(tester, find.text('Đồng ý'));
    expect(verify(() => api.put('/tables/1', captureAny())).captured.single, {'is_active': false});
    expect(find.text('Đã cập nhật bàn.'), findsOneWidget);

    when(() => api.put(any(), any())).thenThrow(ApiException(code: 'CONFLICT', status: 409, message: 'Table is serving'));
    await tapVisible(tester, find.text('Ngừng dùng'));
    await tapVisible(tester, find.text('Đồng ý'));
    expect(find.text('Bàn đang có đơn, hãy thanh toán hoặc hủy đơn trước khi ngừng sử dụng.'), findsOneWidget);
  });

  testWidgets('Dùng lại reactivates without a confirm', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const TablesScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('Dùng lại'));
    expect(find.text('Xác nhận'), findsNothing);
    expect(verify(() => api.put('/tables/3', captureAny())).captured.single, {'is_active': true});
  });

  testWidgets('tapping a table opens the POS, tapping the order opens the order', (tester) async {
    final router = MockGoRouter();
    when(() => router.push<Object?>(any(), extra: any(named: 'extra'))).thenAnswer((_) async => null);
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(InheritedGoRouter(goRouter: router, child: const TablesScreen()), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('Bàn 2'));
    verify(() => router.push<Object?>('/pos?table=2', extra: any(named: 'extra'))).called(1);

    await tapVisible(tester, find.text('CF261014-00042'));
    verify(() => router.push<Object?>('/orders/42', extra: any(named: 'extra'))).called(1);

    await tapVisible(tester, find.text('Sân vườn')); // inactive: hidden from the POS
    verifyNever(() => router.push<Object?>('/pos?table=3', extra: any(named: 'extra')));
  });

  testWidgets('cashier: active tables only, no admin actions', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const TablesScreen(), api: api, user: cashierUser));
    await tester.pumpAndSettle();

    expect(verify(() => api.get('/tables', query: captureAny(named: 'query'))).captured.single, isNull);
    expect(find.text('+ Thêm bàn'), findsNothing);
    expect(find.text('Sửa'), findsNothing);
    expect(find.text('Bàn 2'), findsOneWidget);
  });
}
