import 'package:cocoffee_mobile/core/offline/offline_db.dart';
import 'package:cocoffee_mobile/core/offline/offline_resolver.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

Map<String, dynamic> order(int id, String status, String pay, {String source = 'pos', int? table, int? customer, String at = '2026-10-13T03:00:00.000Z', double total = 50000}) => {
      'id': id, 'order_code': 'CF-$id', 'source': source, 'status': status, 'payment_status': pay, 'total': total, 'table_id': table,
      'customer_id': customer, 'created_at': at,
      'items': [{'product_id': 1, 'product_name': 'Cà phê', 'quantity': 2, 'unit_price': 25000}],
      'payments': pay == 'paid' ? [{'id': id, 'method': 'cash', 'amount': total}] : [],
    };

Map<String, dynamic> snapshot() => {
      'generated_at': '2026-10-13T04:00:00.000Z',
      'role': 'admin',
      'categories': [
        {'id': 1, 'code': 'drink', 'name': 'Đồ uống', 'sort_order': 1, 'is_active': 1},
        {'id': 2, 'code': 'old', 'name': 'Cũ', 'sort_order': 2, 'is_active': 0},
      ],
      'products': [
        {'id': 1, 'category_id': 1, 'sku': 'CF', 'name': 'Cà phê sữa đá', 'price': 25000, 'is_active': 1, 'image_url': null},
        {'id': 2, 'category_id': 1, 'sku': 'TD', 'name': 'Trà đào', 'price': 30000, 'is_active': 0, 'image_url': null},
      ],
      'tables': [
        {'id': 1, 'code': 'B01', 'name': 'Bàn 1', 'status': 'serving', 'current_order_id': 7, 'current_order_total': 50000, 'is_active': 1},
        {'id': 2, 'code': 'B02', 'name': 'Bàn 2', 'status': 'available', 'current_order_id': null, 'is_active': 0},
      ],
      'drafts': [{'id': 1, 'order_code': 'CF-D'}],
      'printer': {'autoPrint': true, 'showVat': true, 'vatRate': 8, 'paperMm': 80},
      'inventory': {
        'items': [
          {'id': 1, 'name': 'Cà phê rang xay', 'sku': 'CF', 'is_active': 1, 'is_low': 0},
          {'id': 2, 'name': 'Sữa tươi', 'sku': 'SUA', 'is_active': 1, 'is_low': 1},
          {'id': 3, 'name': 'Ly cũ', 'sku': 'LY', 'is_active': 0, 'is_low': 0},
        ],
        'stock_value': 123456,
      },
      'customers': [
        {'id': 1, 'name': 'Chị Lan', 'phone': '0909000111', 'zalo_user_id': 'z-1', 'balance': 120000, 'order_count': 2, 'updated_at': '2026-10-13T03:00:00.000Z'},
        {'id': 2, 'name': 'Anh Tuấn', 'phone': '0912345678', 'zalo_user_id': null, 'balance': 0, 'order_count': 0, 'updated_at': '2026-10-12T03:00:00.000Z'},
        for (var i = 3; i < 40; i++)
          {'id': i, 'name': 'Khách $i', 'phone': null, 'zalo_user_id': null, 'balance': 0, 'order_count': 0, 'updated_at': '2026-10-01T0${i % 9}:00:00.000Z'},
      ],
      'customer_stats': {'total_customers': 39, 'debt_customers': 1, 'total_debt': 120000},
      'orders': [
        order(9, 'completed', 'unpaid', source: 'zalo', customer: 1, total: 79000),
        order(8, 'cancelled', 'unpaid'),
        order(7, 'open', 'unpaid', table: 1),
        order(6, 'completed', 'paid', at: '2026-10-12T20:00:00.000Z'), // 03:00 on the 13th in Vietnam
        order(5, 'completed', 'paid', at: '2026-10-10T03:00:00.000Z'),
      ],
    };

