import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/offline/connectivity.dart';
import 'package:cocoffee_mobile/core/offline/local_store.dart';
import 'package:cocoffee_mobile/core/offline/outbox.dart';
import 'package:cocoffee_mobile/core/offline/response_cache.dart';
import 'package:cocoffee_mobile/features/pos/pos_models.dart';
import 'package:cocoffee_mobile/features/pos/pos_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../features/pos/pos_test_data.dart';
import '../helpers/test_app.dart';

/// Answers GETs with a body, or fails like a dead network when [down] is set. Records what was sent.
class _Adapter implements HttpClientAdapter {
  bool down = false;
  int calls = 0;
  RequestOptions? last;
  Map<String, dynamic> body = {'ok': 1};

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    calls++;
    last = options;
    if (down) throw DioException(requestOptions: options, type: DioExceptionType.connectionError);
    return ResponseBody.fromString(jsonEncode(body), 200, headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  group('LocalStore', () {
    test('MemoryStore: read, write, delete, keys by prefix', () async {
      final s = MemoryStore();
      await s.write('a:1', 'x');
      await s.write('a:2', 'y');
      await s.write('b:1', 'z');
      expect(await s.read('a:1'), 'x');
      expect((await s.keys('a:')).toSet(), {'a:1', 'a:2'});
      await s.clear('a:');
      expect(await s.keys(), ['b:1']);
    });

    test('FileStore: survives a new instance, ignores corrupt files, keys with odd characters stay apart', () async {
      final dir = await Directory.systemTemp.createTemp('cc-store-');
      addTearDown(() => dir.delete(recursive: true));
      final a = FileStore(dir);
      await a.write('cart:https://x.test:1', '{"v":1}');
      await a.write('cart:https://x.test:2', '{"v":2}');
      await File('${dir.path}${Platform.pathSeparator}junk-0000.json').writeAsString('{not json');

      final b = FileStore(dir); // a fresh start of the app
      expect(await b.read('cart:https://x.test:1'), '{"v":1}');
      expect(await b.read('cart:https://x.test:2'), '{"v":2}');
      expect(await b.read('missing'), isNull);
      expect((await b.keys('cart:')).length, 2);
      await b.delete('cart:https://x.test:1');
      expect(await FileStore(dir).read('cart:https://x.test:1'), isNull);
    });
  });

  group('ResponseCache', () {
    test('same request -> same key (query order does not matter); write/read keeps the time; prune drops the oldest', () async {
      expect(ResponseCache.keyFor('/orders', {'b': 2, 'a': 1}), '/orders?a=1&b=2');
      expect(ResponseCache.keyFor('/tables', null), '/tables');
      final c = ResponseCache(MemoryStore(), scope: 's', max: 2);
      await c.write('/a', {'n': 1}, now: DateTime(2026, 10, 1));
      await c.write('/b', {'n': 2}, now: DateTime(2026, 10, 2));
      await c.write('/c', {'n': 3}, now: DateTime(2026, 10, 3));
      expect((await c.read('/c'))!.data, {'n': 3});
      expect((await c.read('/b'))!.at, DateTime(2026, 10, 2));
      await c.prune();
      expect(await c.read('/a'), isNull, reason: 'oldest entry dropped');
      expect(await c.count(), 2);
      expect(await ResponseCache(c.store, scope: 'other').read('/c'), isNull, reason: 'scopes (server + account) never mix');
    });
  });

  group('ApiClient offline cache', () {
    late _Adapter adapter;
    late ResponseCache cache;
    late bool offline;
    late int wentOffline;
    late int wentOnline;

    ApiClient client() => ApiClient(
          serverUrl: 'https://cafe.example.test',
          token: () => 'tok',
          onUnauthorized: () {},
          dio: Dio()..httpClientAdapter = adapter,
          cache: cache,
          net: NetHooks(isOffline: () => offline, onOffline: () => wentOffline++, onOnline: () => wentOnline++),
        );

    setUp(() {
      adapter = _Adapter();
      cache = ResponseCache(MemoryStore(), scope: 't');
      offline = false;
      wentOffline = 0;
      wentOnline = 0;
    });

    test('a GET that works is cached; when the network fails the cached answer is returned', () async {
      final api = client();
      adapter.body = {'tables': [1, 2]};
      expect(await api.get('/tables'), {'tables': [1, 2]});
      expect(wentOnline, 1);
      await Future<void>.delayed(Duration.zero); // the cache write is not awaited by the caller

      adapter.down = true;
      expect(await api.get('/tables'), {'tables': [1, 2]}, reason: 'served from the cache');
      expect(wentOffline, 1);
    });

    test('nothing cached yet: the failure is reported as OFFLINE', () async {
      adapter.down = true;
      await expectLater(client().get('/orders'), throwsA(isA<ApiException>().having((e) => e.isNetwork, 'isNetwork', true)));
      expect(wentOffline, 1);
    });

    test('already offline: the cache answers without touching the network', () async {
      final api = client();
      adapter.body = {'n': 7};
      await api.get('/menu');
      await Future<void>.delayed(Duration.zero);
      final before = adapter.calls;
      offline = true;
      expect(await api.get('/menu'), {'n': 7});
      expect(adapter.calls, before);
    });

    test('a business error (409) is never replaced by cached data; POST sends the Idempotency-Key header', () async {
      final api = client();
      adapter.body = {'order': {'id': 1}};
      await api.post('/pos/checkout', {'items': []}, {'Idempotency-Key': 'off-abc-123456'});
      expect(adapter.last!.headers['Idempotency-Key'], 'off-abc-123456');
      expect(adapter.last!.headers['Authorization'], 'Bearer tok');
    });

    test('502-504 from the host (redeploy) count as unreachable', () {
      for (final s in [502, 503, 504]) {
        expect(ApiException(code: 'HTTP_$s', status: s, message: 'x').isNetwork, true);
      }
      expect(ApiException(code: 'INTERNAL', status: 500, message: 'x').isNetwork, false);
      expect(ApiException(code: 'INSUFFICIENT_STOCK', status: 409, message: 'x').isNetwork, false);
    });
  });

  group('Outbox', () {
    late MockApi api;

    setUp(() {
      api = MockApi();
    });

    test('ids are valid Idempotency-Keys and local codes are short and stable', () {
      final id = newLocalId();
      expect(RegExp(r'^[A-Za-z0-9_.:-]{8,100}$').hasMatch(id), true);
      expect(id, isNot(newLocalId()));
      expect(localCodeOf(id), startsWith('OFF-'));
      expect(localCodeOf(id), localCodeOf(id));
    });

    test('sync replays oldest first with the item id as key; a refused item is marked failed and the rest still goes', () async {
      final c = await testContainer(api);
      addTearDown(c.dispose);
      final box = c.read(outboxProvider.notifier);
      final order = <String>[];
      when(() => api.post('/pos/checkout', any(), any())).thenAnswer((inv) async {
        final body = inv.positionalArguments[1] as Map;
        final key = (inv.positionalArguments[2] as Map)['Idempotency-Key'] as String;
        order.add(key);
        if (body['method'] == 'card') throw ApiException(code: 'INSUFFICIENT_STOCK', status: 409, message: 'Không đủ tồn kho: Sữa');
        return {'order': {'id': 77, 'order_code': 'CF-77'}, 'change': 0};
      });
      final a = await box.enqueue(kind: 'checkout', path: '/pos/checkout', body: {'method': 'cash'}, local: {'total': 25000});
      final b = await box.enqueue(kind: 'checkout', path: '/pos/checkout', body: {'method': 'card'}, local: {'total': 30000});
      final d = await box.enqueue(kind: 'checkout', path: '/pos/checkout', body: {'method': 'cash'}, local: {'total': 35000});

      await box.sync();
      final s = c.read(outboxProvider);
      expect(order, [a.id, b.id, d.id]);
      expect(s.items.map((i) => i.id), [b.id], reason: 'only the refused sale is left');
      expect(s.items.single.failed, true);
      expect(s.items.single.error, contains('Không đủ tồn kho'));
      expect(s.synced.map((x) => x.serverCode), ['CF-77', 'CF-77']);
      expect(s.synced.last.localCode, a.code);
      expect(s.syncing, false);
    });

    test('a network failure stops the run and keeps everything queued; a later sync finishes the job', () async {
      final c = await testContainer(api);
      addTearDown(c.dispose);
      final box = c.read(outboxProvider.notifier);
      var down = true;
      when(() => api.post('/pos/checkout', any(), any())).thenAnswer((_) async {
        if (down) throw ApiException(code: 'OFFLINE', message: 'x');
        return {'order': {'id': 5, 'order_code': 'CF-5'}};
      });
      await box.enqueue(kind: 'checkout', path: '/pos/checkout', body: {}, local: {});
      await box.enqueue(kind: 'checkout', path: '/pos/checkout', body: {}, local: {});
      await box.sync();
      expect(c.read(outboxProvider).items.length, 2);
      expect(c.read(outboxProvider).failedCount, 0, reason: 'offline is not a failure of the item');
      verify(() => api.post('/pos/checkout', any(), any())).called(1); // stopped at the first one

      down = false;
      await box.sync();
      expect(c.read(outboxProvider).items, isEmpty);
      expect(c.read(outboxProvider).synced.length, 2);
    });

    test('the queue survives an app restart (persisted per server) and replays itself', () async {
      final store = MemoryStore();
      var c = await testContainer(api, store: store);
      await c.read(outboxProvider.notifier).enqueue(kind: 'hold', path: '/pos/hold', body: {'table_id': 3}, local: {'total': 1});
      c.dispose();

      when(() => api.post('/pos/hold', any(), any())).thenAnswer((_) async => {'order': {'id': 9, 'order_code': 'CF-9'}});
      c = await testContainer(api, store: store);
      addTearDown(c.dispose);
      await c.read(outboxProvider.notifier).ready;
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(c.read(outboxProvider).items, isEmpty, reason: 'replayed after the restart');
      expect(c.read(outboxProvider).synced.single.serverOrderId, 9);
    });

    test('retry clears the error and replays; discard removes the item', () async {
      final c = await testContainer(api);
      addTearDown(c.dispose);
      final box = c.read(outboxProvider.notifier);
      var refuse = true;
      when(() => api.post('/pos/checkout', any(), any())).thenAnswer((_) async {
        if (refuse) throw ApiException(code: 'INSUFFICIENT_PAYMENT', status: 422, message: 'Tiền khách đưa chưa đủ.');
        return {'order': {'id': 1, 'order_code': 'CF-1'}};
      });
      final item = await box.enqueue(kind: 'checkout', path: '/pos/checkout', body: {}, local: {});
      await box.sync();
      expect(c.read(outboxProvider).items.single.error, 'Tiền khách đưa chưa đủ.');
      refuse = false;
      await box.retry(item.id);
      expect(c.read(outboxProvider).items, isEmpty);

      final other = await box.enqueue(kind: 'hold', path: '/pos/hold', body: {}, local: {});
      await box.remove(other.id);
      expect(c.read(outboxProvider).items, isEmpty);
    });
  });

  group('POS offline', () {
    late MockApi api;

    setUp(() {
      api = MockApi();
    });

    test('offline checkout is queued with a local code and answers like a paid sale (change included)', () async {
      final c = await testContainer(api);
      addTearDown(c.dispose);
      c.read(netProvider.notifier).markOffline();
      final cart = c.read(cartProvider.notifier);
      final latte = PosData.fromJson(bootstrap()).product(11)!;
      cart.add(latte);
      cart.add(latte);

      final out = await cart.checkout(const PayRequest(method: 'cash', tendered: 100000), where: 'Mang đi');
      expect(out.offline, true);
      expect(out.code, startsWith('OFF-'));
      expect(out.change, 50000);
      verifyNever(() => api.post('/pos/checkout', any(), any()));

      final item = c.read(outboxProvider).items.single;
      expect(item.kind, 'checkout');
      expect(item.path, '/pos/checkout');
      expect(item.body, {
        'items': [
          {'product_id': 11, 'quantity': 2},
        ],
        'method': 'cash',
        'tendered': 100000,
        'discount': 0,
      });
      expect(item.local['summary'], '2× Cà phê sữa đá');
      expect(item.total, 50000);
      expect(c.read(cartProvider).isEmpty, true, reason: 'cart emptied for the next customer');
    });

    test('a request that fails on the network is queued too, with the SAME key it was tried with', () async {
      final c = await testContainer(api);
      addTearDown(c.dispose);
      String? triedWith;
      when(() => api.post('/pos/checkout', any(), any())).thenAnswer((inv) async {
        triedWith = (inv.positionalArguments[2] as Map)['Idempotency-Key'] as String;
        throw ApiException(code: 'TIMEOUT', message: 'x');
      });
      final cart = c.read(cartProvider.notifier);
      cart.add(PosData.fromJson(bootstrap()).product(11)!);
      final out = await cart.checkout(const PayRequest(method: 'transfer'));
      expect(out.offline, true);
      expect(c.read(outboxProvider).items.single.id, triedWith, reason: 'a lost answer is replayed as the same request');
    });

    test('offline hold: the table shows as waiting for sync, can be reopened and edited, then updates the queued item', () async {
      final c = await testContainer(api);
      addTearDown(c.dispose);
      c.read(netProvider.notifier).markOffline();
      final data = PosData.fromJson(bootstrap());
      final cart = c.read(cartProvider.notifier);
      cart.useTable(1);
      cart.add(data.product(11)!);
      final held = await cart.hold(where: 'Bàn 1');
      expect(held['offline'], true);

      final queued = c.read(outboxProvider).items;
      expect(queued.single.kind, 'hold');
      expect(queued.single.body['table_id'], 1);
      final overlay = data.withLocalHolds(queued);
      expect(overlay.table(1)!.heldLocally, true);
      expect(overlay.table(1)!.busy, true);
      expect(overlay.table(3)!.busy, false);

      cart.openLocal(queued.single, overlay);
      expect(c.read(cartProvider).localId, queued.single.id);
      expect(c.read(cartProvider).lines.single.qty, 1);
      cart.add(data.product(12)!);
      await cart.hold(where: 'Bàn 1');
      expect(c.read(outboxProvider).items.length, 1, reason: 'updated in place, not duplicated');
      expect(c.read(outboxProvider).items.single.local['count'], 2);
    });

    test('paying a table order that was held offline replaces the queued hold by one checkout', () async {
      final c = await testContainer(api);
      addTearDown(c.dispose);
      c.read(netProvider.notifier).markOffline();
      final data = PosData.fromJson(bootstrap());
      final cart = c.read(cartProvider.notifier);
      cart.useTable(1);
      cart.add(data.product(11)!);
      await cart.hold(where: 'Bàn 1');
      cart.openLocal(c.read(outboxProvider).items.single, data);

      final out = await cart.checkout(const PayRequest(method: 'cash', tendered: 25000), where: 'Bàn 1');
      expect(out.offline, true);
      final items = c.read(outboxProvider).items;
      expect(items.length, 1);
      expect(items.single.kind, 'checkout');
      expect(items.single.body['table_id'], 1);
    });

    test('the cart is saved on the device and comes back after a restart', () async {
      final store = MemoryStore();
      var c = await testContainer(api, store: store);
      c.read(cartProvider); // build
      final latte = PosData.fromJson(bootstrap()).product(11)!;
      c.read(cartProvider.notifier).useTable(2);
      c.read(cartProvider.notifier).add(latte);
      c.read(cartProvider.notifier).setLineNote(0, 'ít đá');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      c.dispose();

      c = await testContainer(api, store: store);
      addTearDown(c.dispose);
      c.read(cartProvider);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      final s = c.read(cartProvider);
      expect(s.tableId, 2);
      expect(s.lines.single.name, 'Cà phê sữa đá');
      expect(s.lines.single.note, 'ít đá');
      expect(s.busy, false);
    });
  });
}

