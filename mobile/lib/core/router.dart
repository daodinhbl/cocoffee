import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/change_password_screen.dart';
import '../features/auth/login_screen.dart';
import '../features/bom/bom_screen.dart';
import '../features/customers/customer_detail_screen.dart';
import '../features/customers/customers_screen.dart';
import '../features/dashboard/dashboard_screen.dart';
import '../features/finance/expenses_screen.dart';
import '../features/finance/finance_screen.dart';
import '../features/heli/heli_screen.dart';
import '../features/inventory/inventory_data.dart';
import '../features/inventory/inventory_detail_screen.dart';
import '../features/inventory/inventory_screen.dart';
import '../features/inventory/receiving_screen.dart';
import '../features/menu/menu_screen.dart';
import '../features/more/more_screen.dart';
import '../features/orders/order_detail_screen.dart';
import '../features/orders/orders_providers.dart';
import '../features/orders/orders_screen.dart';
import '../features/pos/pos_screen.dart';
import '../features/reports/reports_screen.dart';
import '../features/settings/settings_screen.dart';
import '../features/sync/sync_screen.dart';
import '../features/tables/tables_screen.dart';
import '../features/zalo/zalo_screen.dart';
import 'session.dart';
import 'widgets/app_shell.dart';

final _rootKey = GlobalKey<NavigatorState>(debugLabel: 'root');

int _id(GoRouterState s) => int.tryParse(s.pathParameters['id'] ?? '') ?? 0;

final _orderDetail = RegExp(r'^/orders/\d+$');

/// What a cashier may open. The Web Admin gives a cashier only the POS screen (authPages.js, adminAuth.js); the app
/// adds the order page (GET /api/orders/:id is open to any staff), Cài đặt (own password, app info) and the offline sync screen.
bool cashierAllowed(String path) => path == '/pos' || path == '/settings' || path == '/sync' || path == '/heli' || _orderDetail.hasMatch(path);

/// The router's guard as a pure function of the signed-in [user] and the requested [path] (no query string).
/// Returns where to go instead, or null to stay.
///  - signed out: only /login;
///  - "must change password" (admin with a factory / short password): only /change-password, like the web's
///    /admin/settings/password gate (every other API call answers 403 MUST_CHANGE_PASSWORD);
///  - /login, / and a finished /change-password lead to the account's home: /dashboard (admin), /pos (cashier);
///  - a cashier asking for any other screen (the bottom-bar sections, management screens) goes to /pos.
String? redirectFor(AppUser? user, String path) {
  if (user == null) return path == '/login' ? null : '/login';
  if (user.mustChangePassword) return path == '/change-password' ? null : '/change-password';
  if (path == '/login' || path == '/' || path.isEmpty || path == '/change-password') return user.home;
  if (!user.isAdmin && !cashierAllowed(path)) return '/pos';
  return null;
}

/// First location for [user] (the redirect would get there too; this avoids building the dashboard for a cashier).
String startLocation(AppUser? user) => user == null ? '/login' : (user.mustChangePassword ? '/change-password' : user.home);

