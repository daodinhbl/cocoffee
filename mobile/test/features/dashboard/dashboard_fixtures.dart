import 'package:cocoffee_mobile/core/session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:cocoffee_mobile/core/theme/app_theme.dart';
import 'package:cocoffee_mobile/features/dashboard/dashboard_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../helpers/test_app.dart';

/// GET /api/admin/dashboard as the backend contract describes it (snake_case, raw numbers, ISO dates).
Map<String, dynamic> dashboardJson() => {
      'day': '2026-10-14',
      'today': {'orders': 23, 'revenue': 1250000, 'cogs': 437500, 'gross_profit': 812500, 'unpaid': 90000},
      'yesterday': {'orders': 19, 'revenue': 1000000, 'cogs': 360000, 'gross_profit': 640000, 'unpaid': 0},
      'margin': 65,
      'counts': {'drafts': 2, 'open_orders': 3, 'unpaid': 4},
      'recent_orders': [
        {
          'id': 41, 'order_code': 'CF261014-00041', 'source': 'zalo', 'status': 'completed', 'payment_status': 'unpaid',
          'payment_method': null, 'total': 90000, 'created_at': '2026-10-14T02:15:00.000Z', 'table_code': null,
        },
        {
          'id': 40, 'order_code': 'CF261014-00040', 'source': 'pos', 'status': 'open', 'payment_status': 'unpaid',
          'total': 45000, 'created_at': '2026-10-14T02:05:00.000Z', 'table_code': 'B02',
        },
        {
          'id': 39, 'order_code': 'CF261014-00039', 'source': 'pos', 'status': 'completed', 'payment_status': 'paid',
          'payment_method': 'cash', 'total': 120000, 'created_at': '2026-10-14T01:40:00.000Z',
        },
        {
          'id': 38, 'order_code': 'CF261014-00038', 'source': 'zalo', 'status': 'draft', 'payment_status': 'unpaid',
          'total': 35000, 'created_at': '2026-10-14T01:20:00.000Z',
        },
        {
          'id': 37, 'order_code': 'CF261014-00037', 'source': 'pos', 'status': 'cancelled', 'payment_status': 'unpaid',
          'total': 0, 'created_at': '2026-10-14T00:55:00.000Z',
        },
      ],
      'low_stock': [
        {'id': 3, 'name': 'Sữa tươi', 'unit': 'ml', 'quantity_on_hand': 800, 'min_stock': 2000, 'ratio': 0.4},
        {'id': 7, 'name': 'Cà phê hạt', 'unit': 'g', 'quantity_on_hand': 1500, 'min_stock': 2000, 'ratio': 0.75},
      ],
      'hourly': [
        for (var h = 6; h <= 22; h++)
          {
            'hour': h,
            'revenue': switch (h) { 7 => 180000, 8 => 310000, 9 => 125000, 10 => 95000, 12 => 240000, 14 => 300000, _ => 0 },
            'orders': switch (h) { 7 => 5, 8 => 8, 9 => 4, 10 => 2, 12 => 6, 14 => 7, _ => 0 },
          },
      ],
      'best_sellers': [
        {'product_id': 1, 'product_name': 'Cà phê sữa đá', 'qty': 132, 'revenue': 3960000},
        {'product_id': 2, 'product_name': 'Bạc xỉu', 'qty': 87, 'revenue': 2610000},
        {'product_id': 5, 'product_name': 'Trà đào cam sả', 'qty': 41, 'revenue': 1845000},
      ],
      'overstock': [
        {'id': 9, 'name': 'Đường cát', 'unit': 'kg', 'qty': 25, 'value': 550000, 'cover': 5},
        {'id': 10, 'name': 'Ly nhựa 500ml', 'unit': 'cái', 'qty': 1200, 'value': 480000, 'cover': null},
      ],
      'debtors': [
        {
          'customer_id': 5, 'customer_name': 'Chị Lan', 'customer_phone': '0901234567', 'zalo_user_id': 'z9001',
          'orders': 3, 'amount': 255000, 'oldest': '2026-10-10T03:00:00.000Z',
        },
        {
          'customer_id': null, 'customer_name': null, 'customer_phone': null, 'zalo_user_id': '8812345678',
          'orders': 1, 'amount': 45000, 'oldest': '2026-10-13T09:30:00.000Z',
        },
      ],
    };

