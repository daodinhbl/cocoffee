import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/features/zalo/zalo_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../../helpers/test_app.dart';

Map<String, dynamic> overview({bool tokenSet = false, String? source}) => {
      'connection': {
        'mode': 'platform', 'platform': true, 'tokenSet': tokenSet, 'tokenSource': source, 'configured': tokenSet,
        'webhookUrl': 'https://cocoffee.example.com/api/zalo/webhook', 'debtOwnerChatId': '', 'debtOwnerChatType': 'user',
      },
    };

void main() {
  testWidgets('no token yet: paste it, it goes to PUT /admin/zalo/bot-token and the field is cleared', (tester) async {
    await setSurface(tester, phone);
    final api = MockApi();
    when(() => api.get('/admin/zalo', query: any(named: 'query'), useCache: any(named: 'useCache'))).thenAnswer((_) async => overview());
    when(() => api.put(any(), any(), any())).thenAnswer((_) async => {'ok': true, 'message': 'Đã lưu Bot Token. Đã đăng ký webhook.'});
    await tester.pumpWidget(await testApp(const ZaloScreen(), api: api));
    await tester.pumpAndSettle();

    expect(find.text('Chưa có'), findsOneWidget);
    expect(find.textContaining('cocoffee.example.com/api/zalo/webhook'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '123456789:AbCdEfGhIjKlMnOpQrSt');
    await tester.tap(find.text('Lưu và kết nối'));
    await tester.pumpAndSettle();

    final body = verify(() => api.put('/admin/zalo/bot-token', captureAny(), any())).captured.single as Map;
    expect(body['token'], '123456789:AbCdEfGhIjKlMnOpQrSt');
    expect(find.text('Đã lưu Bot Token. Đã đăng ký webhook.'), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty, reason: 'a secret is not kept on screen');
  });

  testWidgets('a short token is refused before anything is sent', (tester) async {
    await setSurface(tester, phone);
    final api = MockApi();
    when(() => api.get('/admin/zalo', query: any(named: 'query'), useCache: any(named: 'useCache'))).thenAnswer((_) async => overview());
    await tester.pumpWidget(await testApp(const ZaloScreen(), api: api));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'abc');
    await tester.tap(find.text('Lưu và kết nối'));
    await tester.pumpAndSettle();
    verifyNever(() => api.put(any(), any(), any()));
    expect(find.textContaining('Dán đúng Bot Token'), findsOneWidget);
  });

  testWidgets('a token set in hPanel locks the field; a Zalo refusal is shown as it came', (tester) async {
    await setSurface(tester, phone);
    final api = MockApi();
    when(() => api.get('/admin/zalo', query: any(named: 'query'), useCache: any(named: 'useCache'))).thenAnswer((_) async => overview(tokenSet: true, source: 'env'));
    await tester.pumpWidget(await testApp(const ZaloScreen(), api: api));
    await tester.pumpAndSettle();
    expect(find.textContaining('đặt ở hPanel'), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
    expect(find.text('Đăng ký lại webhook'), findsOneWidget);
  });

  testWidgets('Zalo rejecting the token shows its reason', (tester) async {
    await setSurface(tester, phone);
    final api = MockApi();
    when(() => api.get('/admin/zalo', query: any(named: 'query'), useCache: any(named: 'useCache'))).thenAnswer((_) async => overview());
    when(() => api.put(any(), any(), any())).thenThrow(ApiException(code: 'ZALO_BOT_API', status: 400, message: 'Zalo không chấp nhận token này: sai token', serverMessage: 'Zalo không chấp nhận token này: sai token'));
    await tester.pumpWidget(await testApp(const ZaloScreen(), api: api));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '123456789:AbCdEfGhIjKlMnOpQrSt');
    await tester.tap(find.text('Lưu và kết nối'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Zalo không chấp nhận token này'), findsOneWidget);
  });
}
