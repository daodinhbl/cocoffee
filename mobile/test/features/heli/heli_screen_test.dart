import 'package:cocoffee_mobile/core/offline/connectivity.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/core/theme/app_theme.dart';
import 'package:cocoffee_mobile/features/heli/heli_screen.dart';
import 'package:cocoffee_mobile/features/heli/heli_voice.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../helpers/test_app.dart';
import 'heli_controller_test.dart' show FakeVoice;

Future<Widget> _app(MockApi api, AppUser user) async {
  SharedPreferences.setMockInitialValues({});
  final store = SessionStore(await SharedPreferences.getInstance());
  return ProviderScope(
    overrides: [
      sessionStoreProvider.overrideWithValue(store),
      apiProvider.overrideWithValue(api),
      currentUserProvider.overrideWithValue(user),
      networkEventsProvider.overrideWithValue(() => const Stream<bool>.empty()),
      heliVoiceProvider.overrideWithValue(FakeVoice()),
    ],
    child: MaterialApp(
      theme: buildTheme(Brightness.light),
      locale: const Locale('vi'),
      supportedLocales: const [Locale('vi')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: const HeliScreen(),
    ),
  );
}

void main() {
  late MockApi api;
  setUp(() {
    api = MockApi();
    when(() => api.post('/heli/chat', any())).thenAnswer((_) async => {'reply': 'Hôm nay có 12 đơn.'});
  });

  for (final size in [phone, tablet]) {
    testWidgets('admin sees the data hints; typing a question shows the answer as plain text (${size.width.toInt()} dp)', (tester) async {
      await setSurface(tester, size);
      await tester.pumpWidget(await _app(api, adminUser));
      await tester.pump();
      expect(find.text('Trợ lý Heli'), findsOneWidget);
      expect(find.text('Nhấn micro để nói với Heli'), findsOneWidget);
      expect(find.text('Doanh thu hôm nay là bao nhiêu?'), findsOneWidget);
      expect(find.bySemanticsLabel('Nhấn để nói với Heli'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'hôm nay bao nhiêu đơn?');
      await tester.tap(find.byTooltip('Gửi'));
      await tester.pump();
      await tester.pump();
      expect(find.text('hôm nay bao nhiêu đơn?'), findsOneWidget);
      expect(find.text('Hôm nay có 12 đơn.'), findsOneWidget);
    });
  }

  testWidgets('cashier sees the chat-only hint, not the data hints', (tester) async {
    await setSurface(tester, phone);
    await tester.pumpWidget(await _app(api, cashierUser));
    await tester.pump();
    expect(find.textContaining('chỉ dành cho quản trị viên'), findsOneWidget);
    expect(find.text('Doanh thu hôm nay là bao nhiêu?'), findsNothing);
    expect(find.text('Xin chào Heli'), findsOneWidget);
  });
}
