import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/menu/form_sheet.dart';
import 'package:cocoffee_mobile/features/settings/integrations_cards.dart';
import 'package:cocoffee_mobile/features/settings/settings_models.dart';
import 'package:cocoffee_mobile/features/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';

const _testFlight = 'https://testflight.apple.com/join/AbCd1234';

Map<String, dynamic> settingsRes({Map<String, dynamic>? ios, Map<String, dynamic>? payon}) => {
      'printer': {
        'paperMm': 80, 'autoPrint': true, 'copies': 1, 'printerName': 'Xprinter quầy 1', 'shopAddress': '12 Lê Lợi, Huế',
        'shopPhone': '0905 123 456', 'footer': 'Hẹn gặp lại!', 'showVat': true, 'vatRate': 8,
      },
      'config': {
        'publicBaseUrl': 'https://cocoffee.tasotek-giaiphapso.com', 'allowNegativeStock': false, 'draftTtlMinutes': 30,
        'verifySignature': true, 'receiptImage': true, 'timezone': '+07:00', 'sessionHours': '12h',
      },
      'shop_name': 'Cò Coffee',
      'ios_app': ios ??
          {
            'url': '', 'link': null, 'fallback': null,
            'app': {'name': 'POS Tasotek', 'bundleId': 'com.tasotek.fnb', 'minIos': '15.0'},
          },
      'payon': payon ?? payonRes(),
    };

Map<String, dynamic> payonRes({bool complete = false, bool ready = false, Map<String, dynamic> from = const {}}) => {
      'config': {
        'enabled': ready, 'env': 'sandbox', 'baseUrl': 'https://dev-api-merchant.payon.vn/v1/merchant', 'complete': complete, 'ready': ready,
        'appId': complete ? '160088PayON' : '', 'merchantId': complete ? '12345' : '', 'authUser': complete ? 'mc-user' : '',
        'bankCode': ready ? 'VCB' : '', 'bankName': ready ? 'Vietcombank' : '', 'expireMinutes': 15,
        'authPassSet': complete, 'authPassHint': complete ? '…ET-1' : '', 'secretKeySet': complete, 'secretKeyHint': complete ? '…ET-2' : '',
        'fromEnv': {'env': false, 'appId': false, 'merchantId': false, 'authUser': false, 'authPass': false, 'secretKey': false, ...from},
      },
      'banks': [
        {'code': 'VCB', 'name': 'Vietcombank'},
        {'code': 'ACB', 'name': 'ACB'},
      ],
      'ipnUrl': 'https://cocoffee.tasotek-giaiphapso.com/api/payon/ipn',
    };

Map<String, dynamic> usersRes() => {
      'users': [
        {'id': 1, 'username': 'boss', 'full_name': 'Chủ Quán', 'role': 'admin', 'is_active': 1, 'created_at': '2026-01-02T03:00:00.000Z'},
      ],
    };

Finder field(String label) =>
    find.descendant(of: find.widgetWithText(LabeledField, label), matching: find.byType(TextFormField));

/// The EditableText's TextField (TextFormField itself has no readOnly getter).
TextField input(WidgetTester tester, String label) =>
    tester.widget<TextField>(find.descendant(of: field(label), matching: find.byType(TextField)));

Future<void> tapVisible(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
}

