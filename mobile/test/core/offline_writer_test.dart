import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/offline/connectivity.dart';
import 'package:cocoffee_mobile/core/offline/offline_db.dart';
import 'package:cocoffee_mobile/core/offline/offline_effects.dart';
import 'package:cocoffee_mobile/core/offline/offline_resolver.dart';
import 'package:cocoffee_mobile/core/offline/offline_writer.dart';
import 'package:cocoffee_mobile/core/offline/outbox.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../helpers/test_app.dart';

Map<String, dynamic> snapshot() => {
      'generated_at': '2026-10-13T04:00:00.000Z',
      'role': 'admin',
      'categories': [],
      'products': [],
      'tables': [
        {'id': 1, 'code': 'B01', 'name': 'Bàn 1', 'status': 'serving', 'current_order_id': 7, 'current_order_total': 50000, 'is_active': 1},
      ],
      'inventory': {
        'items': [
          {'id': 1, 'name': 'Sữa', 'sku': 'S', 'is_active': 1, 'is_low': 0, 'quantity_on_hand': 100, 'avg_cost': 10, 'min_stock': 20},
        ],
        'stock_value': 1000,
      },
      'customers': [
        {'id': 5, 'name': 'Chị Lan', 'phone': null, 'zalo_user_id': null, 'balance': 120000, 'order_count': 1, 'updated_at': '2026-10-13T03:00:00.000Z'},
      ],
      'customer_stats': {'total_customers': 1, 'debt_customers': 1, 'total_debt': 120000},
      'orders': [
        {'id': 7, 'order_code': 'CF-7', 'source': 'pos', 'status': 'open', 'payment_status': 'unpaid', 'total': 50000, 'table_id': 1, 'created_at': '2026-10-13T03:00:00.000Z', 'items': []},
      ],
    };

ApiException net() => ApiException(code: 'OFFLINE', message: 'Mất mạng');

