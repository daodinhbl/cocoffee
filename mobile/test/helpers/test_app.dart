import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/offline/connectivity.dart';
import 'package:cocoffee_mobile/core/offline/local_store.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/core/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';

class MockApi extends Mock implements ApiClient {}

const adminUser = AppUser(id: 1, username: 'boss', fullName: 'Chủ Quán', role: 'admin');
const cashierUser = AppUser(id: 2, username: 'thungan', fullName: 'Thu Ngân', role: 'cashier');

/// Wraps [child] like the real app (theme, Vietnamese locale) with the API faked and a signed-in user.
/// Navigation with go_router is not available here: test rendering and in-screen actions.
Future<Widget> testApp(Widget child, {required ApiClient api, AppUser user = adminUser, Size? size}) async {
  SharedPreferences.setMockInitialValues({});
  final store = SessionStore(await SharedPreferences.getInstance());
  return ProviderScope(
    overrides: [
      sessionStoreProvider.overrideWithValue(store),
      apiProvider.overrideWithValue(api),
      currentUserProvider.overrideWithValue(user),
      networkEventsProvider.overrideWithValue(() => const Stream<bool>.empty()),
    ],
    child: MaterialApp(
      theme: buildTheme(Brightness.light),
      locale: const Locale('vi'),
      supportedLocales: const [Locale('vi')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: child,
    ),
  );
}

/// Phone-sized surface (Pixel-like 411 x 891 dp); call `setSurface(tester, tablet)` for 1280 x 800.
const phone = Size(411, 891);
const tablet = Size(1280, 800);

Future<void> setSurface(WidgetTester tester, Size size) async {
  tester.view.physicalSize = size * tester.view.devicePixelRatio;
  addTearDown(tester.view.resetPhysicalSize);
}

/// A ProviderContainer for logic tests (no widgets): signed-in [user], the API faked, no connectivity plugin, offline
/// data kept in memory ([store] to inspect it).
Future<ProviderContainer> testContainer(ApiClient api, {AppUser user = cashierUser, LocalStore? store}) async {
  SharedPreferences.setMockInitialValues({});
  final session = SessionStore(await SharedPreferences.getInstance());
  return ProviderContainer(overrides: [
    sessionStoreProvider.overrideWithValue(session),
    apiProvider.overrideWithValue(api),
    currentUserProvider.overrideWithValue(user),
    networkEventsProvider.overrideWithValue(() => const Stream<bool>.empty()),
    if (store != null) localStoreProvider.overrideWithValue(store),
  ]);
}
