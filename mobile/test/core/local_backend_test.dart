import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:cocoffee_mobile/core/local/local_api_client.dart';
import 'package:cocoffee_mobile/core/local/local_backend.dart';
import 'package:cocoffee_mobile/core/local/local_db.dart';
import 'package:cocoffee_mobile/features/orders/orders_models.dart';
import 'package:cocoffee_mobile/features/pos/pos_models.dart';
import 'package:cocoffee_mobile/features/reports/report_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// "Dùng trên máy này": the blank SQLite shop, its setup, and the API answers the screens read (same JSON as the server).
void main() {
  sqfliteFfiInit();

  // 2026-10-23 10:00 in the shop (UTC+7).
  final now = DateTime.utc(2026, 10, 23, 3);
  late LocalDb db;
  late LocalApiClient api;

  LocalDb newDb() => LocalDb(databaseFactoryFfi, inMemoryDatabasePath);

  setUp(() async {
    db = newDb();
    api = LocalApiClient(LocalBackend(db, clock: () => now));
  });
  tearDown(() => db.close());

  Future<void> setUpShop({bool sample = true}) =>
      db.setUp(shopName: 'Quán Mộc', fullName: 'Chủ Quán', username: 'Admin', password: 'mat-khau-dai-1', sampleMenu: sample, now: now);

  Future<ApiException> failure(Future<Object?> f) async {
    try {
      await f;
    } on ApiException catch (e) {
      return e;
    }
    fail('expected an ApiException');
  }

  group('local database setup', () {
    test('a blank file has no shop; setup stores the shop name, a hashed admin password and the sample menu', () async {
      expect(await db.isSetUp(), isFalse);
      await setUpShop();
      expect(await db.isSetUp(), isTrue);
      expect(await db.meta('shop.name'), 'Quán Mộc');

      final d = await db.database();
      final user = (await d.query('users')).single;
      expect(user['username'], 'admin', reason: 'stored lower-case like the server');
      expect(user['role'], 'admin');
      expect('${user['password_hash']}', isNot(contains('mat-khau')));
      expect(user['password_hash'], LocalDb.hashPassword('mat-khau-dai-1', '${user['salt']}'));

      final bootstrap = PosData.fromJson(await api.get('/pos/bootstrap'));
      expect(bootstrap.categories.map((c) => c.name), ['Đồ uống', 'Đồ ăn vặt']);
      expect(bootstrap.products.length, 7);
      expect(bootstrap.tables, isEmpty, reason: 'takeaway only on the phone');
    });

    test('without sample dishes the menu is empty but has a first group; a second setup is refused', () async {
      await setUpShop(sample: false);
      final menu = await api.get('/admin/menu');
      expect(menu['products'], isEmpty);
      expect((menu['categories'] as List).single['name'], 'Đồ uống');
      expect(() => setUpShop(), throwsA(isA<StateError>()));
    });

    test('wipe deletes everything: the next use is a blank shop', () async {
      final path = '${await databaseFactoryFfi.getDatabasesPath()}/local_shop_wipe_test.db';
      final file = LocalDb(databaseFactoryFfi, path);
      await file.setUp(shopName: 'Quán', fullName: 'Chủ', username: 'admin', password: 'mat-khau-dai-1');
      expect(await file.isSetUp(), isTrue);
      await file.wipe();
      expect(await databaseFactoryFfi.databaseExists(path), isFalse);
      expect(await file.isSetUp(), isFalse);
      await file.wipe();
    });
  });

  group('local API', () {
    setUp(() => setUpShop());

    test('sign-in with the local admin account; a wrong password is BAD_CREDENTIALS; change-password', () async {
      final res = await api.post('/auth/login', {'username': 'ADMIN ', 'password': 'mat-khau-dai-1'});
      expect(res['token'], LocalBackend.token);
      expect((res['user'] as Map)['role'], 'admin');
      expect((await failure(api.post('/auth/login', {'username': 'admin', 'password': 'sai'}))).code, 'BAD_CREDENTIALS');
      expect(((await api.get('/auth/me'))['user'] as Map)['full_name'], 'Chủ Quán');

      expect((await failure(api.post('/auth/change-password', {'current_password': 'mat-khau-dai-1', 'new_password': 'ngan'}))).code, 'WEAK_PASSWORD');
      expect((await failure(api.post('/auth/change-password', {'current_password': 'sai-roi', 'new_password': 'mat-khau-moi-2'}))).code, 'BAD_CREDENTIALS');
      await api.post('/auth/change-password', {'current_password': 'mat-khau-dai-1', 'new_password': 'mat-khau-moi-2'});
      expect((await api.post('/auth/login', {'username': 'admin', 'password': 'mat-khau-moi-2'}))['token'], LocalBackend.token);
    });

    test('POS checkout: a paid order with its lines, the change, and it shows in orders, dashboard and report', () async {
      final res = await api.post('/pos/checkout', {
        'items': [
          {'product_id': 2, 'quantity': 2, 'note': 'ít đá'},
          {'product_id': 4, 'quantity': 1},
        ],
        'method': 'cash',
        'tendered': 100000,
        'discount': 5000,
      });
      final order = res['order'] as Map;
      expect(order['status'], 'completed');
      expect(order['payment_status'], 'paid');
      expect(order['subtotal'], 80000);
      expect(order['total'], 75000);
      expect(res['change'], 25000);
      expect(order['order_code'], 'MN261023-00001');

      final detail = OrderDetail.fromJson(await api.get('/orders/${order['id']}', query: {'include': 'payments'}));
      expect(detail.items.map((i) => '${i.quantity}× ${i.productName}'), ['2× Cà phê sữa', '1× Trà đào']);
      expect(detail.items.first.note, 'ít đá');
      expect(detail.payments.single.amount, 75000);
      expect(detail.payments.single.receivedByName, 'Chủ Quán');

      final page = OrdersPage.fromJson(await api.get('/orders', query: {'page': 1}));
      expect(page.total, 1);
      expect(page.orders.single.itemCount, 3);
      expect(page.counts!.completed, 1);
      expect(page.counts!.revenue, 75000);

      final dash = await api.get('/admin/dashboard');
      expect((dash['today'] as Map)['revenue'], 75000);
      expect((dash['today'] as Map)['orders'], 1);
      expect((dash['best_sellers'] as List).first['product_name'], 'Cà phê sữa');

      final report = ReportData.fromJson(await api.get('/admin/reports', query: {'from': '2026-10-23', 'to': '2026-10-23'}), today: '2026-10-23');
      expect(report.summary.revenue, 75000);
      expect(report.days.single.revenue, 75000);
      expect(report.hours[10].revenue, 75000, reason: '10:00 shop time');
      expect(report.byPayment.single.method, 'cash');
      expect(report.top.first.name, 'Cà phê sữa');

      final receipt = await api.get('/orders/${order['id']}/receipt');
      expect(receipt['shop_name'], 'Quán Mộc');
      expect((receipt['payments'] as List).single['method'], 'cash');
    });

    test('hold keeps an open order; pay completes it later; a paid order cannot be cancelled', () async {
      final held = (await api.post('/pos/hold', {'items': [{'product_id': 1, 'quantity': 1}], 'note': 'khách quen'}))['order'] as Map;
      expect(held['status'], 'open');
      expect(held['note'], 'khách quen');

      // The POS reopens it and saves new lines.
      final updated = (await api.post('/pos/hold', {'order_id': held['id'], 'items': [{'product_id': 1, 'quantity': 3}]}))['order'] as Map;
      expect(updated['id'], held['id']);
      expect(updated['total'], 60000);
      expect((await api.get('/admin/dashboard'))['counts'], {'drafts': 0, 'open_orders': 1, 'unpaid': 0});

      expect((await failure(api.post('/orders/${held['id']}/pay', {'method': 'cash', 'tendered': 50000}))).code, 'INSUFFICIENT_PAYMENT');
      final paid = await api.post('/orders/${held['id']}/pay', {'method': 'transfer'});
      expect((paid['order'] as Map)['status'], 'completed');
      expect((await failure(api.post('/orders/${held['id']}/cancel'))).code, 'ORDER_NOT_CANCELLABLE');

      final other = (await api.post('/pos/hold', {'items': [{'product_id': 3, 'quantity': 1}]}))['order'] as Map;
      expect(((await api.post('/orders/${other['id']}/cancel'))['order'] as Map)['status'], 'cancelled');
      final open = await api.get('/orders', query: {'status': 'open'});
      expect(open['orders'], isEmpty);
    });

    test('business errors: empty cart, stopped dish, missing order', () async {
      expect((await failure(api.post('/pos/checkout', {'items': const [], 'method': 'cash'}))).code, 'EMPTY_ORDER');
      await api.put('/products/1', {'is_active': false});
      expect((await failure(api.post('/pos/checkout', {'items': [{'product_id': 1, 'quantity': 1}], 'method': 'cash'}))).code, 'PRODUCT_UNAVAILABLE');
      expect((await failure(api.get('/orders/99'))).code, 'ORDER_NOT_FOUND');
      final bootstrap = PosData.fromJson(await api.get('/pos/bootstrap'));
      expect(bootstrap.products.any((p) => p.id == 1), isFalse, reason: 'a stopped dish leaves the POS');
    });

    test('menu: add a group and a dish (code optional), rename, hide; duplicates are refused', () async {
      final cat = await api.post('/categories', {'code': 'banh', 'name': 'Bánh', 'sort_order': 3});
      expect(cat['id'], isA<int>());
      expect((await failure(api.post('/categories', {'code': 'banh', 'name': 'Bánh 2'}))).code, 'DUPLICATE');
      final p = (await api.post('/products', {'category_id': cat['id'], 'sku': '', 'name': 'Bánh flan', 'price': 15000}))['product'] as Map;
      expect(p['sku'], isNotEmpty);
      expect(p['category_name'], 'Bánh');
      await api.put('/products/${p['id']}', {'name': 'Bánh flan caramen', 'price': 18000});
      expect(((await api.get('/products/${p['id']}'))['product'] as Map)['price'], 18000);
      await api.put('/categories/${cat['id']}', {'is_active': false});
      final active = await api.get('/categories');
      expect((active['categories'] as List).any((c) => c['id'] == cat['id']), isFalse);
      expect((await failure(api.post('/products', {'category_id': 999, 'name': 'X', 'price': 1}))).code, 'VALIDATION');
    });

    test('what needs a server answers LOCAL_UNSUPPORTED (in Vietnamese)', () async {
      for (final path in ['/sync/snapshot', '/admin/customers', '/expenses', '/admin/settings', '/inventory/1']) {
        final e = await failure(api.get(path));
        expect(e.code, 'LOCAL_UNSUPPORTED', reason: path);
        expect(e.message, contains('trên máy này'));
      }
      expect((await failure(api.post('/heli/chat', {'text': 'x'}))).code, 'LOCAL_UNSUPPORTED');
      expect(await api.ping(), isTrue, reason: 'the phone is always reachable');
      expect((await api.get('/tables'))['tables'], isEmpty);
    });
  });

  test('order codes follow the shop day (UTC+7)', () async {
    final late = LocalDb(databaseFactoryFfi, inMemoryDatabasePath);
    addTearDown(late.close);
    await late.setUp(shopName: 'Q', fullName: 'Chủ', username: 'admin', password: 'mat-khau-dai-1', sampleMenu: true);
    // 23:30 on 22/10 UTC is 06:30 on 23/10 in the shop.
    final client = LocalApiClient(LocalBackend(late, clock: () => DateTime.utc(2026, 10, 22, 23, 30)));
    final res = await client.post('/pos/checkout', {'items': [{'product_id': 1, 'quantity': 1}], 'method': 'card'});
    expect((res['order'] as Map)['order_code'], startsWith('MN261023-'));
    final today = await client.get('/admin/reports', query: {'from': '2026-10-23', 'to': '2026-10-23'});
    expect((today['summary'] as Map)['orders'], 1);
  });
}