void main() {
  sqfliteFfiInit();
  late OfflineDb db;
  late OfflineResolver r;

  setUp(() async {
    db = OfflineDb(() => OfflineDb.openAt(databaseFactoryFfi, inMemoryDatabasePath, singleInstance: false));
    await db.replaceSnapshot(snapshot());
    r = OfflineResolver(db);
  });

  test('foldVi ignores case and diacritics', () {
    expect(foldVi('Cà PHÊ Đá'), 'ca phe da');
    expect(foldVi('Nguyễn Thị Hương'), 'nguyen thi huong');
  });

  test('nothing is answered before the first copy; disabled database answers nothing', () async {
    final empty = OfflineResolver(OfflineDb(() => OfflineDb.openAt(databaseFactoryFfi, inMemoryDatabasePath, singleInstance: false)));
    expect(await empty.resolve('/tables', null), isNull);
    expect(await OfflineResolver(OfflineDb.disabled()).resolve('/tables', null), isNull);
    expect(await db.syncedAt(), DateTime.utc(2026, 10, 13, 4));
    expect((await db.counts())['customers'], 39);
  });

  test('POS bootstrap: active menu, active tables, drafts, printer', () async {
    final b = (await r.resolve('/pos/bootstrap', null))!;
    expect((b['categories'] as List).map((c) => c['name']), ['Đồ uống']);
    expect((b['products'] as List).map((p) => p['id']), [1]);
    expect((b['tables'] as List).single['code'], 'B01');
    expect((b['drafts'] as List).single['order_code'], 'CF-D');
    expect(b['printer'], {'autoPrint': true, 'vatRate': 8, 'paperMm': 80});
  });

  test('menu, tables and stock lists with their ?all / ?low flags', () async {
    expect(((await r.resolve('/products', {'all': '1'}))!['products'] as List).length, 2);
    expect(((await r.resolve('/products', null))!['products'] as List).length, 1);
    expect(((await r.resolve('/tables', {'all': 1}))!['tables'] as List).length, 2);
    expect(((await r.resolve('/categories', null))!['categories'] as List).length, 1);
    final all = (await r.resolve('/inventory', {'all': '1'}))!;
    expect((all['items'] as List).length, 3);
    expect(all['stock_value'], 123456);
    expect(((await r.resolve('/inventory', {'low': '1'}))!['items'] as List).single['name'], 'Sữa tươi');
    expect(((await r.resolve('/inventory', null))!['items'] as List).length, 2);
  });

  test('customers: search without diacritics, by phone, debt and zalo filters, paging, stats', () async {
    var l = (await r.resolve('/admin/customers', {'q': 'chi lan'}))!;
    expect((l['customers'] as List).single['name'], 'Chị Lan');
    l = (await r.resolve('/admin/customers', {'q': '0912'}))!;
    expect((l['customers'] as List).single['name'], 'Anh Tuấn');
    l = (await r.resolve('/admin/customers', {'debt': '1'}))!;
    expect((l['customers'] as List).single['id'], 1);
    l = (await r.resolve('/admin/customers', {'zalo': '1'}))!;
    expect((l['customers'] as List).single['id'], 1);
    l = (await r.resolve('/admin/customers', {'page': 2}))!;
    expect(l['total'], 39);
    expect(l['pages'], 2);
    expect(l['page'], 2);
    expect((l['customers'] as List).length, 14);
    expect(l['stats'], {'total_customers': 39, 'debt_customers': 1, 'total_debt': 120000});
    l = (await r.resolve('/admin/customers', null))!;
    expect((l['customers'] as List).first['id'], 1, reason: 'newest update first');
  });

  test('orders: tab filters, "chưa thu" excludes cancelled, table, code search, shop-day range, counts', () async {
    List ids(Map<String, dynamic> m) => (m['orders'] as List).map((o) => o['id']).toList();
    var o = (await r.resolve('/orders', {'page': 1}))!;
    expect(ids(o), [9, 8, 7, 6, 5], reason: 'newest first');
    expect(o['counts'], {'all': 5, 'draft': 0, 'open': 1, 'completed': 3, 'cancelled': 1, 'unpaid': 1, 'revenue': 79000 + 50000 + 50000, 'unpaidAmount': 79000, 'openAmount': 50000});
    expect((o['orders'] as List).first['item_count'], 2);
    expect((o['orders'] as List).first.containsKey('items'), isFalse);

    o = (await r.resolve('/orders', {'status': 'completed', 'payment': 'unpaid', 'source': 'zalo'}))!;
    expect(ids(o), [9]);
    o = (await r.resolve('/orders', {'payment': 'unpaid'}))!;
    expect(ids(o), [9, 7], reason: 'cancelled orders never need collecting');
    o = (await r.resolve('/orders', {'table_id': 1}))!;
    expect(ids(o), [7]);
    o = (await r.resolve('/orders', {'q': 'CF-6'}))!;
    expect(ids(o), [6]);
    o = (await r.resolve('/orders', {'date_from': '2026-10-13', 'date_to': '2026-10-13'}))!;
    expect(ids(o), [9, 8, 7, 6], reason: 'order 6 is 03:00 on the 13th in Vietnam');
    expect((o['counts'] as Map)['all'], 4, reason: 'counts follow the date filter but not the status');

    o = (await r.resolve('/orders', {'page': 1, 'page_size': 2}))!;
    expect(ids(o), [9, 8]);
    expect(o['pages'], 3);
    o = (await r.resolve('/orders', {'page': 9, 'page_size': 2}))!;
    expect(o['page'], 3, reason: 'clamped to the last page');
    expect(ids(o), [5]);
  });

  test('one order, with or without payments; unknown ids and paths are not answered', () async {
    var d = (await r.resolve('/orders/6', {'include': 'payments'}))!;
    expect((d['order']['items'] as List).length, 1);
    expect((d['payments'] as List).single['method'], 'cash');
    expect(d['order'].containsKey('payments'), isFalse);
    d = (await r.resolve('/orders/6', null))!;
    expect(d.containsKey('payments'), isFalse);
    expect(await r.resolve('/orders/999', null), isNull);
    expect(await r.resolve('/admin/reports', null), isNull);
  });

  test('customer page only from the copy when asked (detail fallback), with his orders', () async {
    expect(await r.resolve('/admin/customers/1', null), isNull);
    final d = (await r.resolve('/admin/customers/1', null, detail: true))!;
    expect(d['customer']['name'], 'Chị Lan');
    expect((d['orders'] as List).single['id'], 9);
    expect(d['ledger'], isEmpty);
  });

  test('a new snapshot replaces the old rows; a cashier snapshot keeps the customers it does not carry', () async {
    final s = snapshot()
      ..['role'] = 'cashier'
      ..remove('customers')
      ..['orders'] = [order(10, 'open', 'unpaid')];
    await db.replaceSnapshot(s);
    expect(((await r.resolve('/orders', {'page': 1}))!['orders'] as List).map((o) => o['id']), [10]);
    expect((await r.resolve('/admin/customers', null))!['total'], 39);
  });
}
