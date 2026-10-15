import 'dart:convert';

import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/offline/connectivity.dart';
import 'package:cocoffee_mobile/core/offline/local_store.dart';
import 'package:cocoffee_mobile/core/offline/offline_db.dart';
import 'package:cocoffee_mobile/core/offline/offline_effects.dart';
import 'package:cocoffee_mobile/core/offline/offline_resolver.dart';
import 'package:cocoffee_mobile/core/offline/offline_writer.dart';
import 'package:cocoffee_mobile/core/offline/outbox.dart';
import 'package:cocoffee_mobile/core/offline/snapshot_sync.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../helpers/test_app.dart';

Map<String, dynamic> order(int id, {int? customer, String pay = 'unpaid', double total = 50000, String at = '2026-10-13T03:00:00.000Z'}) => {
      'id': id, 'order_code': 'CF-$id', 'source': 'zalo', 'status': 'completed', 'payment_status': pay, 'total': total,
      'customer_id': customer, 'table_id': null, 'created_at': at, 'items': [], 'payments': [],
    };

Map<String, dynamic> snapshot() => {
      'generated_at': '2026-10-13T04:00:00.000Z',
      'role': 'admin',
      'categories': [
        {'id': 1, 'code': 'drink', 'name': 'Đồ uống', 'sort_order': 1, 'is_active': 1},
      ],
      'products': [
        {'id': 1, 'category_id': 1, 'sku': 'A', 'name': 'Trà sữa', 'price': 1, 'is_active': 1},
        {'id': 2, 'category_id': 1, 'sku': 'B', 'name': 'trà đào', 'price': 1, 'is_active': 1},
        {'id': 3, 'category_id': 1, 'sku': 'C', 'name': 'Cacao', 'price': 1, 'is_active': 1},
        {'id': 4, 'category_id': 1, 'sku': 'D', 'name': 'Cà phê đen', 'price': 1, 'is_active': 1},
      ],
      'tables': [
        {'id': 1, 'code': 'B01', 'name': 'Bàn 1', 'status': 'available', 'is_active': 0},
        {'id': 2, 'code': 'B02', 'name': 'Bàn 2', 'status': 'available', 'is_active': 1},
      ],
      'inventory': {
        'items': [
          {'id': 1, 'name': 'Sữa', 'sku': 'ZZ', 'is_active': 1, 'is_low': 0, 'quantity_on_hand': 10, 'avg_cost': 100, 'min_stock': 1, 'stock_value': 1000},
          {'id': 2, 'name': 'Sữa chua', 'sku': 'AA', 'is_active': 1, 'is_low': 0, 'quantity_on_hand': 5, 'avg_cost': 200, 'min_stock': 1, 'stock_value': 1000},
        ],
        'stock_value': 2000,
      },
      'customers': [
        {'id': 5, 'name': 'Chị Lan', 'balance': 150000, 'order_count': 2, 'updated_at': '2026-10-13T03:00:00.000Z'},
        {'id': 6, 'name': 'Anh Tuấn', 'balance': 0, 'order_count': 0, 'updated_at': '2026-10-13T02:00:00.000Z'},
      ],
      'customer_stats': {'total_customers': 2, 'debt_customers': 1, 'total_debt': 150000},
      'ledgers': {
        '5': [
          {'id': 2, 'entry_type': 'debt', 'amount': 90000},
          {'id': 1, 'entry_type': 'debt', 'amount': 60000},
        ],
      },
      'orders': [
        order(9, customer: 5, total: 90000, at: '2026-10-12T03:00:00.000Z'),
        order(8, customer: 5, total: 60000, at: '2026-10-11T03:00:00.000Z'),
      ],
    };

ApiException net() => ApiException(code: 'OFFLINE', message: 'Mất mạng');
ApiException unauthorized() => ApiException(code: 'UNAUTHORIZED', message: 'hết phiên', status: 401);