void main() {
  sqfliteFfiInit();
  late MockApi api;
  late OfflineDb db;
  late ProviderContainer c;

  setUp(() async {
    api = MockApi();
    db = OfflineDb(() => OfflineDb.openAt(databaseFactoryFfi, inMemoryDatabasePath, singleInstance: false));
    await db.replaceSnapshot(snapshot());
    c = await testContainer(api, user: adminUser);
    // testContainer has no offline database: give it ours
    c = ProviderContainer(overrides: [
      sessionStoreProvider.overrideWithValue(c.read(sessionStoreProvider)),
      apiProvider.overrideWithValue(api),
      currentUserProvider.overrideWithValue(adminUser),
      networkEventsProvider.overrideWithValue(() => const Stream<bool>.empty()),
      offlineDbProvider.overrideWithValue(db),
    ]);
    addTearDown(c.dispose);
  });

  Future<WriteOutcome> collect({num amount = 50000}) => c.read(offlineWriterProvider).submit(
        kind: 'customer.collect',
        path: '/admin/customers/5/collect',
        body: {'amount': amount, 'method': 'cash'},
        effect: (d) async => {'balance': await d.addCustomerBalance(5, -amount)},
      );

  test('online: sent at once with an Idempotency-Key, nothing queued', () async {
    when(() => api.post(any(), any(), any())).thenAnswer((_) async => {'balance': 70000});
    final out = await collect();
    expect(out.queued, isFalse);
    expect(out.body['balance'], 70000);
    final key = verify(() => api.post('/admin/customers/5/collect', any(), captureAny())).captured.single as Map;
    expect(key['Idempotency-Key'], startsWith('off-'));
    expect(c.read(outboxProvider).items, isEmpty);
  });

  test('connection lost during the call: queued with the SAME key, effect applied to the local copy', () async {
    when(() => api.post(any(), any(), any())).thenThrow(net());
    final out = await collect();
    expect(out.queued, isTrue);
    expect(out.body['queued'], isTrue);
    expect(out.body['balance'], 70000);
    final key = (verify(() => api.post(any(), any(), captureAny())).captured.single as Map)['Idempotency-Key'];
    final item = c.read(outboxProvider).items.single;
    expect(item.id, key, reason: 'a request that did reach the server is not executed twice');
    expect(item.kind, 'customer.collect');
    final list = (await OfflineResolverFor(db).customers())['customers'] as List;
    expect(list.single['balance'], 70000);
    expect((await db.metaJson('customer_stats') as Map)['total_debt'], 70000);
  });

  test('known to be offline: not even tried, queued', () async {
    c.read(netProvider.notifier).markOffline();
    final out = await collect(amount: 20000);
    expect(out.queued, isTrue);
    verifyNever(() => api.post(any(), any(), any()));
    expect(c.read(outboxProvider).items.length, 1);
  });

  test('a business error (409...) is never queued', () async {
    when(() => api.post(any(), any(), any())).thenThrow(ApiException(code: 'DUPLICATE', message: 'trùng', status: 409));
    await expectLater(collect(), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'DUPLICATE')));
    expect(c.read(outboxProvider).items, isEmpty);
  });

  test('offline with no local copy yet: refused with the usual offline error', () async {
    final empty = OfflineDb(() => OfflineDb.openAt(databaseFactoryFfi, inMemoryDatabasePath, singleInstance: false));
    final c2 = ProviderContainer(overrides: [
      sessionStoreProvider.overrideWithValue(c.read(sessionStoreProvider)),
      apiProvider.overrideWithValue(api),
      currentUserProvider.overrideWithValue(adminUser),
      networkEventsProvider.overrideWithValue(() => const Stream<bool>.empty()),
      offlineDbProvider.overrideWithValue(empty),
    ]);
    addTearDown(c2.dispose);
    c2.read(netProvider.notifier).markOffline();
    await expectLater(
      c2.read(offlineWriterProvider).submit(kind: 'x', path: '/p', body: const {}, effect: (_) async => const {}),
      throwsA(isA<ApiException>().having((e) => e.isOffline, 'offline', isTrue)),
    );
  });

  test('a customer created offline can be used at once; replay maps the temporary id to the real one', () async {
    c.read(netProvider.notifier).markOffline();
    final tempId = newTempId();
    expect(tempId, isNegative);
    final created = await c.read(offlineWriterProvider).submit(
          kind: 'customer.create',
          path: '/admin/customers',
          body: {'name': 'Khách mới'},
          local: {'temp_id': tempId},
          effect: (d) async => {'customer': await d.insertCustomer(tempId, name: 'Khách mới')},
        );
    expect((created.body['customer'] as Map)['id'], tempId);
    await c.read(offlineWriterProvider).submit(
          kind: 'customer.collect',
          path: '/admin/customers/$tempId/collect',
          body: {'amount': 1000, 'method': 'cash'},
          effect: (d) async => {'balance': await d.addCustomerBalance(tempId, -1000)},
        );
    expect(c.read(outboxProvider).items.length, 2);

    when(() => api.post('/admin/customers', any(), any())).thenAnswer((_) async => {'customer': {'id': 77, 'name': 'Khách mới'}});
    when(() => api.post('/admin/customers/77/collect', any(), any())).thenAnswer((_) async => {'balance': 0});
    c.read(netProvider.notifier).markOnline();
    await c.read(outboxProvider.notifier).sync();
    expect(c.read(outboxProvider).items, isEmpty);
    expect(c.read(outboxProvider).refs, {tempId: 77});
    verify(() => api.post('/admin/customers/77/collect', any(), any())).called(1);
  });

  test('a dependent write whose parent was refused is marked failed, not sent', () async {
    final tempId = newTempId();
    final outbox = c.read(outboxProvider.notifier);
    await outbox.enqueue(kind: 'customer.collect', path: '/admin/customers/$tempId/collect', body: const {'amount': 1}, local: const {});
    await outbox.sync();
    verifyNever(() => api.post(any(), any(), any()));
    final item = c.read(outboxProvider).items.single;
    expect(item.failed, isTrue);
    expect(item.errorCode, 'DEPENDENCY');
  });

  test('resolveRefs only touches negative ids', () {
    expect(resolveRefs('/admin/customers/5/collect', {}), '/admin/customers/5/collect');
    expect(resolveRefs('/admin/customers/-4/collect', {-4: 9}), '/admin/customers/9/collect');
    expect(resolveRefs('/admin/customers/-4', {-4: 9}), '/admin/customers/9');
    expect(resolveRefs('/admin/customers/-4/collect', {}), isNull);
  });

  test('stock: receiving moves the average cost; a count sets the quantity; low flag follows', () async {
    var r = await db.moveStock(1, receiveQuantity: 100, unitCost: 20);
    expect(r['quantity_on_hand'], 200);
    expect(r['avg_cost'], 15);
    r = await db.moveStock(1, newQuantity: 10);
    expect(r['delta'], -190);
    final rows = (await OfflineResolverFor(db).inventory())['items'] as List;
    expect(rows.single['is_low'], 1, reason: '10 <= min 20');
  });

  test('cancelling an order locally frees its table', () async {
    final o = await db.cancelOrderLocally(7);
    expect(o!['status'], 'cancelled');
    final t = ((await OfflineResolverFor(db).tables())['tables'] as List).single as Map;
    expect(t['status'], 'available');
    expect(t['current_order_id'], isNull);
  });

  test('editing a customer offline updates search', () async {
    await db.patchCustomer(5, {'name': 'Cô Hồng', 'phone': '0900'});
    final r = await OfflineResolverFor(db).customers(q: 'co hong');
    expect((r['customers'] as List).single['phone'], '0900');
  });
}

/// Small helper around the resolver for the assertions above.
class OfflineResolverFor {
  OfflineResolverFor(this.db);
  final OfflineDb db;

  Future<Map<String, dynamic>> customers({String? q}) async => (await _r('/admin/customers', {'q': q}))!;
  Future<Map<String, dynamic>> inventory() async => (await _r('/inventory', {'all': '1'}))!;
  Future<Map<String, dynamic>> tables() async => (await _r('/tables', {'all': '1'}))!;
  Future<Map<String, dynamic>?> _r(String path, Map<String, dynamic> q) =>
      OfflineResolver(db).resolve(path, q..removeWhere((_, v) => v == null));
}
