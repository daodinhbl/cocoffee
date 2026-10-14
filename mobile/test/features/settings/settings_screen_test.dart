import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/features/menu/form_sheet.dart';
import 'package:cocoffee_mobile/features/settings/settings_models.dart';
import 'package:cocoffee_mobile/features/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';

Map<String, dynamic> settingsRes() => {
      'printer': {
        'paperMm': 80, 'autoPrint': true, 'copies': 1, 'printerName': 'Xprinter quầy 1', 'shopAddress': '12 Lê Lợi, Huế',
        'shopPhone': '0905 123 456', 'footer': 'Cảm ơn quý khách — hẹn gặp lại!', 'showVat': true, 'vatRate': 8,
      },
      'config': {
        'publicBaseUrl': 'https://cocoffee.tasotek-giaiphapso.com', 'allowNegativeStock': false, 'draftTtlMinutes': 30,
        'verifySignature': true, 'receiptImage': true, 'timezone': '+07:00', 'sessionHours': '12h',
      },
    };

Map<String, dynamic> usersRes() => {
      'users': [
        {'id': 1, 'username': 'boss', 'full_name': 'Chủ Quán', 'role': 'admin', 'is_active': 1, 'created_at': '2026-01-02T03:00:00.000Z'},
        {'id': 2, 'username': 'thungan', 'full_name': 'Thu Ngân', 'role': 'cashier', 'is_active': 1, 'created_at': '2026-02-02T03:00:00.000Z'},
        {'id': 5, 'username': 'cu', 'full_name': 'Nhân viên cũ', 'role': 'cashier', 'is_active': 0, 'created_at': '2026-03-02T03:00:00.000Z'},
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
    FlutterSecureStorage.setMockInitialValues({});
    api = MockApi();
    when(() => api.get('/admin/settings', query: any(named: 'query'))).thenAnswer((_) async => settingsRes());
    when(() => api.get('/admin/users', query: any(named: 'query'))).thenAnswer((_) async => usersRes());
    when(() => api.put(any(), any())).thenAnswer((_) async => {'ok': true});
    when(() => api.post(any(), any())).thenAnswer((_) async => {'ok': true});
  });

  testWidgets('admin phone: account, password, config, printer, staff and app sections', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Cài đặt'), findsOneWidget);
    expect(find.text('Tài khoản của bạn, nhân sự và cấu hình hệ thống.'), findsOneWidget);
    expect(find.text('Đổi mật khẩu'), findsNWidgets(2)); // title + button
    expect(find.text('Mật khẩu mới (tối thiểu 10 ký tự)'), findsOneWidget);
    expect(find.text('Cấu hình hệ thống'), findsOneWidget);
    expect(find.text('30 phút'), findsOneWidget);
    expect(find.text('Bật'), findsNWidgets(2));
    expect(find.text('Tắt'), findsOneWidget);
    expect(find.text('12h'), findsOneWidget);
    expect(find.text('Máy in hóa đơn'), findsOneWidget);
    expect(find.text('In thử'), findsOneWidget);
    expect(find.text('Xprinter quầy 1'), findsOneWidget);
    expect(find.text('Tài khoản nhân viên (3)'), findsOneWidget);
    expect(find.text('Bạn'), findsOneWidget);
    expect(find.text('Đã khóa'), findsOneWidget);
    expect(find.text('Mở khóa'), findsOneWidget);
    expect(find.text('Khóa'), findsOneWidget); // not on your own row
    expect(find.text('Đặt lại mật khẩu'), findsNWidgets(2));
    expect(find.text('Ứng dụng'), findsOneWidget);
    expect(find.text(kAppVersion), findsOneWidget);
    expect(find.text('Đăng xuất'), findsOneWidget);
  });

  testWidgets('tablet: password and config side by side, staff as a table', (tester) async {
    await setSurface(tester, tablet);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    final pw = tester.getTopLeft(find.text('Mật khẩu hiện tại'));
    final cfg = tester.getTopLeft(find.text('Cấu hình hệ thống'));
    expect(cfg.dx, greaterThan(pw.dx + 200));
    expect(find.text('TÀI KHOẢN'), findsOneWidget);
    expect(find.text('VAI TRÒ'), findsOneWidget);
  });

  testWidgets('mid width (720 dp): sections stack, staff as cards', (tester) async {
    await setSurface(tester, const Size(720, 1024));
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    expect(tester.getTopLeft(find.text('Cấu hình hệ thống')).dy, greaterThan(tester.getTopLeft(find.text('Mật khẩu hiện tại')).dy));
    expect(find.text('VAI TRÒ'), findsNWidgets(3)); // card field labels
  });

  testWidgets('Đổi mật khẩu: validates, posts, and stores the new token', (tester) async {
    when(() => api.post('/auth/change-password', any())).thenAnswer((_) async => {'ok': true, 'token': 'tok-new'});
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();
    final submit = find.widgetWithText(FilledButton, 'Đổi mật khẩu');

    await tester.enterText(field('Mật khẩu hiện tại'), 'admin');
    await tester.enterText(field('Mật khẩu mới (tối thiểu 10 ký tự)'), 'ngắn');
    await tapVisible(tester, submit);
    expect(find.text('Mật khẩu mới phải có ít nhất 10 ký tự.'), findsOneWidget);

    await tester.enterText(field('Mật khẩu mới (tối thiểu 10 ký tự)'), 'caphe-sua-da-2026');
    await tester.enterText(field('Nhập lại mật khẩu mới'), 'caphe-sua-da-2025');
    await tapVisible(tester, submit);
    expect(find.text('Mật khẩu nhập lại không khớp.'), findsOneWidget);
    verifyNever(() => api.post('/auth/change-password', any()));

    await tester.enterText(field('Nhập lại mật khẩu mới'), 'caphe-sua-da-2026');
    await tapVisible(tester, submit);

    expect(verify(() => api.post('/auth/change-password', captureAny())).captured.single,
        {'current_password': 'admin', 'new_password': 'caphe-sua-da-2026'});
    expect(find.text('Đã đổi mật khẩu.'), findsOneWidget);
    final container = ProviderScope.containerOf(tester.element(find.byType(SettingsScreen)));
    expect(container.read(sessionStoreProvider).token, 'tok-new');
    expect(find.text('caphe-sua-da-2026'), findsNothing); // fields cleared
  });

  testWidgets('wrong current password shows the web message', (tester) async {
    when(() => api.post('/auth/change-password', any()))
        .thenThrow(ApiException(code: 'BAD_CREDENTIALS', status: 401, message: 'Sai tên đăng nhập hoặc mật khẩu.'));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.enterText(field('Mật khẩu hiện tại'), 'sai-mat-khau');
    await tester.enterText(field('Mật khẩu mới (tối thiểu 10 ký tự)'), 'caphe-sua-da-2026');
    await tester.enterText(field('Nhập lại mật khẩu mới'), 'caphe-sua-da-2026');
    await tapVisible(tester, find.widgetWithText(FilledButton, 'Đổi mật khẩu'));
    expect(find.text('Mật khẩu hiện tại không đúng.'), findsOneWidget);
  });

  testWidgets('Lưu cấu hình máy in puts the whole printer form', (tester) async {
    when(() => api.put('/admin/settings/printer', any())).thenAnswer((_) async => {'printer': settingsRes()['printer']});
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('58mm'));
    await tapVisible(tester, find.text('Tự động in sau khi thanh toán ở POS'));
    await tester.enterText(field('Thuế VAT (%)'), '10');
    await tapVisible(tester, find.text('Lưu cấu hình máy in'));

    expect(verify(() => api.put('/admin/settings/printer', captureAny())).captured.single, {
      'paperMm': 58,
      'autoPrint': false,
      'copies': 1,
      'printerName': 'Xprinter quầy 1',
      'shopAddress': '12 Lê Lợi, Huế',
      'shopPhone': '0905 123 456',
      'footer': 'Cảm ơn quý khách — hẹn gặp lại!',
      'showVat': true,
      'vatRate': 10,
    });
    expect(find.text('Đã lưu cấu hình máy in.'), findsOneWidget);
  });

  testWidgets('+ Thêm tài khoản posts the new user', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('+ Thêm tài khoản'));
    await tester.enterText(field('Họ tên'), 'Nguyễn Văn Ca');
    await tester.enterText(field('Tên đăng nhập'), 'Ca.Sang');
    await tester.enterText(field('Mật khẩu (tối thiểu 10 ký tự)'), 'mat-khau-ca-sang');
    await tapVisible(tester, find.text('Tạo tài khoản'));

    expect(verify(() => api.post('/admin/users', captureAny())).captured.single, {
      'full_name': 'Nguyễn Văn Ca',
      'username': 'ca.sang',
      'role': 'cashier',
      'password': 'mat-khau-ca-sang',
    });
    expect(find.text('Đã tạo tài khoản ca.sang.'), findsOneWidget);
  });

  testWidgets('Khóa asks first, then PUT /admin/users/:id/active', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('Khóa'));
    expect(find.text('Khóa tài khoản thungan? Người này sẽ không đăng nhập được nữa.'), findsOneWidget);
    await tapVisible(tester, find.text('Đồng ý'));
    expect(verify(() => api.put('/admin/users/2/active', captureAny())).captured.single, {'active': false});
    expect(find.text('Đã vô hiệu hóa thungan.'), findsOneWidget);
  });

  testWidgets('cashier: only account, password, app info and logout', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api, user: cashierUser));
    await tester.pumpAndSettle();

    expect(find.text('Thu ngân'), findsOneWidget);
    expect(find.text('Đổi mật khẩu'), findsNWidgets(2));
    expect(find.text('Cấu hình hệ thống'), findsNothing);
    expect(find.text('Máy in hóa đơn'), findsNothing);
    expect(find.textContaining('Tài khoản nhân viên'), findsNothing);
    expect(find.text('Đăng xuất'), findsOneWidget);
    verifyNever(() => api.get('/admin/settings', query: any(named: 'query')));
    verifyNever(() => api.get('/admin/users', query: any(named: 'query')));
  });
}
