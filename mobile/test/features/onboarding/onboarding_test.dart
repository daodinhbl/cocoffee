import 'dart:convert';

import 'package:cocoffee_mobile/app.dart';
import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/app_mode.dart';
import 'package:cocoffee_mobile/core/local/local_db.dart';
import 'package:cocoffee_mobile/core/offline/connectivity.dart';
import 'package:cocoffee_mobile/core/router.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/features/dashboard/dashboard_screen.dart';
import 'package:cocoffee_mobile/features/onboarding/local_setup_screen.dart';
import 'package:cocoffee_mobile/features/onboarding/onboarding_service.dart';
import 'package:cocoffee_mobile/features/onboarding/signup_screen.dart';
import 'package:cocoffee_mobile/features/onboarding/welcome_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../../helpers/test_app.dart';
import '../dashboard/dashboard_fixtures.dart';

/// The first-run flow of a phone that installed the app from Google Play: the welcome page and its three choices,
/// "Tạo quán mới" (server sign-up), "Dùng trên máy này" (local database), and deleting the account / the local data.
void main() {
  sqfliteFfiInit();

  late MockApi api; // the shop's server (after sign-up / sign-in)
  late MockApi signup; // the main site's /api/signup
  late LocalDb localDb;

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    api = stubbedApi(dashboard: emptyDashboardJson(), notifications: emptyNotificationsJson());
    signup = MockApi();
    when(() => signup.get('/signup', query: any(named: 'query'), useCache: any(named: 'useCache')))
        .thenAnswer((_) async => {'open': true, 'base_domain': 'tasotek.test'});
    when(() => signup.get('/signup/check', query: any(named: 'query'), useCache: any(named: 'useCache')))
        .thenAnswer((_) async => {'ok': true, 'message': 'Còn trống: quan-moc.tasotek.test'});
    localDb = LocalDb(databaseFactoryFfiNoIsolate, inMemoryDatabasePath);
  });
  tearDown(() => localDb.close());

  /// The whole app on a fresh install ([prefs] empty), with the server and sign-up APIs faked. In local mode the
  /// real local client runs over an in-memory database ([localApi] true leaves apiProvider alone).
  Future<ProviderContainer> pumpApp(WidgetTester tester, {Map<String, Object> prefs = const {}, bool localApi = false}) async {
    SharedPreferences.setMockInitialValues(prefs);
    final store = SessionStore(await SharedPreferences.getInstance());
    await store.load();
    final container = ProviderContainer(overrides: [
      sessionStoreProvider.overrideWithValue(store),
      signupApiProvider.overrideWithValue(signup),
      localDbProvider.overrideWithValue(localDb),
      networkEventsProvider.overrideWithValue(() => const Stream<bool>.empty()),
      if (!localApi) apiProvider.overrideWithValue(api),
    ]);
    addTearDown(container.dispose);
    await setSurface(tester, phone);
    await tester.pumpWidget(UncontrolledProviderScope(container: container, child: const CoCoffeeApp()));
    await tester.pumpAndSettle();
    return container;
  }

  /// sqflite_common_ffi works on the real event loop: let it run between frames instead of pumpAndSettle.
  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 15; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  String location(ProviderContainer c) => c.read(routerProvider).routerDelegate.currentConfiguration.uri.path;

  Future<void> tapKey(WidgetTester tester, String key) async {
    await tester.pumpAndSettle(); // pending checks (the sub-domain one) may still move the layout
    await tester.ensureVisible(find.byKey(ValueKey(key)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey(key)));
    await tester.pumpAndSettle();
  }

  Future<void> enter(WidgetTester tester, String key, String text) async {
    await tester.ensureVisible(find.byKey(ValueKey(key)));
    await tester.enterText(find.byKey(ValueKey(key)), text);
  }

  group('welcome page', () {
    testWidgets('a fresh install shows the three choices, each opening its screen', (tester) async {
      final c = await pumpApp(tester);
      expect(location(c), '/welcome');
      expect(find.byType(WelcomeScreen), findsOneWidget);
      expect(find.text('Đăng nhập quán có sẵn'), findsOneWidget);
      expect(find.text('Tạo quán mới trên máy chủ'), findsOneWidget);
      expect(find.text('Dùng trên máy này'), findsOneWidget);

      await tapKey(tester, 'welcome-signup');
      expect(location(c), '/signup');
      expect(find.byType(SignupScreen), findsOneWidget);
      await tester.tap(find.text('Quay lại'));
      await tester.pumpAndSettle();
      expect(location(c), '/welcome');

      await tapKey(tester, 'welcome-local');
      expect(location(c), '/local-setup');
      expect(find.byType(LocalSetupScreen), findsOneWidget);
      expect(find.textContaining('Chưa có:'), findsOneWidget, reason: 'what local mode does not do is said up front');
      await tester.tap(find.text('Quay lại'));
      await tester.pumpAndSettle();
      expect(location(c), '/welcome');
      expect(c.read(appModeProvider), AppMode.unset);
    });

    testWidgets('a sign-up waiting for its database: "Kiểm tra lại" opens the shop once it is ready', (tester) async {
      when(() => signup.get('/signup/status', query: any(named: 'query'), useCache: any(named: 'useCache')))
          .thenAnswer((_) async => {'status': 'active'});
      final pending = PendingShop(slug: 'quan-moc', url: 'https://quan-moc.tasotek.test', username: 'chuquan', name: 'Quán Mộc');
      final c = await pumpApp(tester, prefs: {'pending_signup': jsonEncode(pending.toJson())});
      expect(find.text('Quán “Quán Mộc” đang được chuẩn bị'), findsOneWidget);

      await tapKey(tester, 'welcome-check-pending');
      expect(location(c), '/login');
      expect(c.read(appModeProvider), AppMode.server);
      expect(c.read(serverUrlProvider), 'https://quan-moc.tasotek.test');
      expect(c.read(pendingShopProvider), isNull);
    });
  });

  group('Tạo quán mới', () {
    Future<void> fill(WidgetTester tester) async {
      await enter(tester, 'signup-name', 'Quán Cà Phê Mộc');
      await tester.pump(const Duration(milliseconds: 600)); // the availability check of the suggested sub-domain
      await enter(tester, 'signup-owner', 'Nguyễn Văn A');
      await enter(tester, 'signup-email', 'a@example.com');
      await enter(tester, 'signup-username', 'chuquan');
      await enter(tester, 'signup-password', 'mat-khau-dai-1');
      await enter(tester, 'signup-password2', 'mat-khau-dai-1');
    }

    test('the sub-domain is suggested from the shop name', () {
      expect(slugFrom('Quán Cà Phê Mộc'), 'quan-ca-phe-moc');
      expect(slugFrom('  Đen & Đá!! '), 'den-da');
      expect(slugFrom('a' * 40).length, 30);
    });

    testWidgets('active: the app switches to the new shop and signs in with the new account', (tester) async {
      when(() => signup.post('/signup', any())).thenAnswer((_) async => {
            'slug': 'quan-ca-phe-moc', 'status': 'active', 'url': 'https://quan-ca-phe-moc.tasotek.test', 'base_domain': 'tasotek.test', 'username': 'chuquan',
          });
      when(() => api.post('/auth/login', any())).thenAnswer((_) async => {
            'token': 'tok',
            'must_change_password': false,
            'user': {'id': 1, 'username': 'chuquan', 'full_name': 'Nguyễn Văn A', 'role': 'admin'},
          });
      final c = await pumpApp(tester);
      await tapKey(tester, 'welcome-signup');
      expect(find.text('.tasotek.test'), findsOneWidget, reason: 'the base domain from GET /api/signup');
      await fill(tester);
      expect(find.byKey(const ValueKey('signup-slug-check')), findsOneWidget);
      expect(find.text('Còn trống: quan-moc.tasotek.test'), findsOneWidget);

      await tapKey(tester, 'signup-submit');
      final sent = verify(() => signup.post('/signup', captureAny())).captured.single as Map;
      expect(sent['slug'], 'quan-ca-phe-moc');
      expect(sent['ownerName'], 'Nguyễn Văn A');
      expect(sent['password2'], 'mat-khau-dai-1');
      verify(() => api.post('/auth/login', {'username': 'chuquan', 'password': 'mat-khau-dai-1'})).called(1);
      expect(c.read(serverUrlProvider), 'https://quan-ca-phe-moc.tasotek.test');
      expect(c.read(appModeProvider), AppMode.server);
      expect(location(c), '/dashboard');
      expect(find.byType(DashboardScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('pending: a clear message, the sign-up is remembered on the welcome page', (tester) async {
      when(() => signup.post('/signup', any())).thenAnswer((_) async => {
            'slug': 'quan-ca-phe-moc', 'status': 'pending', 'url': 'https://quan-ca-phe-moc.tasotek.test', 'base_domain': 'tasotek.test', 'username': 'chuquan',
          });
      final c = await pumpApp(tester);
      await tapKey(tester, 'welcome-signup');
      await fill(tester);
      await tapKey(tester, 'signup-submit');
      expect(find.text('Đã nhận đăng ký'), findsOneWidget);
      expect(find.textContaining('đang chờ cấp cơ sở dữ liệu'), findsOneWidget);
      await tester.tap(find.text('Đã hiểu'));
      await tester.pumpAndSettle();
      expect(location(c), '/welcome');
      expect(c.read(pendingShopProvider)?.slug, 'quan-ca-phe-moc');
      expect(c.read(appModeProvider), AppMode.unset);
      expect(find.text('Quán “Quán Cà Phê Mộc” đang được chuẩn bị'), findsOneWidget);
      verifyNever(() => api.post('/auth/login', any()));
    });

    testWidgets('a taken sub-domain is shown under its field; nothing is signed in', (tester) async {
      when(() => signup.post('/signup', any())).thenThrow(ApiException(
            code: 'DUPLICATE', status: 409, details: {'field': 'slug'}, message: 'Tên miền phụ này đã có người dùng, vui lòng chọn tên khác.'));
      final c = await pumpApp(tester);
      await tapKey(tester, 'welcome-signup');
      await fill(tester);
      await tapKey(tester, 'signup-submit');
      expect(find.text('Tên miền phụ này đã có người dùng, vui lòng chọn tên khác.'), findsOneWidget);
      expect(location(c), '/signup');
      expect(c.read(authProvider), isA<SignedOut>());
    });

    testWidgets('sign-up closed on the server: said plainly, no form', (tester) async {
      when(() => signup.get('/signup', query: any(named: 'query'), useCache: any(named: 'useCache')))
          .thenAnswer((_) async => {'open': false, 'base_domain': 'tasotek.test'});
      await pumpApp(tester);
      await tapKey(tester, 'welcome-signup');
      expect(find.textContaining('Đăng ký quán mới đang tạm đóng'), findsOneWidget);
      expect(find.byKey(const ValueKey('signup-submit')), findsNothing);
    });
  });

  group('Dùng trên máy này', () {
    testWidgets('setup creates the blank local shop, signs in, and only the local screens are offered', (tester) async {
      // sqflite_common_ffi needs the real event loop: the file is opened outside the fake clock first, and the
      // screens are then pumped frame by frame (a spinner never settles while SQLite works).
      expect(await tester.runAsync(localDb.isSetUp), isFalse);
      final c = await pumpApp(tester, localApi: true);
      await tapKey(tester, 'welcome-local');
      await enter(tester, 'local-shop', 'Quán Mộc');
      await enter(tester, 'local-name', 'Chủ Quán');
      await enter(tester, 'local-password', 'mat-khau-dai-1');
      await enter(tester, 'local-password2', 'khac-nhau-123');
      await tapKey(tester, 'local-submit');
      expect(find.text('Hai lần nhập mật khẩu chưa giống nhau.'), findsOneWidget);
      expect(c.read(appModeProvider), AppMode.unset, reason: 'nothing created yet');

      await enter(tester, 'local-password2', 'mat-khau-dai-1');
      await tester.ensureVisible(find.byKey(const ValueKey('local-submit')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('local-submit')));
      await frames(tester);
      expect(await tester.runAsync(localDb.isSetUp), isTrue);
      expect(await tester.runAsync(() => localDb.meta('shop.name')), 'Quán Mộc');
      expect(c.read(appModeProvider), AppMode.local);
      expect(c.read(localReadyProvider), isTrue);
      expect((c.read(authProvider) as SignedIn).user.username, 'admin');
      expect(location(c), '/dashboard');
      expect(find.byType(DashboardScreen), findsOneWidget);
      // Bottom bar without "Kho"; stock screens lead back home.
      expect(find.widgetWithText(NavigationDestination, 'Kho'), findsNothing);
      expect(find.widgetWithText(NavigationDestination, 'Đơn hàng'), findsOneWidget);
      c.read(routerProvider).go('/inventory');
      await frames(tester);
      expect(location(c), '/dashboard');

      // The sample menu is on the POS.
      final pos = (await tester.runAsync(() => c.read(apiProvider).get('/pos/bootstrap')))!;
      expect((pos['products'] as List).length, 7);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('Cài đặt › "Xóa toàn bộ dữ liệu trên máy" deletes the local shop and returns to the welcome page', (tester) async {
      await localDb.setUp(shopName: 'Quán Mộc', fullName: 'Chủ Quán', username: 'admin', password: 'mat-khau-dai-1');
      FlutterSecureStorage.setMockInitialValues({'auth_token': 'local'});
      final c = await pumpApp(tester, localApi: true, prefs: {
        'app_mode': 'local',
        kLocalReady: true,
        'auth_user': jsonEncode({'id': 1, 'username': 'admin', 'full_name': 'Chủ Quán', 'role': 'admin'}),
      });
      expect(location(c), '/dashboard');
      c.read(routerProvider).push('/settings');
      await tester.pumpAndSettle();
      expect(find.text('Dữ liệu trên máy này'), findsOneWidget);
      expect(find.text('Địa chỉ máy chủ'), findsNothing, reason: 'no server in local mode');
      expect(find.text('Tài khoản nhân viên'), findsNothing);

      await tapKey(tester, 'wipe-local');
      await tester.tap(find.text('Đồng ý'));
      await frames(tester);
      expect(location(c), '/welcome');
      expect(c.read(appModeProvider), AppMode.unset);
      expect(c.read(localReadyProvider), isFalse);
      expect(c.read(authProvider), isA<SignedOut>());
      expect(await tester.runAsync(c.read(localDbProvider).isSetUp), isFalse);
    });
  });

  group('Xóa tài khoản (server)', () {
    Future<ProviderContainer> signedInAdmin(WidgetTester tester) async {
      FlutterSecureStorage.setMockInitialValues({'auth_token': 'tok'});
      when(() => api.get('/auth/me', query: any(named: 'query'))).thenAnswer((_) async => {
            'user': {'id': 1, 'username': 'boss', 'full_name': 'Chủ Quán', 'role': 'admin', 'is_active': 1, 'must_change_password': false},
          });
      return pumpApp(tester, prefs: {
        'app_mode': 'server',
        'server_url': 'https://quan-moc.tasotek.test',
        'auth_user': jsonEncode({'id': 1, 'username': 'boss', 'full_name': 'Chủ Quán', 'role': 'admin'}),
      });
    }

    testWidgets('an admin of a signed-up shop deletes it from Cài đặt (password + sub-domain)', (tester) async {
      when(() => api.get('/account', query: any(named: 'query'), useCache: any(named: 'useCache'))).thenAnswer((_) async => {
            'deletable': true, 'shop': {'slug': 'quan-moc', 'name': 'Quán Mộc'}, 'grace_days': 30, 'reason': null,
          });
      when(() => api.post('/account/delete', any())).thenAnswer((_) async => {'ok': true, 'slug': 'quan-moc', 'grace_days': 30});
      final c = await signedInAdmin(tester);
      c.read(routerProvider).push('/settings');
      await tester.pumpAndSettle();
      expect(find.text('Xóa tài khoản và dữ liệu'), findsOneWidget);

      await tapKey(tester, 'delete-account');
      final submit = find.byKey(const ValueKey('delete-submit'));
      expect(tester.widget<FilledButton>(submit).onPressed, isNull, reason: 'needs the password and the sub-domain');
      await tester.enterText(find.byKey(const ValueKey('delete-password')), 'mat-khau-dai-1');
      await tester.enterText(find.byKey(const ValueKey('delete-confirm')), 'quan-moc');
      await tester.pump();
      await tester.tap(submit);
      await tester.pumpAndSettle();
      verify(() => api.post('/account/delete', {'password': 'mat-khau-dai-1', 'confirm': 'quan-moc'})).called(1);
      expect(find.text('Đã nhận yêu cầu xóa'), findsOneWidget);
      await tester.tap(find.text('Đóng'));
      await tester.pumpAndSettle();
      expect(c.read(authProvider), isA<SignedOut>());
      expect(location(c), '/welcome');
    });

    testWidgets('a shop not created by sign-up points to the web page instead of a button', (tester) async {
      when(() => api.get('/account', query: any(named: 'query'), useCache: any(named: 'useCache'))).thenAnswer((_) async => {
            'deletable': false, 'shop': null, 'grace_days': 30, 'reason': 'not_signup_shop',
          });
      final c = await signedInAdmin(tester);
      c.read(routerProvider).push('/settings');
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Xóa tài khoản và dữ liệu'));
      expect(find.byKey(const ValueKey('delete-account')), findsNothing);
      expect(find.textContaining('xoa-tai-khoan'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
