import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/offline/connectivity.dart';
import 'package:cocoffee_mobile/core/offline/offline_db.dart';
import 'package:cocoffee_mobile/core/offline/outbox.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:cocoffee_mobile/features/finance/finance_data.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../../helpers/test_app.dart';

ApiException net() => ApiException(code: 'OFFLINE', message: 'Mất mạng');

void main() {
  sqfliteFfiInit();
  late MockApi api;
  late OfflineDb db;
  late ProviderContainer c;

  setUp(() async {
    api = MockApi();
    db = OfflineDb(() => OfflineDb.openAt(databaseFactoryFfi, inMemoryDatabasePath, singleInstance: false));
    await db.replaceSnapshot({
      'generated_at': '2026-10-13T04:00:00.000Z', 'role': 'admin', 'categories': [], 'products': [], 'tables': [],
      'inventory': {'items': [], 'stock_value': 0}, 'customers': [], 'customer_stats': {'total_customers': 0, 'debt_customers': 0, 'total_debt': 0}, 'orders': [],
    });
    c = await testContainer(api, user: adminUser);
    c = ProviderContainer(overrides: [
      sessionStoreProvider.overrideWithValue(c.read(sessionStoreProvider)),
      apiProvider.overrideWithValue(api),
      currentUserProvider.overrideWithValue(adminUser),
      networkEventsProvider.overrideWithValue(() => const Stream<bool>.empty()),
      offlineDbProvider.overrideWithValue(db),
    ]);
    addTearDown(c.dispose);
  });

  const input = ExpenseInput(date: '2026-10-18', categoryId: 3, amount: 120000, payee: 'Chợ', note: 'Đá viên');

  test('online: the expense is sent at once with an Idempotency-Key', () async {
    when(() => api.post(any(), any(), any())).thenAnswer((_) async => {'expense': {'id': 9, 'amount': 120000}});
    final out = await c.read(financeActionsProvider).create(input);
    expect(out.queued, isFalse);
    final args = verify(() => api.post('/expenses', captureAny(), captureAny())).captured;
    expect((args[0] as Map)['amount'], 120000);
    expect((args[1] as Map)['Idempotency-Key'], startsWith('off-'));
    expect(c.read(outboxProvider).items, isEmpty);
  });

  test('no connection: queued with the same key, and the line shows in the outbox', () async {
    when(() => api.post(any(), any(), any())).thenThrow(net());
    final out = await c.read(financeActionsProvider).create(input);
    expect(out.queued, isTrue);
    final key = (verify(() => api.post(any(), any(), captureAny())).captured.single as Map)['Idempotency-Key'];
    final item = c.read(outboxProvider).items.single;
    expect(item.id, key);
    expect(item.kind, 'expense.create');
    expect(item.title, 'Ghi chi phí');
    expect(item.total, 120000);
    expect(item.path, '/expenses');
    expect(item.body['category_id'], 3);
    expect(item.local['payee'], 'Chợ');
  });

  test('a business refusal (locked period) is not queued: it reaches the form', () async {
    when(() => api.post(any(), any(), any())).thenThrow(ApiException(code: 'PERIOD_LOCKED', status: 409, message: 'Kỳ đã khóa'));
    await expectLater(c.read(financeActionsProvider).create(input), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'PERIOD_LOCKED')));
    expect(c.read(outboxProvider).items, isEmpty);
  });

  test('replay: the queued expense is sent when the phone is online again', () async {
    when(() => api.post(any(), any(), any())).thenThrow(net());
    await c.read(financeActionsProvider).create(input);
    when(() => api.post(any(), any(), any())).thenAnswer((_) async => {'expense': {'id': 9}});
    await c.read(outboxProvider.notifier).sync();
    expect(c.read(outboxProvider).items, isEmpty);
    expect(c.read(outboxProvider).synced.single.kind, 'expense.create');
  });
}
