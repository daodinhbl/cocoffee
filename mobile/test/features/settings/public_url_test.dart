import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/settings/settings_models.dart';
import 'package:cocoffee_mobile/features/settings/settings_sections.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';

const _config = SystemConfig(
  shopName: 'CoCoffee',
  publicBaseUrl: 'https://cocoffee.example.com',
  publicBaseUrlSource: 'env',
  publicBaseUrlEnv: 'https://cocoffee.example.com',
  allowNegativeStock: false,
  draftTtlMinutes: 30,
  verifySignature: true,
  receiptImage: false,
  timezone: '+07:00',
  sessionHours: '12h',
);

void main() {
  testWidgets('the public address can be edited: PUT /admin/settings/public-url, then the settings reload', (tester) async {
    await setSurface(tester, phone);
    final api = MockApi();
    when(() => api.put(any(), any(), any())).thenAnswer((_) async => {'config': {}});
    when(() => api.get('/admin/settings', query: any(named: 'query'), useCache: any(named: 'useCache'))).thenAnswer((_) async => {'config': {}});
    await tester.pumpWidget(await testApp(const Scaffold(body: SingleChildScrollView(child: ConfigCard(config: _config))), api: api));
    await tester.pumpAndSettle();

    expect(find.text('https://cocoffee.example.com'), findsOneWidget);
    await tester.tap(find.byKey(const Key('edit-public-url')));
    await tester.pumpAndSettle();
    expect(find.text('Sửa tên miền công khai'), findsOneWidget);
    expect(find.textContaining('ưu tiên hơn biến môi trường'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'quan-moi.ngrok-free.app');
    await tester.tap(find.text('Lưu'));
    await tester.pumpAndSettle();

    final sent = verify(() => api.put('/admin/settings/public-url', captureAny(), any())).captured.single as Map;
    expect(sent['url'], 'quan-moi.ngrok-free.app');
    expect(find.text('Đã lưu tên miền công khai.'), findsOneWidget);
  });

  testWidgets('a refusal from the server is shown and nothing else changes', (tester) async {
    await setSurface(tester, phone);
    final api = MockApi();
    when(() => api.put(any(), any(), any())).thenThrow(ApiException(code: 'VALIDATION', status: 400, message: 'Địa chỉ phải dùng https', serverMessage: 'Địa chỉ phải dùng https'));
    await tester.pumpWidget(await testApp(const Scaffold(body: SingleChildScrollView(child: ConfigCard(config: _config))), api: api));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('edit-public-url')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'http://x.com');
    await tester.tap(find.text('Lưu'));
    await tester.pumpAndSettle();
    expect(find.text('Địa chỉ phải dùng https'), findsOneWidget);
  });
}
