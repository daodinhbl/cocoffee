import 'dart:typed_data';

import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/offline/local_store.dart';
import 'package:cocoffee_mobile/core/offline/offline_db.dart';
import 'package:cocoffee_mobile/core/offline/offline_resolver.dart';
import 'package:cocoffee_mobile/core/offline/response_cache.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// A server that cannot be reached.
class _DownAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    throw DioException.connectionError(requestOptions: options, reason: 'down');
  }

  @override
  void close({bool force = false}) {}
}

Map<String, dynamic> snapshot() => {
      'generated_at': '2026-10-13T04:00:00.000Z',
      'role': 'admin',
      'categories': [],
      'products': [],
      'tables': [],
      'orders': [],
      'customers': [
        {'id': 7, 'name': 'Chị Lan', 'balance': 300000, 'order_count': 1, 'updated_at': '2026-10-13T03:00:00.000Z'},
      ],
      'customer_stats': {'total_customers': 1, 'debt_customers': 1, 'total_debt': 300000},
    };

void main() {
  sqfliteFfiInit();
  late OfflineDb db;
  late ResponseCache cache;
  var localEdits = false;

  ApiClient client() => ApiClient(
        serverUrl: 'https://cafe.example.test',
        token: () => 'tok',
        onUnauthorized: () {},
        dio: Dio()..httpClientAdapter = _DownAdapter(),
        cache: cache,
        offline: OfflineResolver(db),
        hasLocalEdits: () => localEdits,
      );

  setUp(() async {
    localEdits = false;
    db = OfflineDb(() => OfflineDb.openAt(databaseFactoryFfi, inMemoryDatabasePath, singleInstance: false));
    await db.replaceSnapshot(snapshot());
    cache = ResponseCache(MemoryStore(), scope: 't');
  });

  test('offline: the copy answers a single-record page when nothing fresher was cached', () async {
    final r = await client().get('/admin/customers/7');
    expect(r['customer']['balance'], 300000);
  });

  test('offline: an answer cached after the copy was taken wins while nothing is queued', () async {
    await cache.write(ResponseCache.keyFor('/admin/customers/7', null), {'customer': {'id': 7, 'balance': 500000}, 'ledger': [], 'orders': []},
        now: DateTime.utc(2026, 10, 13, 5));
    expect((await client().get('/admin/customers/7'))['customer']['balance'], 500000);
  });

  test('offline: an older cached answer loses to the copy', () async {
    await cache.write(ResponseCache.keyFor('/admin/customers/7', null), {'customer': {'id': 7, 'balance': 500000}, 'ledger': [], 'orders': []},
        now: DateTime.utc(2026, 10, 13, 3));
    expect((await client().get('/admin/customers/7'))['customer']['balance'], 300000);
  });

  test('offline: with writes queued the copy wins even over a fresher cache (their effects are only there)', () async {
    await cache.write(ResponseCache.keyFor('/admin/customers/7', null), {'customer': {'id': 7, 'balance': 500000}, 'ledger': [], 'orders': []},
        now: DateTime.utc(2026, 10, 13, 5));
    localEdits = true;
    expect((await client().get('/admin/customers/7'))['customer']['balance'], 300000);
  });

  test('offline: a page neither copied nor cached is a network error', () async {
    await expectLater(client().get('/admin/reports'), throwsA(isA<ApiException>().having((e) => e.isNetwork, 'network', isTrue)));
  });
}
