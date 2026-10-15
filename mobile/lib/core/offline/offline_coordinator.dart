import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/customers/customer_providers.dart';
import '../../features/dashboard/dashboard_providers.dart';
import '../../features/inventory/inventory_data.dart';
import '../../features/menu/menu_models.dart';
import '../../features/orders/orders_providers.dart';
import '../../features/pos/pos_providers.dart';
import '../../features/reports/report_providers.dart';
import '../../features/settings/settings_models.dart';
import '../../features/tables/table_models.dart';
import '../session.dart';
import 'connectivity.dart';
import 'outbox.dart';
import 'snapshot_sync.dart';

/// Every read provider of the app. Invalidating them makes the screens that are open fetch again (the ones that
/// are not open are not alive, so nothing is fetched for them).
final List<dynamic> readProviders = [
  posBootstrapProvider,
  zaloDraftsProvider,
  zaloUnpaidProvider,
  posOrderProvider,
  dashboardProvider,
  notificationsProvider,
  zaloStatusProvider,
  ordersPageProvider,
  orderDetailProvider,
  inventoryListProvider,
  inventoryDetailProvider,
  receivingItemsProvider,
  purchasesProvider,
  menuDataProvider,
  customersPageProvider,
  customerDetailProvider,
  reconciliationProvider,
  reportProvider,
  adminSettingsProvider,
  staffUsersProvider,
  tablesProvider,
];

void refreshAll(Ref ref) {
  for (final p in readProviders) {
    ref.invalidate(p);
  }
}

/// Same, from a widget.
void refreshAllFrom(WidgetRef ref) {
  for (final p in readProviders) {
    ref.invalidate(p);
  }
}

/// Keeps the offline machinery running for the whole app: when the server becomes reachable again the queued
/// writes are replayed and the open screens refreshed; the queue is loaded at start (it replays itself when
/// something waits). Watched once by the app widget; the widget also probes on resume.
final offlineCoordinatorProvider = Provider<void>((ref) {
  ref.listen<NetState>(netProvider, (prev, next) {
    if (prev != null && !prev.online && next.online) {
      ref.read(outboxProvider.notifier).sync();
      refreshAll(ref);
      ref.read(snapshotSyncProvider.notifier).sync();
    }
  });
  // Queued writes were replayed: take a fresh copy so the offline database matches the server again.
  ref.listen<OutboxState>(outboxProvider, (prev, next) {
    if (prev != null && prev.syncing && !next.syncing) ref.read(snapshotSyncProvider.notifier).sync();
  });
  // Signed in (at start, or just logged in): first copy of the shop's data.
  ref.listen<AuthState>(authProvider, (prev, next) {
    if (next is SignedIn) Future<void>.microtask(() => ref.read(snapshotSyncProvider.notifier).sync());
  }, fireImmediately: true);
  ref.read(outboxProvider);
});
