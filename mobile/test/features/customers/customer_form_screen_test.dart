import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/customers/customer_form_screen.dart';
import 'package:cocoffee_mobile/features/customers/customer_models.dart';
import 'package:cocoffee_mobile/features/customers/customers_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';
import 'customer_fixtures.dart';

/// Pushes the form the way the screens do (Navigator) and keeps what it pops with.
class _Host extends StatelessWidget {
  const _Host({this.customer, required this.onResult});
  final Customer? customer;
  final ValueChanged<Customer?> onResult;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: () async =>
              onResult(await Navigator.of(context).push<Customer>(MaterialPageRoute(builder: (_) => CustomerFormScreen(customer: customer)))),
          child: const Text('open'),
        ),
      ),
    );
  }
}

Finder _field(String key) => find.byKey(ValueKey(key));

void main() {
  late MockApi api;

  setUp(() => api = MockApi());

  testWidgets('phone: new customer — required name, POST /admin/customers, pops with the new customer', (tester) async {
    when(() => api.post('/admin/customers', any(), any())).thenAnswer((_) async => {
          'customer': customerJson(id: 15, name: 'Phạm Thu Hà', phone: '0912345678', zalo: null, note: null, balance: 0, orders: 0),
        });
    Customer? result;
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(_Host(onResult: (c) => result = c), api: api));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Thêm khách hàng'), findsNWidgets(3)); // app bar, H1, primary button
    expect(find.text('Tên khách hàng'), findsOneWidget);
    expect(find.text('Số điện thoại'), findsOneWidget);
    expect(find.text('Zalo ID'), findsOneWidget);
    expect(find.text('Xem ở trang Zalo bot › sự kiện gần đây, hoặc trong đơn Zalo của khách.'), findsOneWidget);
    expect(find.text('Hủy'), findsOneWidget);
    // Phone: primary on top of 'Hủy'.
    expect(tester.getTopLeft(find.widgetWithText(FilledButton, 'Thêm khách hàng')).dy, lessThan(tester.getTopLeft(find.text('Hủy')).dy));
    expect(tester.takeException(), isNull);

    await tester.tap(find.widgetWithText(FilledButton, 'Thêm khách hàng'));
    await tester.pumpAndSettle();
    expect(find.text('Nhập tên khách hàng'), findsOneWidget);
    verifyNever(() => api.post('/admin/customers', any()));

    await tester.enterText(_field('form-name'), '  Phạm Thu Hà ');
    await tester.enterText(_field('form-phone'), '0912345678');
    await tester.tap(find.widgetWithText(FilledButton, 'Thêm khách hàng'));
    await tester.pumpAndSettle();

    verify(() => api.post('/admin/customers', {'name': 'Phạm Thu Hà', 'phone': '0912345678'}, any())).called(1);
    expect(result?.id, 15);
    expect(find.text('Đã thêm khách hàng "Phạm Thu Hà".'), findsOneWidget);
  });

  testWidgets('tablet: edit — prefilled, cleared phone sent as null, PUT /admin/customers/7', (tester) async {
    when(() => api.put('/admin/customers/7', any(), any())).thenAnswer((_) async => {'customer': customerJson(phone: null, note: 'Ghi sổ cuối tuần')});
    Customer? result;
    final c = Customer.fromJson(customerJson());
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(_Host(customer: c, onResult: (r) => result = r), api: api));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('Sửa: Nguyễn Văn An'), findsNWidgets(2));
    expect(find.text('0901234567'), findsOneWidget);
    expect(find.text('zl_123456'), findsOneWidget);
    // Wide: phone and Zalo ID side by side.
    expect(tester.getTopLeft(_field('form-phone')).dy, tester.getTopLeft(_field('form-zalo')).dy);
    expect(tester.takeException(), isNull);

    await tester.enterText(_field('form-phone'), '');
    await tester.enterText(_field('form-note'), 'Ghi sổ cuối tuần');
    await tester.tap(find.text('Lưu thay đổi'));
    await tester.pumpAndSettle();

    verify(() => api.put('/admin/customers/7', {
          'name': 'Nguyễn Văn An',
          'phone': null,
          'zalo_user_id': 'zl_123456',
          'note': 'Ghi sổ cuối tuần',
        }, any())).called(1);
    expect(result?.note, 'Ghi sổ cuối tuần');
    expect(find.text('Đã cập nhật thông tin khách hàng.'), findsOneWidget);
  });

  testWidgets('duplicate Zalo ID shows the web message on the field', (tester) async {
    when(() => api.put('/admin/customers/7', any(), any())).thenThrow(ApiException(
        code: 'DUPLICATE', status: 409, message: 'Giá trị này đã tồn tại.', details: {'field': 'zalo_user_id'}));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(CustomerFormScreen(customer: Customer.fromJson(customerJson())), api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Lưu thay đổi'));
    await tester.pumpAndSettle();
    expect(find.text('Zalo ID này đã được liên kết với khách hàng khác.'), findsWidgets);
    expect(find.text('Lưu thay đổi'), findsOneWidget); // still on the form
  });

  testWidgets('list FAB -> form -> created customer opens its detail (like the web redirect)', (tester) async {
    when(() => api.get('/admin/customers', query: any(named: 'query'))).thenAnswer((_) async => customersPage());
    when(() => api.post('/admin/customers', any(), any())).thenAnswer((_) async => {
          'customer': customerJson(id: 15, name: 'Phạm Thu Hà', phone: null, zalo: null, note: null, balance: 0, orders: 0),
        });
    when(() => api.get('/admin/customers/15')).thenAnswer((_) async => {
          'customer': customerJson(id: 15, name: 'Phạm Thu Hà', phone: null, zalo: null, note: null, balance: 0, orders: 0),
          'ledger': [],
          'orders': [],
        });
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const CustomersScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();
    await tester.enterText(_field('form-name'), 'Phạm Thu Hà');
    await tester.tap(find.widgetWithText(FilledButton, 'Thêm khách hàng'));
    await tester.pumpAndSettle();

    verify(() => api.post('/admin/customers', {'name': 'Phạm Thu Hà'}, any())).called(1);
    verify(() => api.get('/admin/customers/15')).called(1);
    expect(find.text('SỐ DƯ CÔNG NỢ'), findsOneWidget);
    expect(find.text('Không còn nợ'), findsOneWidget);
  });
}
