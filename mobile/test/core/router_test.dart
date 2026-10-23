import 'package:cocoffee_mobile/app.dart';
import 'package:cocoffee_mobile/core/app_mode.dart';
import 'package:cocoffee_mobile/core/router.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/features/auth/change_password_screen.dart';
import 'package:cocoffee_mobile/features/auth/login_screen.dart';
import 'package:cocoffee_mobile/features/dashboard/dashboard_screen.dart';
import 'package:cocoffee_mobile/features/onboarding/welcome_screen.dart';
import 'package:cocoffee_mobile/features/orders/order_detail_screen.dart';
import 'package:cocoffee_mobile/features/pos/pos_screen.dart';
import 'package:cocoffee_mobile/features/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../features/dashboard/dashboard_fixtures.dart';
import '../features/pos/pos_test_data.dart';
import '../helpers/test_app.dart';

/// Auth state driven by the test (sign in / out without the API).
class _TestAuth extends AuthNotifier {
  _TestAuth(this._initial);
  final AuthState _initial;

  @override
  AuthState build() => _initial;

  void set(AuthState next) => state = next;
}

const _weakAdmin = AppUser(id: 1, username: 'admin', fullName: 'Chủ Quán', role: 'admin', mustChangePassword: true);

void main() {
  group('redirectFor (pure guard)', () {
    test('signed out: everything goes to /login', () {
      expect(redirectFor(null, '/login'), isNull);
      for (final p in ['/', '/dashboard', '/pos', '/orders/3', '/settings', '/change-password']) {
        expect(redirectFor(null, p), '/login', reason: p);
      }
    });

    test('admin lands on /dashboard and may open every screen', () {
      expect(redirectFor(adminUser, '/login'), '/dashboard');
      expect(redirectFor(adminUser, '/'), '/dashboard');
      expect(redirectFor(adminUser, '/change-password'), '/dashboard');
      for (final p in [
        '/dashboard', '/orders', '/orders/12', '/inventory', '/inventory/2', '/receiving', '/reports', '/more', '/pos',
        '/tables', '/menu', '/customers', '/customers/5', '/settings',
      ]) {
        expect(redirectFor(adminUser, p), isNull, reason: p);
      }
    });

    test('cashier lands on /pos; shell and admin screens redirect to /pos', () {
      expect(redirectFor(cashierUser, '/login'), '/pos');
      expect(redirectFor(cashierUser, '/'), '/pos');
      for (final p in [
        '/dashboard', '/orders', '/inventory', '/reports', '/more', // bottom-bar sections
        '/inventory/2', '/receiving', '/tables', '/menu', '/customers', '/customers/5', '/change-password',
      ]) {
        expect(redirectFor(cashierUser, p), '/pos', reason: p);
      }
      for (final p in ['/pos', '/settings', '/orders/12']) {
        expect(redirectFor(cashierUser, p), isNull, reason: p);
      }
      expect(redirectFor(cashierUser, '/orders/abc'), '/pos');
    });

    test('a "must change password" token only reaches /change-password', () {
      expect(redirectFor(_weakAdmin, '/change-password'), isNull);
      for (final p in ['/login', '/', '/dashboard', '/pos', '/settings', '/orders/1']) {
        expect(redirectFor(_weakAdmin, p), '/change-password', reason: p);
      }
    });

    test('start location per account', () {
      expect(startLocation(null), '/login');
      expect(startLocation(adminUser), '/dashboard');
      expect(startLocation(cashierUser), '/pos');
      expect(startLocation(_weakAdmin), '/change-password');
    });

    test('new install: the welcome page and its screens; a server install keeps /login', () {
      for (final p in ['/', '/dashboard', '/pos', '/settings']) {
        expect(redirectFor(null, p, mode: AppMode.unset), '/welcome', reason: p);
      }
      for (final p in ['/welcome', '/signup', '/local-setup', '/login']) {
        expect(redirectFor(null, p, mode: AppMode.unset), isNull, reason: p);
        expect(redirectFor(null, p), isNull, reason: 'server install, signed out: $p is reachable');
      }
      expect(startLocation(null, mode: AppMode.unset), '/welcome');
      expect(startLocation(null), '/login');
      expect(redirectFor(adminUser, '/welcome'), '/dashboard', reason: 'signed in: the first-run screens lead home');
      expect(redirectFor(adminUser, '/signup'), '/dashboard');
    });

    test('local mode: setup first, then the local login, and only the screens the phone serves', () {
      expect(redirectFor(null, '/dashboard', mode: AppMode.local), '/local-setup');
      expect(redirectFor(null, '/login', mode: AppMode.local), '/local-setup');
      expect(redirectFor(null, '/local-setup', mode: AppMode.local), isNull);
      expect(redirectFor(null, '/dashboard', mode: AppMode.local, localReady: true), '/login');
      expect(redirectFor(null, '/local-setup', mode: AppMode.local, localReady: true), '/login');
      expect(startLocation(null, mode: AppMode.local, localReady: true), '/login');
      for (final p in ['/dashboard', '/pos', '/orders', '/orders/3', '/menu', '/reports', '/more', '/settings']) {
        expect(redirectFor(adminUser, p, mode: AppMode.local, localReady: true), isNull, reason: p);
      }
      for (final p in ['/inventory', '/inventory/2', '/tables', '/customers', '/bom', '/receiving', '/expenses', '/finance', '/zalo', '/heli', '/sync']) {
        expect(redirectFor(adminUser, p, mode: AppMode.local, localReady: true), '/dashboard', reason: p);
      }
    });

    test('AppUser keeps must_change_password through the session cache', () {
      final u = AppUser.fromJson({'id': 1, 'username': 'admin', 'full_name': 'A', 'role': 'admin', 'must_change_password': true});
      expect(u.mustChangePassword, isTrue);
      expect(AppUser.fromJson(u.toJson()).mustChangePassword, isTrue);
      expect(AppUser.fromJson(u.copyWith(mustChangePassword: false).toJson()).mustChangePassword, isFalse);
      expect(AppUser.fromJson({'id': 2, 'username': 'x', 'role': 'cashier'}).mustChangePassword, isFalse);
    });
  });

  group('real router', () {
    late MockApi api;

    setUp(() {
      FlutterSecureStorage.setMockInitialValues({});
      api = stubbedApi(dashboard: emptyDashboardJson(), notifications: emptyNotificationsJson());
      stubPosReads(api);
      when(() => api.get('/orders/12', query: any(named: 'query'))).thenAnswer((_) async => {
            'order': {'id': 12, 'order_code': 'CF261014-00012', 'status': 'completed', 'payment_status': 'paid', 'source': 'pos', 'total': 25000, 'items': const []},
            'payments': const [],
          });
    });

    // An install from before the welcome page (mode "server"), unless [prefs] says otherwise.
    Future<(ProviderContainer, _TestAuth)> pumpApp(WidgetTester tester, AuthState initial, {Map<String, Object> prefs = const {'app_mode': 'server'}}) async {
      SharedPreferences.setMockInitialValues(prefs);
      final store = SessionStore(await SharedPreferences.getInstance());
      final auth = _TestAuth(initial);
      final container = ProviderContainer(overrides: [
        sessionStoreProvider.overrideWithValue(store),
        apiProvider.overrideWithValue(api),
        authProvider.overrideWith(() => auth),
      ]);
      addTearDown(container.dispose);
      await setSurface(tester, phone);
      await tester.pumpWidget(UncontrolledProviderScope(container: container, child: const CoCoffeeApp()));
      await tester.pumpAndSettle();
      return (container, auth);
    }

    String location(ProviderContainer c) => c.read(routerProvider).routerDelegate.currentConfiguration.uri.path;

    Future<void> go(WidgetTester tester, ProviderContainer c, String to) async {
      c.read(routerProvider).go(to);
      await tester.pumpAndSettle();
    }

    Future<void> unmount(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox()); // stops the POS polling timer
    }

    testWidgets('cashier starts on POS and cannot open the management screens', (tester) async {
      final (c, _) = await pumpApp(tester, const SignedIn(cashierUser));
      expect(location(c), '/pos');
      expect(find.byType(PosScreen), findsOneWidget);
      verifyNever(() => api.get('/admin/dashboard', query: any(named: 'query')));

      for (final p in ['/dashboard', '/orders', '/inventory', '/reports', '/more', '/customers', '/tables', '/menu', '/receiving']) {
        await go(tester, c, p);
        expect(location(c), '/pos', reason: p);
      }
      verifyNever(() => api.get('/admin/dashboard', query: any(named: 'query')));

      await go(tester, c, '/orders/12');
      expect(location(c), '/orders/12');
      expect(find.byType(OrderDetailScreen), findsOneWidget);

      await go(tester, c, '/settings');
      expect(location(c), '/settings');
      expect(find.byType(SettingsScreen), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('a new install opens the welcome page; "Đăng nhập quán có sẵn" leads to /login', (tester) async {
      final (c, _) = await pumpApp(tester, const SignedOut(), prefs: const {});
      expect(location(c), '/welcome');
      expect(find.byType(WelcomeScreen), findsOneWidget);
      await go(tester, c, '/dashboard');
      expect(location(c), '/welcome');

      await tester.tap(find.byKey(const ValueKey('welcome-login')));
      await tester.pumpAndSettle();
      expect(location(c), '/login');
      expect(c.read(appModeProvider), AppMode.server);

      await tester.ensureVisible(find.byKey(const ValueKey('login-choose-again')));
      await tester.tap(find.byKey(const ValueKey('login-choose-again')));
      await tester.pumpAndSettle();
      expect(location(c), '/welcome');
      expect(c.read(appModeProvider), AppMode.unset);
      await unmount(tester);
    });

    testWidgets('admin starts on the dashboard and reaches admin screens', (tester) async {
      final (c, _) = await pumpApp(tester, const SignedIn(adminUser));
      expect(location(c), '/dashboard');
      expect(find.byType(DashboardScreen), findsOneWidget);

      await go(tester, c, '/pos');
      expect(location(c), '/pos');
      await go(tester, c, '/settings');
      expect(location(c), '/settings');
      await unmount(tester);
    });

    testWidgets('sign-in goes to the role home, sign-out back to /login', (tester) async {
      final (c, auth) = await pumpApp(tester, const SignedOut());
      expect(location(c), '/login');
      expect(find.byType(LoginScreen), findsOneWidget);

      auth.set(const SignedIn(cashierUser));
      await tester.pumpAndSettle();
      expect(location(c), '/pos');

      auth.set(const SignedOut());
      await tester.pumpAndSettle();
      expect(location(c), '/login');

      auth.set(const SignedIn(adminUser));
      await tester.pumpAndSettle();
      expect(location(c), '/dashboard');
      await unmount(tester);
    });

    testWidgets('"must change password" keeps the admin on Đổi mật khẩu until the change succeeds', (tester) async {
      when(() => api.post('/auth/change-password', any())).thenAnswer((_) async => {'ok': true, 'token': 'tok-new'});
      final (c, auth) = await pumpApp(tester, const SignedIn(_weakAdmin));
      expect(location(c), '/change-password');
      expect(find.byType(ChangePasswordScreen), findsOneWidget);
      verifyNever(() => api.get('/admin/dashboard', query: any(named: 'query')));

      await go(tester, c, '/dashboard');
      expect(location(c), '/change-password');

      await tester.enterText(find.byType(TextFormField).at(0), 'admin');
      await tester.enterText(find.byType(TextFormField).at(1), 'caphe-sua-da-2026');
      await tester.enterText(find.byType(TextFormField).at(2), 'caphe-sua-da-2026');
      await tester.tap(find.widgetWithText(FilledButton, 'Đổi mật khẩu'));
      await tester.pumpAndSettle();

      expect(c.read(sessionStoreProvider).token, 'tok-new');
      expect((auth.state as SignedIn).user.mustChangePassword, isFalse);
      expect(location(c), '/dashboard');
      await unmount(tester);
    });

    testWidgets('a stored session re-reads /auth/me at start: a role changed in the Web Admin moves the account', (tester) async {
      when(() => api.get('/auth/me', query: any(named: 'query'))).thenAnswer((_) async => {
            'user': {'id': 1, 'username': 'boss', 'full_name': 'Chủ Quán', 'role': 'cashier', 'is_active': 1, 'must_change_password': false},
          });
      final (c, auth) = await pumpApp(tester, const SignedIn(adminUser));
      verify(() => api.get('/auth/me', query: any(named: 'query'))).called(1);
      expect((auth.state as SignedIn).user.isAdmin, isFalse);
      expect(location(c), '/pos');
      await unmount(tester);
    });

    testWidgets('dashboard links with a query filter the section, then the query is dropped', (tester) async {
      when(() => api.get('/orders', query: any(named: 'query'))).thenAnswer((_) async => {
            'orders': const [], 'total': 0, 'page': 1, 'pages': 1, 'page_size': 25,
            'counts': {'all': 0, 'draft': 0, 'open': 0, 'completed': 0, 'cancelled': 0, 'unpaid': 0, 'revenue': 0, 'unpaidAmount': 0, 'openAmount': 0},
          });
      final (c, _) = await pumpApp(tester, const SignedIn(adminUser));
      await go(tester, c, '/orders?status=completed&payment=unpaid');
      expect(location(c), '/orders');
      expect(c.read(routerProvider).routerDelegate.currentConfiguration.uri.query, isEmpty);
      final queries = verify(() => api.get('/orders', query: captureAny(named: 'query'))).captured.cast<Map<String, dynamic>>();
      expect(queries.last['status'], 'completed');
      expect(queries.last['payment'], 'unpaid');
      await unmount(tester);
    });
  });
}
