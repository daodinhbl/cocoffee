import 'package:cocoffee_mobile/features/settings/heli_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';

HeliSetting setting({bool enabled = false, String source = '', String hint = ''}) =>
    HeliSetting(enabled: enabled, source: source, hint: hint, model: 'gpt-4o-mini', models: const ['gpt-4o-mini', 'gpt-4o']);

Future<MockApi> pump(WidgetTester tester, HeliSetting s) async {
  await setSurface(tester, phone);
  final api = MockApi();
  when(() => api.get('/admin/settings', query: any(named: 'query'), useCache: any(named: 'useCache'))).thenAnswer((_) async => {'printer': {}, 'config': {}});
  await tester.pumpWidget(await testApp(Scaffold(body: SingleChildScrollView(child: HeliCard(setting: s))), api: api));
  await tester.pumpAndSettle();
  return api;
}

void main() {
  testWidgets('no key: paste it, choose the model, save -> PUT /admin/settings/heli with api_key and model; the field is cleared', (tester) async {
    final api = await pump(tester, setting());
    when(() => api.put(any(), any(), any())).thenAnswer((_) async => {'heli': {}});
    expect(find.text('Chưa có khóa'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'sk-test_ABCDEFGHIJKLMNOPQRSTUVWX1234');
    await tester.tap(find.text('Lưu'));
    await tester.pumpAndSettle();
    final body = verify(() => api.put('/admin/settings/heli', captureAny(), any())).captured.single as Map;
    expect(body['api_key'], 'sk-test_ABCDEFGHIJKLMNOPQRSTUVWX1234');
    expect(body['model'], 'gpt-4o-mini');
    expect(find.text('Đã lưu cấu hình trợ lý Heli.'), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);
  });

  testWidgets('a key already set is shown only by its last characters; a blank field keeps it (no api_key sent)', (tester) async {
    final api = await pump(tester, setting(enabled: true, source: 'settings', hint: '…1234'));
    when(() => api.put(any(), any(), any())).thenAnswer((_) async => {'heli': {}});
    expect(find.textContaining('…1234'), findsOneWidget);
    expect(find.text('Xóa khóa đã lưu'), findsOneWidget);
    await tester.tap(find.text('Lưu'));
    await tester.pumpAndSettle();
    final body = verify(() => api.put('/admin/settings/heli', captureAny(), any())).captured.single as Map;
    expect(body.containsKey('api_key'), isFalse);
  });

  testWidgets('test button asks the server; clear sends clear: true', (tester) async {
    final api = await pump(tester, setting(enabled: true, source: 'settings', hint: '…1234'));
    when(() => api.post('/admin/settings/heli/test', any(), any())).thenAnswer((_) async => {'ok': true, 'hint': '…1234'});
    when(() => api.put(any(), any(), any())).thenAnswer((_) async => {'heli': {}});
    await tester.tap(find.text('Kiểm tra khóa'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Khóa API hợp lệ'), findsOneWidget);
    await tester.tap(find.text('Xóa khóa đã lưu'));
    await tester.pumpAndSettle();
    final body = verify(() => api.put('/admin/settings/heli', captureAny(), any())).captured.single as Map;
    expect(body['clear'], isTrue);
  });
}