/// Routes mirror the Web Admin URLs (/admin/... without the prefix). The five bottom-bar sections are branches
/// of a StatefulShellRoute (each keeps its own stack); everything else is pushed above the shell.
final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen(authProvider, (_, _) => refresh.value++);

  // Read authProvider itself, not currentUserProvider: the redirect runs inside the authProvider notification,
  // before derived providers have caught up.
  AppUser? user() => switch (ref.read(authProvider)) { SignedIn(:final user) => user, SignedOut() => null };
  ref.onDispose(refresh.dispose);

  return GoRouter(
    navigatorKey: _rootKey,
    initialLocation: startLocation(user()),
    refreshListenable: refresh,
    redirect: (context, state) => redirectFor(user(), state.uri.path),
    routes: [
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/change-password', builder: (_, _) => const ChangePasswordScreen()),
      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => AppShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [GoRoute(path: '/dashboard', builder: (_, _) => const DashboardScreen())]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/orders',
              builder: (_, s) =>
                  _LinkQuery(path: '/orders', query: s.uri.queryParameters, apply: _applyOrdersLink, child: const OrdersScreen()),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/inventory',
              builder: (_, s) =>
                  _LinkQuery(path: '/inventory', query: s.uri.queryParameters, apply: _applyInventoryLink, child: const InventoryScreen()),
            ),
          ]),
          StatefulShellBranch(routes: [GoRoute(path: '/reports', builder: (_, _) => const ReportsScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/more', builder: (_, _) => const MoreScreen())]),
        ],
      ),
      GoRoute(parentNavigatorKey: _rootKey, path: '/orders/:id', builder: (_, s) => OrderDetailScreen(id: _id(s))),
      GoRoute(parentNavigatorKey: _rootKey, path: '/inventory/:id', builder: (_, s) => InventoryDetailScreen(id: _id(s))),
      GoRoute(
        parentNavigatorKey: _rootKey,
        path: '/receiving',
        builder: (_, s) => ReceivingScreen(itemId: int.tryParse(s.uri.queryParameters['item'] ?? '')),
      ),
      GoRoute(
        parentNavigatorKey: _rootKey,
        path: '/pos',
        builder: (_, s) => PosScreen(
          tableId: int.tryParse(s.uri.queryParameters['table'] ?? ''),
          orderId: int.tryParse(s.uri.queryParameters['order'] ?? ''),
        ),
      ),
      GoRoute(parentNavigatorKey: _rootKey, path: '/tables', builder: (_, _) => const TablesScreen()),
      GoRoute(parentNavigatorKey: _rootKey, path: '/menu', builder: (_, _) => const MenuScreen()),
      GoRoute(parentNavigatorKey: _rootKey, path: '/bom', builder: (_, _) => const BomScreen()),
      GoRoute(parentNavigatorKey: _rootKey, path: '/expenses', builder: (_, _) => const ExpensesScreen()),
      GoRoute(parentNavigatorKey: _rootKey, path: '/finance', builder: (_, _) => const FinanceScreen()),
      GoRoute(parentNavigatorKey: _rootKey, path: '/zalo', builder: (_, _) => const ZaloScreen()),
      GoRoute(parentNavigatorKey: _rootKey, path: '/customers', builder: (_, _) => const CustomersScreen()),
      GoRoute(parentNavigatorKey: _rootKey, path: '/customers/:id', builder: (_, s) => CustomerDetailScreen(id: _id(s))),
      GoRoute(parentNavigatorKey: _rootKey, path: '/settings', builder: (_, _) => const SettingsScreen()),
      GoRoute(parentNavigatorKey: _rootKey, path: '/sync', builder: (_, _) => const SyncScreen()),
      GoRoute(parentNavigatorKey: _rootKey, path: '/heli', builder: (_, _) => const HeliScreen()),
    ],
  );
});

/// /orders?status=completed&payment=unpaid (dashboard and bell links, like the web's): that link's filter, the
/// other filters cleared.
void _applyOrdersLink(WidgetRef ref, Map<String, String> q) {
  final filters = ref.read(ordersFilterProvider.notifier)..clear();
  final status = q['status'], payment = q['payment'];
  for (final tab in OrdersTab.values) {
    if (tab.status == status && tab.payment == payment) filters.setTab(tab);
  }
  final source = q['source'];
  if (source == 'pos' || source == 'zalo') filters.setSource(source);
}

/// /inventory?low=1: the "Sắp hết" pill.
void _applyInventoryLink(WidgetRef ref, Map<String, String> q) {
  ref.listenManual(inventoryFilterProvider, (_, _) {}); // keeps the filter alive while the list is still loading
  ref.read(inventoryFilterProvider.notifier).setLowOnly(q['low'] == '1');
}

/// Bottom-bar sections keep their screen alive, so a link with a query (/orders?status=draft) cannot reach the
/// screen as a constructor argument. This applies the query to the screen's filter state, then drops it from the
/// location so the same link works again later.
class _LinkQuery extends ConsumerStatefulWidget {
  const _LinkQuery({required this.path, required this.query, required this.apply, required this.child});

  final String path;
  final Map<String, String> query;
  final void Function(WidgetRef ref, Map<String, String> query) apply;
  final Widget child;

  @override
  ConsumerState<_LinkQuery> createState() => _LinkQueryState();
}

class _LinkQueryState extends ConsumerState<_LinkQuery> {
  @override
  void initState() {
    super.initState();
    _schedule();
  }

  @override
  void didUpdateWidget(covariant _LinkQuery old) {
    super.didUpdateWidget(old);
    if (!mapEquals(old.query, widget.query)) _schedule();
  }

  void _schedule() {
    if (widget.query.isEmpty) return;
    final query = Map<String, String>.of(widget.query);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.apply(ref, query);
      GoRouter.maybeOf(context)?.go(widget.path);
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