/// A quiet morning: nothing sold yet, nothing low, nobody owes.
Map<String, dynamic> emptyDashboardJson() => {
      'day': '2026-10-14',
      'today': {'orders': 0, 'revenue': 0, 'cogs': 0, 'gross_profit': 0, 'unpaid': 0},
      'yesterday': {'orders': 0, 'revenue': 0, 'cogs': 0, 'gross_profit': 0, 'unpaid': 0},
      'margin': 0,
      'counts': {'drafts': 0, 'open_orders': 0, 'unpaid': 0},
      'recent_orders': <Object>[],
      'low_stock': <Object>[],
      'hourly': [for (var h = 6; h <= 22; h++) {'hour': h, 'revenue': 0, 'orders': 0}],
      'best_sellers': <Object>[],
      'overstock': <Object>[],
      'debtors': <Object>[],
    };

/// GET /api/admin/notifications
Map<String, dynamic> notificationsJson() => {
      'low_stock': [
        {'id': 3, 'name': 'Sữa tươi', 'unit': 'ml', 'quantity_on_hand': 800, 'min_stock': 2000},
        {'id': 7, 'name': 'Cà phê hạt', 'unit': 'g', 'quantity_on_hand': 1500, 'min_stock': 2000},
      ],
      'counts': {'drafts': 2, 'open_orders': 3, 'unpaid': 4},
      'receipt_errors': [
        {'id': 41, 'order_code': 'CF261014-00041', 'receipt_error': 'Zalo token expired', 'completed_at': '2026-10-14T02:20:00.000Z'},
      ],
    };

Map<String, dynamic> emptyNotificationsJson() => {
      'low_stock': <Object>[],
      'counts': {'drafts': 0, 'open_orders': 0, 'unpaid': 0},
      'receipt_errors': <Object>[],
    };

MockApi stubbedApi({
  Map<String, dynamic>? dashboard,
  Map<String, dynamic>? notifications,
  Map<String, dynamic>? zalo,
}) {
  final api = MockApi();
  when(() => api.get('/admin/dashboard', query: any(named: 'query'))).thenAnswer((_) async => dashboard ?? dashboardJson());
  when(() => api.get('/admin/notifications', query: any(named: 'query')))
      .thenAnswer((_) async => notifications ?? notificationsJson());
  when(() => api.get('/zalo/status', query: any(named: 'query')))
      .thenAnswer((_) async => zalo ?? {'state': 'ok', 'label': 'Zalo bot OK'});
  return api;
}

/// Like testApp(), but inside a GoRouter so taps that navigate can be checked. Destinations print their URI.
Future<Widget> routerTestApp(MockApi api, {AppUser user = adminUser}) async {
  SharedPreferences.setMockInitialValues({});
  final store = SessionStore(await SharedPreferences.getInstance());
  Widget dest(String text) => Scaffold(body: Center(child: Text(text)));
  final router = GoRouter(
    initialLocation: '/dashboard',
    routes: [
      GoRoute(path: '/dashboard', builder: (_, _) => const DashboardScreen()),
      GoRoute(path: '/orders', builder: (_, s) => dest('route ${s.uri}')),
      GoRoute(path: '/orders/:id', builder: (_, s) => dest('route ${s.uri}')),
      GoRoute(path: '/inventory', builder: (_, s) => dest('route ${s.uri}')),
      GoRoute(path: '/inventory/:id', builder: (_, s) => dest('route ${s.uri}')),
      GoRoute(path: '/receiving', builder: (_, s) => dest('route ${s.uri}')),
      GoRoute(path: '/pos', builder: (_, s) => dest('route ${s.uri}')),
      GoRoute(path: '/tables', builder: (_, s) => dest('route ${s.uri}')),
      GoRoute(path: '/reports', builder: (_, s) => dest('route ${s.uri}')),
    ],
  );
  addTearDown(router.dispose);
  return ProviderScope(
    overrides: [
      sessionStoreProvider.overrideWithValue(store),
      apiProvider.overrideWithValue(api),
      currentUserProvider.overrideWithValue(user),
    ],
    child: MaterialApp.router(
      theme: buildTheme(Brightness.light),
      locale: const Locale('vi'),
      supportedLocales: const [Locale('vi')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      routerConfig: router,
    ),
  );
}