void main() {
  late MockApi api;

  void serve(Map<String, dynamic> settings) {
    when(() => api.get('/admin/settings', query: any(named: 'query'))).thenAnswer((_) async => settings);
  }

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    api = MockApi();
    serve(settingsRes());
    when(() => api.get('/admin/users', query: any(named: 'query'))).thenAnswer((_) async => usersRes());
    when(() => api.put(any(), any())).thenAnswer((_) async => {'ok': true, 'message': 'Đã lưu cấu hình PayOn (chưa bật).'});
    when(() => api.post('/admin/settings/payon/test')).thenAnswer((_) async => {'message': 'Kết nối PayOn (thử nghiệm) thành công: 2 ngân hàng hỗ trợ QR.'});
    when(() => api.post('/admin/settings/payon/ip')).thenAnswer((_) async => {'message': 'IP máy chủ gọi ra ngoài: 203.0.113.7. Gửi địa chỉ này cho NextPay.'});
  });

  test('iosLinkRule: only https links on Apple TestFlight / App Store hosts', () {
    expect(iosLinkRule(''), isNull);
    expect(iosLinkRule('  '), isNull);
    expect(iosLinkRule(' $_testFlight '), isNull);
    expect(iosLinkRule('https://apps.apple.com/vn/app/pos-tasotek/id123456789'), isNull);
    for (final bad in [
      'http://testflight.apple.com/join/x',
      'https://example.com/app.ipa',
      'https://testflight.apple.com.evil.example/join/x',
      'https://user:pw@apps.apple.com/x',
      'itms-services://?action=download-manifest',
      'không phải liên kết',
    ]) {
      expect(iosLinkRule(bad), isNotNull, reason: bad);
    }
    expect(iosLinkRule('https://apps.apple.com/${'a' * 290}'), isNotNull);
  });

  test('models: ios_app and payon are optional (older servers) and tolerant', () {
    final old = AdminSettings.fromJson({'printer': <String, dynamic>{}, 'config': <String, dynamic>{}});
    expect(old.iosApp, isNull);
    expect(old.payon, isNull);
    final s = AdminSettings.fromJson(settingsRes(payon: payonRes(complete: true, ready: true, from: {'appId': true})));
    expect(s.iosApp!.linkLabel, isNull);
    expect(s.iosApp!.appName, 'POS Tasotek');
    expect(s.payon!.ready, isTrue);
    expect(s.payon!.lockedFields, {'appId'});
    expect(s.payon!.banks.map((b) => b.code), ['VCB', 'ACB']);
    expect(s.payon!.authPassHint, '…ET-1');
  });

  testWidgets('admin phone: both cards are shown; nothing configured yet', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Ứng dụng iOS (iPhone / iPad)'), findsOneWidget);
    expect(find.text('Chưa có liên kết'), findsOneWidget);
    expect(find.text('Lưu liên kết'), findsOneWidget);
    expect(find.text('Thanh toán QR (PayOn / NextPay)'), findsOneWidget);
    expect(find.text('Chưa cấu hình'), findsOneWidget);
    expect(find.text('https://cocoffee.tasotek-giaiphapso.com/api/payon/ipn'), findsOneWidget);
    expect(find.text('MC_AUTH_PASS (chưa có)'), findsOneWidget);
    expect(find.text('MC_SECRET_KEY (chưa có)'), findsOneWidget);
    expect(find.text('Lưu cấu hình PayOn'), findsOneWidget);
    expect(find.text('Xem IP máy chủ (để NextPay khai báo)'), findsOneWidget);
    final test = tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Kiểm tra kết nối & tải danh sách ngân hàng'));
    expect(test.onPressed, isNull, reason: 'the test needs the keys saved first');
  });

  testWidgets('a cashier sees neither card', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api, user: cashierUser));
    await tester.pumpAndSettle();
    expect(find.text('Ứng dụng iOS (iPhone / iPad)'), findsNothing);
    expect(find.text('Thanh toán QR (PayOn / NextPay)'), findsNothing);
  });

  testWidgets('iOS link: a bad link is refused on the spot, a good one is sent, an empty one clears', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();
    final input = field('Liên kết tải (https://testflight.apple.com/join/… hoặc https://apps.apple.com/…)');

    await tester.ensureVisible(input);
    await tester.enterText(input, 'https://example.com/app.ipa');
    await tapVisible(tester, find.text('Lưu liên kết'));
    expect(find.textContaining('Liên kết phải là địa chỉ https của TestFlight'), findsOneWidget);
    verifyNever(() => api.put('/admin/settings/ios-app', any()));

    await tester.enterText(input, ' $_testFlight ');
    await tapVisible(tester, find.text('Lưu liên kết'));
    verify(() => api.put('/admin/settings/ios-app', {'url': _testFlight})).called(1);
    expect(find.text('Đã lưu liên kết tải ứng dụng iOS.'), findsOneWidget);

    await tester.pump(const Duration(seconds: 5));
    await tester.enterText(input, '');
    await tapVisible(tester, find.text('Lưu liên kết'));
    verify(() => api.put('/admin/settings/ios-app', {'url': ''})).called(1);
    expect(find.text('Đã bỏ liên kết tải ứng dụng iOS.'), findsOneWidget);
  });

  testWidgets('iOS link in force: badge shows where it leads; the environment fallback is explained', (tester) async {
    serve(settingsRes(ios: {
      'url': _testFlight,
      'link': {'kind': 'testflight', 'label': 'TestFlight', 'action': 'Mở trong TestFlight', 'url': _testFlight},
      'fallback': null,
      'app': {'name': 'POS Tasotek', 'bundleId': 'com.tasotek.fnb', 'minIos': '15.0'},
    }));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();
    expect(find.text('TestFlight'), findsOneWidget);
    expect(find.text(_testFlight), findsOneWidget);
  });

  testWidgets('iOS link from the environment only: the form is empty and says where the link comes from', (tester) async {
    serve(settingsRes(ios: {
      'url': '', 'link': {'kind': 'appstore', 'label': 'App Store', 'action': 'x', 'url': 'https://apps.apple.com/x'},
      'fallback': {'kind': 'appstore', 'label': 'App Store', 'action': 'x', 'url': 'https://apps.apple.com/x'},
      'app': {'name': 'POS Tasotek', 'bundleId': 'com.tasotek.fnb', 'minIos': '15.0'},
    }));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();
    expect(find.text('App Store'), findsOneWidget);
    expect(find.text('Đang dùng IOS_APP_URL từ biến môi trường: https://apps.apple.com/x'), findsOneWidget);
  });

  testWidgets('PayOn saved and on: secrets are never shown, only their hints; the bank is preselected', (tester) async {
    serve(settingsRes(payon: payonRes(complete: true, ready: true)));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Đang bật'), findsOneWidget);
    expect(find.text('MC_AUTH_PASS (đã lưu …ET-1)'), findsOneWidget);
    expect(find.text('MC_SECRET_KEY (đã lưu …ET-2)'), findsOneWidget);
    expect(find.text('Để trống = giữ nguyên'), findsNWidgets(2));
    expect(find.text('160088PayON'), findsOneWidget);
    expect(find.text('Vietcombank'), findsOneWidget);
    final test = tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Kiểm tra kết nối & tải danh sách ngân hàng'));
    expect(test.onPressed, isNotNull);
  });

  testWidgets('PayOn save sends the whole form; blank secrets stay blank (the server keeps them); toasts the server message', (tester) async {
    serve(settingsRes(payon: payonRes(complete: true, ready: true)));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.ensureVisible(field('QR hết hạn sau (phút)'));
    await tester.enterText(field('QR hết hạn sau (phút)'), '20');
    await tester.enterText(field('MC_AUTH_PASS (đã lưu …ET-1)'), 'new-pass-9');
    await tapVisible(tester, find.text('Lưu cấu hình PayOn'));

    verify(() => api.put('/admin/settings/payon', {
          'env': 'sandbox', 'appId': '160088PayON', 'merchantId': '12345', 'authUser': 'mc-user', 'authPass': 'new-pass-9',
          'secretKey': '', 'bankCode': 'VCB', 'expireMinutes': 20, 'enabled': true,
        })).called(1);
    expect(find.text('Đã lưu cấu hình PayOn (chưa bật).'), findsOneWidget);
    expect(find.text('new-pass-9'), findsNothing, reason: 'the typed secret is cleared after saving');
  });

  testWidgets('PayOn validation: merchant id must be digits, expiry 3-60; nothing is sent', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    await tester.ensureVisible(field('Mã merchant (MC_ID, số)'));
    await tester.enterText(field('Mã merchant (MC_ID, số)'), 'abc');
    await tester.enterText(field('QR hết hạn sau (phút)'), '2');
    await tapVisible(tester, find.text('Lưu cấu hình PayOn'));
    expect(find.text('Mã merchant (MC_ID) phải là số.'), findsOneWidget);
    expect(find.text('Từ 3 đến 60 phút.'), findsOneWidget);
    verifyNever(() => api.put('/admin/settings/payon', any()));
  });

  testWidgets('PayOn values from the environment are read-only', (tester) async {
    serve(settingsRes(payon: payonRes(complete: true, from: {'appId': true, 'authPass': true})));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    expect(input(tester, 'APP_ID').readOnly, isTrue);
    expect(find.text('Lấy từ biến môi trường (hPanel), không sửa ở đây.'), findsNWidgets(2));
    expect(input(tester, 'MC_AUTH_USER').readOnly, isFalse);
  });

  testWidgets('PayOn connection test and server IP call their endpoints and show the answers', (tester) async {
    serve(settingsRes(payon: payonRes(complete: true)));
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('Kiểm tra kết nối & tải danh sách ngân hàng'));
    verify(() => api.post('/admin/settings/payon/test')).called(1);
    expect(find.textContaining('thành công: 2 ngân hàng'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));

    await tapVisible(tester, find.text('Xem IP máy chủ (để NextPay khai báo)'));
    verify(() => api.post('/admin/settings/payon/ip')).called(1);
    expect(find.text('IP máy chủ'), findsOneWidget);
    expect(find.textContaining('203.0.113.7'), findsOneWidget);
  });

  testWidgets('a server refusal is shown as a toast and the form stays', (tester) async {
    when(() => api.put('/admin/settings/payon', any())).thenThrow(
      ApiException(code: 'VALIDATION', status: 400, message: 'Nhập đủ APP_ID, MC_ID, MC_AUTH_USER, MC_AUTH_PASS và MC_SECRET_KEY trước khi bật.'),
    );
    await setSurface(tester, phone);
    await tester.pumpWidget(await testApp(const SettingsScreen(), api: api));
    await tester.pumpAndSettle();

    await tapVisible(tester, find.text('Lưu cấu hình PayOn'));
    expect(find.textContaining('Nhập đủ APP_ID'), findsOneWidget);
    expect(find.text('Lưu cấu hình PayOn'), findsOneWidget);
  });
}