void main() {
  sqfliteFfiInit();
  late MockApi api;
  late OfflineDb db;
  late MemoryStore store;

  OfflineDb newDb() => OfflineDb(() => OfflineDb.openAt(databaseFactoryFfi, inMemoryDatabasePath, singleInstance: false));

  Future<ProviderContainer> container({AppUser user = adminUser, OfflineDb? withDb}) async {
    final base = await testContainer(api, user: user, store: store);
    final c = ProviderContainer(overrides: [
      sessionStoreProvider.overrideWithValue(base.read(sessionStoreProvider)),
      apiProvider.overrideWithValue(api),
      currentUserProvider.overrideWithValue(user),
      networkEventsProvider.overrideWithValue(() => const Stream<bool>.empty()),
      localStoreProvider.overrideWithValue(store),
      offlineDbProvider.overrideWithValue(withDb ?? db),
    ]);
    addTearDown(c.dispose);
    return c;
  }

  setUp(() async {
    api = MockApi();
    store = MemoryStore();
    db = newDb();
    await db.replaceSnapshot(snapshot());
  });

  group('Outbox', () {
    test('a failed PUT is retried as a PUT (copyWith keeps the method)', () async {
      final c = await container();
      final outbox = c.read(outboxProvider.notifier);
      await outbox.enqueue(kind: 'customer.update', method: 'PUT', path: '/admin/customers/5', body: const {'name': 'x'}, local: const {});
      when(() => api.put(any(), any(), any())).thenThrow(ApiException(code: 'SERVER', message: 'lỗi', status: 500));
      await outbox.sync();
      final failed = c.read(outboxProvider).items.single;
      expect(failed.failed, isTrue);
      expect(failed.method, 'PUT');
      when(() => api.put(any(), any(), any())).thenAnswer((_) async => {'customer': {'id': 5}});
      await outbox.retry(failed.id);
      expect(c.read(outboxProvider).items, isEmpty);
      verify(() => api.put('/admin/customers/5', any(), any())).called(2);
      verifyNever(() => api.post(any(), any(), any()));
    });

    test('the queue belongs to the account that made it: another account on the phone sees nothing', () async {
      final c1 = await container(user: adminUser);
      await c1.read(outboxProvider.notifier).enqueue(kind: 'customer.collect', path: '/admin/customers/5/collect', body: const {'amount': 1}, local: const {});
      expect(c1.read(outboxProvider).items.length, 1);
      final c2 = await container(user: cashierUser);
      await c2.read(outboxProvider.notifier).ready;
      expect(c2.read(outboxProvider).items, isEmpty);
      final c3 = await container(user: adminUser);
      await c3.read(outboxProvider.notifier).ready;
      expect(c3.read(outboxProvider).items.length, 1, reason: 'back as the same account: still there');
    });

    test('the single queue of the 1.4.0 app is adopted by the first account that signs in', () async {
      final server = (await testContainer(api, store: store)).read(serverUrlProvider);
      final item = OutboxItem(id: 'off-legacy-0000001', kind: 'checkout', path: '/pos/checkout', body: const {}, local: const {}, createdAt: DateTime.now());
      await store.write('outbox:$server', jsonEncode({'items': [item.toJson()], 'synced': []}));
      when(() => api.post(any(), any(), any())).thenThrow(net());
      final c = await container(user: cashierUser);
      await c.read(outboxProvider.notifier).ready;
      expect(c.read(outboxProvider).items.single.id, 'off-legacy-0000001');
      expect(await store.read('outbox:$server'), isNull, reason: 'moved under the account');
      expect(await store.read('outbox:$server:u${cashierUser.id}'), isNotNull);
    });

    test('a session that ended (401) pauses the queue instead of failing every item', () async {
      final c = await container();
      final outbox = c.read(outboxProvider.notifier);
      await outbox.enqueue(kind: 'customer.collect', path: '/admin/customers/5/collect', body: const {'amount': 1}, local: const {});
      await outbox.enqueue(kind: 'inventory.receive', path: '/inventory/1/receive', body: const {'quantity': 1}, local: const {});
      when(() => api.post(any(), any(), any())).thenThrow(unauthorized());
      await outbox.sync();
      final s = c.read(outboxProvider);
      expect(s.pending.length, 2, reason: 'nothing marked failed');
      expect(s.failedCount, 0);
      verify(() => api.post(any(), any(), any())).called(1);
    });

    test('nothing is sent while nobody (or an account that must change its password) is signed in', () async {
      final c = await container(user: const AppUser(id: 1, username: 'boss', fullName: 'B', role: 'admin', mustChangePassword: true));
      final outbox = c.read(outboxProvider.notifier);
      await outbox.enqueue(kind: 'customer.collect', path: '/admin/customers/5/collect', body: const {'amount': 1}, local: const {});
      await outbox.sync();
      verifyNever(() => api.post(any(), any(), any()));
      expect(c.read(outboxProvider).pending.length, 1);
    });

    test('the queue is saved after every accepted item', () async {
      final c = await container();
      final outbox = c.read(outboxProvider.notifier);
      await outbox.enqueue(kind: 'customer.collect', path: '/admin/customers/5/collect', body: const {'amount': 1}, local: const {});
      await outbox.enqueue(kind: 'customer.collect', path: '/admin/customers/6/collect', body: const {'amount': 1}, local: const {});
      var calls = 0;
      when(() => api.post(any(), any(), any())).thenAnswer((_) async {
        calls++;
        if (calls == 2) {
          final saved = jsonDecode((await store.read('outbox:${c.read(serverUrlProvider)}:u${adminUser.id}'))!) as Map;
          expect((saved['items'] as List).length, 1, reason: 'the first item was already dropped from the file');
          throw net();
        }
        return {'balance': 0};
      });
      await outbox.sync();
      expect(c.read(outboxProvider).pending.length, 1);
    });
  });

  group('OfflineWriter order', () {
    test('an online write waits behind queued writes on the same record; other records go straight out', () async {
      final c = await container();
      final outbox = c.read(outboxProvider.notifier);
      await outbox.enqueue(kind: 'customer.collect', path: '/admin/customers/5/collect', body: const {'amount': 1000}, local: const {});
      // The replay cannot finish now (the server is still busy with the first attempt): the item stays queued.
      when(() => api.post('/admin/customers/5/collect', any(), any())).thenThrow(ApiException(code: 'IDEMPOTENCY_IN_PROGRESS', message: 'busy', status: 409));
      when(() => api.post('/admin/customers/6/adjust', any(), any())).thenAnswer((_) async => {'balance': 0});
      final writer = c.read(offlineWriterProvider);
      final same = await writer.submit(
        kind: 'customer.adjust',
        path: '/admin/customers/5/adjust',
        body: const {'amount': 1, 'direction': 'increase'},
        effect: (d) async => {'balance': await d.addCustomerBalance(5, 1)},
      );
      expect(same.queued, isTrue, reason: 'lined up behind the collection on customer 5');
      final other = await writer.submit(
        kind: 'customer.adjust',
        path: '/admin/customers/6/adjust',
        body: const {'amount': 1, 'direction': 'increase'},
        effect: (d) async => {'balance': await d.addCustomerBalance(6, 1)},
      );
      expect(other.queued, isFalse);
      expect(c.read(outboxProvider).pending.map((i) => i.kind), ['customer.collect', 'customer.adjust']);
    });

    test('a write on a record missing from the copy is refused, not queued with a made-up answer', () async {
      final c = await container();
      c.read(netProvider.notifier).markOffline();
      await expectLater(
        c.read(offlineWriterProvider).submit(
          kind: 'customer.collect',
          path: '/admin/customers/999/collect',
          body: const {'amount': 1},
          effect: (d) async => {'balance': await d.addCustomerBalance(999, -1)},
        ),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'OFFLINE_NO_COPY')),
      );
      expect(c.read(outboxProvider).items, isEmpty);
    });
  });

  group('Snapshot sync', () {
    test('never replaces the copy while writes are queued, even when forced; says so on the sync screen', () async {
      final c = await container();
      await c.read(outboxProvider.notifier).enqueue(kind: 'customer.collect', path: '/admin/customers/5/collect', body: const {'amount': 1}, local: const {});
      final ok = await c.read(snapshotSyncProvider.notifier).sync(force: true);
      expect(ok, isFalse);
      verifyNever(() => api.get(any(), query: any(named: 'query'), useCache: any(named: 'useCache')));
      expect(c.read(snapshotSyncProvider).error, contains('1 thao tác chờ'));
    });

    test('a forced refresh asked during a run is not lost: it runs again afterwards', () async {
      final c = await container();
      var calls = 0;
      when(() => api.get('/sync/snapshot', useCache: false)).thenAnswer((_) async {
        calls++;
        await Future<void>.delayed(const Duration(milliseconds: 20));
        return snapshot();
      });
      final n = c.read(snapshotSyncProvider.notifier);
      final first = n.sync(force: true);
      final second = n.sync(force: true);
      expect(await first, isTrue);
      expect(await second, isTrue, reason: 'shares the first run');
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(calls, 2, reason: 'then runs once more');
    });

    test('an answer that is not a snapshot is refused and the copy is kept', () async {
      final c = await container();
      when(() => api.get('/sync/snapshot', useCache: false)).thenAnswer((_) async => {'html': '<maintenance>'});
      expect(await c.read(snapshotSyncProvider.notifier).sync(force: true), isFalse);
      expect(c.read(snapshotSyncProvider).error, contains('không đúng định dạng'));
      expect(await db.syncedAt(), DateTime.utc(2026, 10, 13, 4), reason: 'untouched');
      expect(isSnapshot(snapshot()), isTrue);
    });

    test('the throttle counts from the last copy that succeeded', () async {
      final c = await container();
      when(() => api.get('/sync/snapshot', useCache: false)).thenThrow(net());
      final n = c.read(snapshotSyncProvider.notifier);
      expect(await n.sync(), isFalse);
      when(() => api.get('/sync/snapshot', useCache: false)).thenAnswer((_) async => snapshot());
      expect(await n.sync(), isTrue, reason: 'a failed attempt does not block the next one');
      expect(await n.sync(), isFalse, reason: 'within 2 minutes of a success');
    });

    test('a database that could not be opened is tried again next time', () async {
      var attempts = 0;
      final flaky = OfflineDb(() async {
        attempts++;
        if (attempts == 1) throw StateError('locked');
        return OfflineDb.openAt(databaseFactoryFfi, inMemoryDatabasePath, singleInstance: false);
      });
      expect(await flaky.replaceSnapshot(snapshot()), isFalse);
      expect(await flaky.replaceSnapshot(snapshot()), isTrue);
    });
  });

  group('Local effects', () {
    test('a collection settles the oldest debt orders the money covers, like the server', () async {
      await db.addLedgerEntry(5, type: 'payment', amount: -100000, method: 'cash');
      await db.addCustomerBalance(5, -100000);
      final settled = await db.settleOrdersLocally(5, method: 'cash');
      expect(settled, ['CF-8'], reason: '60k covered, 90k not yet');
      final r = OfflineResolver(db);
      final paid = (await r.resolve('/orders/8', {'include': 'payments'}))!;
      expect(paid['order']['payment_status'], 'paid');
      expect((paid['payments'] as List).single['amount'], 60000);
      expect((await r.resolve('/orders/9', null))!['order']['payment_status'], 'unpaid');
    });

    test('stock moves keep the total stock value in step', () async {
      await db.moveStock(1, receiveQuantity: 10, unitCost: 100); // item 1: 10 -> 20 at 100 = +1000
      expect((await OfflineResolver(db).resolve('/inventory', {'all': '1'}))!['stock_value'], 3000);
      await db.moveStock(2, newQuantity: 0); // item 2: 1000 -> 0
      expect((await OfflineResolver(db).resolve('/inventory', {'all': '1'}))!['stock_value'], 2000);
    });

    test('a balance change does not move the customer in the list (updated_at is the server\'s)', () async {
      await db.addCustomerBalance(6, 5000);
      final l = (await OfflineResolver(db).resolve('/admin/customers', null))!;
      expect((l['customers'] as List).map((c) => c['id']), [5, 6]);
    });
  });

  group('Resolver fidelity', () {
    test('sort orders match the server: products by name ignoring case and accents, tables active first', () async {
      final r = OfflineResolver(db);
      expect(((await r.resolve('/products', null))!['products'] as List).map((p) => p['name']), ['Cà phê đen', 'Cacao', 'trà đào', 'Trà sữa'], reason: 'space before letters, as utf8mb4_unicode_ci');
      expect(((await r.resolve('/tables', {'all': '1'}))!['tables'] as List).map((t) => t['code']), ['B02', 'B01']);
      expect(((await r.resolve('/inventory', null))!['items'] as List).map((i) => i['name']), ['Sữa', 'Sữa chua'], reason: 'by name, not name + sku');
    });

    test('the item page is answered from the copy; the orders list says what it covers', () async {
      final r = OfflineResolver(db);
      final item = (await r.resolve('/inventory/1', null, detail: true))!;
      expect(item['item']['name'], 'Sữa');
      expect(item['movements'], isEmpty);
      expect(await r.resolve('/inventory/1', null), isNull, reason: 'single-record pages only on request');
      final orders = (await r.resolve('/orders', {'page': 1}))!;
      expect(orders['offline_note'], contains('2 đơn gần nhất'));
    });
  });
}
