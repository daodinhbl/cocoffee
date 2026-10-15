import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import 'offline_db.dart';

/// Answers GET requests from the offline database, in the exact shape the server returns, so the screens run
/// unchanged without a connection. Covers the list screens whose filters a plain cache cannot serve (customers
/// search, orders filters, menu, tables, stock). Anything it does not know returns null.
///
/// Time: the shop works in Vietnam time (UTC+7); `date_from` / `date_to` are shop days.
class OfflineResolver {
  OfflineResolver(this.db);

  final OfflineDb db;

  static const customersPageSize = 25;
  static const ordersPageSize = 25;
  static const _shopOffset = Duration(hours: 7);

  static final _orderId = RegExp(r'^/orders/(\d+)$');
  static final _customerId = RegExp(r'^/admin/customers/(-?\d+)$');
  static final _inventoryId = RegExp(r'^/inventory/(\d+)$');

  /// [detail] true also answers single-record pages from whatever the copy holds (used after the response cache
  /// missed, because the copy has no ledger or movements).
  Future<Map<String, dynamic>?> resolve(String path, Map<String, dynamic>? query, {bool detail = false}) async {
    final database = await db.database();
    if (database == null || !await db.hasData) return null;
    final q = query ?? const <String, dynamic>{};
    try {
      switch (path) {
        case '/pos/bootstrap':
          return await _bootstrap(database);
        case '/zalo/drafts':
          return {'drafts': await db.metaJson('drafts') ?? const []};
        case '/zalo/status':
        case '/admin/zalo/status':
          return {'state': 'unknown', 'label': 'Ngoại tuyến'};
        case '/tables':
          return {'tables': await _tables(database, all: _on(q['all']))};
        case '/categories':
          return {'categories': await _categories(database, all: _on(q['all']))};
        case '/products':
          return {'products': await _products(database, all: _on(q['all']), categoryId: int.tryParse('${q['category_id'] ?? ''}'))};
        case '/inventory':
          return await _inventory(database, q);
        case '/admin/customers':
          return await _customers(database, q);
        case '/orders':
          return await _orders(database, q);
        case '/settings/printer':
          final p = await db.metaJson('printer');
          return p is Map ? {'printer': p} : null;
      }
      final order = _orderId.firstMatch(path);
      if (order != null) return await _order(database, int.parse(order.group(1)!), q);
      final customer = _customerId.firstMatch(path);
      if (customer != null && detail) return await _customer(database, int.parse(customer.group(1)!));
      final item = _inventoryId.firstMatch(path);
      if (item != null && detail) return await _inventoryItem(database, int.parse(item.group(1)!));
    } catch (_) {
      return null; // a damaged row must never break the screen: fall back to the cache
    }
    return null;
  }

  static bool _on(Object? v) => v == true || v == 1 || v == '1' || v == 'true';

  static Map<String, dynamic> _json(Object? raw) => Map<String, dynamic>.from(jsonDecode('$raw') as Map);

  // ------------------------------------------------------------------------------------------------- menu

  Future<List<Map<String, dynamic>>> _categories(Database d, {bool all = false}) async {
    final rows = await d.query('categories', where: all ? null : 'is_active = 1', orderBy: 'sort, id');
    return [for (final r in rows) _json(r['data'])];
  }

  Future<List<Map<String, dynamic>>> _products(Database d, {bool all = false, int? categoryId}) async {
    final where = <String>[];
    final args = <Object?>[];
    if (!all) where.add('is_active = 1');
    if (categoryId != null) {
      where.add('category_id = ?');
      args.add(categoryId);
    }
    final rows = await d.query('products', where: where.isEmpty ? null : where.join(' AND '), whereArgs: args);
    final cats = {for (final c in await _categories(d, all: true)) c['id']: (c['sort_order'] as num?)?.toInt() ?? 0};
    final list = [for (final r in rows) _json(r['data'])];
    list.sort((a, b) {
      final c = (cats[a['category_id']] ?? 0).compareTo(cats[b['category_id']] ?? 0);
      return c != 0 ? c : foldVi('${a['name']}').compareTo(foldVi('${b['name']}')); // like the server's collation
    });
    return list;
  }

  Future<List<Map<String, dynamic>>> _tables(Database d, {bool all = false}) async {
    final rows = await d.query('tables', where: all ? null : 'is_active = 1', orderBy: all ? 'is_active DESC, code' : 'code');
    return [for (final r in rows) _json(r['data'])];
  }

  /// GET /pos/bootstrap
  Future<Map<String, dynamic>> _bootstrap(Database d) async {
    final categories = await _categories(d);
    final activeCats = {for (final c in categories) c['id']};
    final products = [for (final p in await _products(d)) if (activeCats.contains(p['category_id']) || activeCats.isEmpty) p];
    final printer = await db.metaJson('printer');
    final p = printer is Map ? printer : const {};
    return {
      'categories': [for (final c in categories) {'id': c['id'], 'code': c['code'], 'name': c['name']}],
      'products': [
        for (final x in products) {'id': x['id'], 'category_id': x['category_id'], 'name': x['name'], 'price': x['price'], 'image_url': x['image_url']},
      ],
      'tables': [
        for (final t in await _tables(d))
          {
            'id': t['id'], 'code': t['code'], 'name': t['name'], 'status': t['status'],
            'current_order_id': t['current_order_id'], 'current_order_total': t['current_order_total'],
          },
      ],
      'drafts': await db.metaJson('drafts') ?? const [],
      'zalo': {'state': 'unknown', 'label': 'Ngoại tuyến'},
      'printer': {
        'autoPrint': p['autoPrint'] ?? true,
        'vatRate': p['showVat'] == false ? 0 : (p['vatRate'] ?? 0),
        'paperMm': p['paperMm'] ?? 80,
      },
    };
  }

  // --------------------------------------------------------------------------------------------- inventory

  Future<Map<String, dynamic>> _inventory(Database d, Map<String, dynamic> q) async {
    final all = _on(q['all']);
    final where = <String>[];
    if (!all) where.add('is_active = 1');
    if (_on(q['low'])) where.add('is_low = 1');
    final rows = await d.query('inventory', where: where.isEmpty ? null : where.join(' AND '), orderBy: all ? 'is_active DESC, name_norm' : 'name_norm');
    final out = <String, dynamic>{'items': [for (final r in rows) _json(r['data'])]};
    if (all) out['stock_value'] = num.tryParse(await db.meta('inventory_stock_value') ?? '') ?? 0;
    return out;
  }

  /// GET /inventory/:id: the item row; usage, recipes using it and movements are only known online.
  Future<Map<String, dynamic>?> _inventoryItem(Database d, int id) async {
    final rows = await d.query('inventory', where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return null;
    return {'item': _json(rows.first['data']), 'usage': null, 'used_in': const [], 'movements': const []};
  }

  // --------------------------------------------------------------------------------------------- customers

  /// GET /admin/customers?q=&debt=1&zalo=1&page=
  Future<Map<String, dynamic>> _customers(Database d, Map<String, dynamic> q) async {
    final where = <String>[];
    final args = <Object?>[];
    final text = '${q['q'] ?? ''}'.trim();
    if (text.isNotEmpty) {
      final like = '%${foldVi(text).replaceAll(r'\', r'\\').replaceAll('%', r'\%').replaceAll('_', r'\_')}%';
      where.add(r"(name_norm LIKE ? ESCAPE '\' OR phone LIKE ? ESCAPE '\' OR LOWER(zalo) LIKE ? ESCAPE '\')");
      args.addAll([like, like, like]);
    }
    if (_on(q['debt'])) where.add('balance > 0');
    if (_on(q['zalo'])) where.add("zalo != ''");
    final clause = where.isEmpty ? '' : 'WHERE ${where.join(' AND ')}';
    final total = Sqflite.firstIntValue(await d.rawQuery('SELECT COUNT(*) FROM customers $clause', args)) ?? 0;
    final pages = total == 0 ? 1 : (total / customersPageSize).ceil();
    final page = (int.tryParse('${q['page'] ?? 1}') ?? 1).clamp(1, pages);
    final rows = await d.rawQuery(
      'SELECT data FROM customers $clause ORDER BY updated_ms DESC, id DESC LIMIT $customersPageSize OFFSET ${(page - 1) * customersPageSize}',
      args,
    );
    final stats = await db.metaJson('customer_stats');
    return {
      'customers': [for (final r in rows) _json(r['data'])],
      'total': total,
      'page': page,
      'pages': pages,
      'page_size': customersPageSize,
      'stats': stats is Map ? stats : {'total_customers': total, 'debt_customers': 0, 'total_debt': 0},
    };
  }

  /// GET /admin/customers/:id: the customer, his debt ledger (newest rows, for the customers copied) and his orders.
  Future<Map<String, dynamic>?> _customer(Database d, int id) async {
    final rows = await d.query('customers', where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return null;
    final orders = await d.query('orders', where: 'customer_id = ?', whereArgs: [id], orderBy: 'created_ms DESC', limit: 50);
    return {
      'customer': _json(rows.first['data']),
      'ledger': await db.metaJson('ledger:$id') ?? const [],
      'orders': [for (final o in orders) _orderRow(_json(o['data']))],
    };
  }

  // -------------------------------------------------------------------------------------------------- orders

  /// An order as the list returns it: no lines, with the item count.
  static Map<String, dynamic> _orderRow(Map<String, dynamic> o) {
    final items = o['items'];
    final count = items is List ? items.fold<num>(0, (s, i) => s + (i is Map && i['quantity'] is num ? i['quantity'] as num : 0)) : o['item_count'] ?? 0;
    return {...o..remove('items')..remove('payments'), 'item_count': count};
  }

  /// A shop day 'YYYY-MM-DD' as UTC instants [start of day, start of next day) in milliseconds.
  static (int, int)? _dayBounds(Object? from, Object? to) {
    DateTime? day(Object? v) {
      final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch('${v ?? ''}');
      return m == null ? null : DateTime.utc(int.parse(m.group(1)!), int.parse(m.group(2)!), int.parse(m.group(3)!));
    }

    final a = day(from);
    final b = day(to);
    if (a == null && b == null) return null;
    final start = (a ?? b!).subtract(_shopOffset);
    final end = (b ?? a!).add(const Duration(days: 1)).subtract(_shopOffset);
    return (start.millisecondsSinceEpoch, end.millisecondsSinceEpoch);
  }

  /// GET /orders: status, source, payment, table_id, q (order code), date_from/date_to, page(+page_size) or limit/offset.
  Future<Map<String, dynamic>> _orders(Database d, Map<String, dynamic> q) async {
    String? s(String k) {
      final v = '${q[k] ?? ''}'.trim();
      return v.isEmpty ? null : v;
    }

    final common = <String>[];
    final cArgs = <Object?>[];
    if (s('source') != null) {
      common.add('source = ?');
      cArgs.add(s('source'));
    }
    if (s('table_id') != null) {
      common.add('table_id = ?');
      cArgs.add(int.tryParse(s('table_id')!));
    }
    final bounds = _dayBounds(q['date_from'], q['date_to']);
    if (bounds != null) {
      common.add('created_ms >= ? AND created_ms < ?');
      cArgs.addAll([bounds.$1, bounds.$2]);
    }
    if (s('q') != null) {
      common.add(r"code LIKE ? ESCAPE '\'");
      cArgs.add('%${s('q')!.replaceAll(r'\', r'\\').replaceAll('%', r'\%').replaceAll('_', r'\_')}%');
    }

    final where = [...common];
    final args = [...cArgs];
    final status = s('status');
    final payment = s('payment');
    if (status != null) {
      where.add('status = ?');
      args.add(status);
    }
    if (payment != null) {
      where.add('payment_status = ?');
      args.add(payment);
    }
    if (payment == 'unpaid' && status == null) where.add("status NOT IN ('cancelled', 'draft')");
    String clause(List<String> w) => w.isEmpty ? '' : 'WHERE ${w.join(' AND ')}';

    final total = Sqflite.firstIntValue(await d.rawQuery('SELECT COUNT(*) FROM orders ${clause(where)}', args)) ?? 0;

    final paged = q['page'] != null;
    final pageSize = paged ? (int.tryParse('${q['page_size'] ?? ''}') ?? ordersPageSize).clamp(1, 100) : (int.tryParse('${q['limit'] ?? ''}') ?? 50).clamp(1, 200);
    final pages = total == 0 ? 1 : (total / pageSize).ceil();
    final page = paged ? (int.tryParse('${q['page']}') ?? 1).clamp(1, pages) : 1;
    final offset = paged ? (page - 1) * pageSize : (int.tryParse('${q['offset'] ?? ''}') ?? 0).clamp(0, 1 << 30);
    final rows = await d.rawQuery('SELECT data FROM orders ${clause(where)} ORDER BY id DESC LIMIT $pageSize OFFSET $offset', args);

    final groups = await d.rawQuery(
      'SELECT status, payment_status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders ${clause(common)} GROUP BY status, payment_status',
      cArgs,
    );
    final counts = <String, num>{'all': 0, 'draft': 0, 'open': 0, 'completed': 0, 'cancelled': 0, 'unpaid': 0, 'revenue': 0, 'unpaidAmount': 0, 'openAmount': 0};
    for (final g in groups) {
      final n = g['n'] as int;
      final amount = (g['amount'] as num).toDouble();
      final st = '${g['status']}';
      counts['all'] = counts['all']! + n;
      if (counts.containsKey(st)) counts[st] = counts[st]! + n;
      if (st == 'completed') counts['revenue'] = counts['revenue']! + amount;
      if (st == 'completed' && g['payment_status'] == 'unpaid') {
        counts['unpaid'] = counts['unpaid']! + n;
        counts['unpaidAmount'] = counts['unpaidAmount']! + amount;
      }
      if (st == 'open') counts['openAmount'] = counts['openAmount']! + amount;
    }

    final inCopy = Sqflite.firstIntValue(await d.rawQuery('SELECT COUNT(*) FROM orders')) ?? 0;
    return {
      'orders': [for (final r in rows) _orderRow(_json(r['data']))],
      'total': total,
      'page': page,
      'pages': pages,
      'page_size': pageSize,
      'counts': counts,
      'offline_note': 'Ngoại tuyến: danh sách, tổng số, số trang và các con số tổng chỉ tính trên $inCopy đơn gần nhất có trên máy.',
    };
  }

  /// GET /orders/:id[?include=payments]
  Future<Map<String, dynamic>?> _order(Database d, int id, Map<String, dynamic> q) async {
    final rows = await d.query('orders', where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return null;
    final data = _json(rows.first['data']);
    final payments = data.remove('payments');
    final out = <String, dynamic>{'order': data};
    if ('${q['include'] ?? ''}'.split(',').contains('payments')) out['payments'] = payments is List ? payments : const [];
    return out;
  }
}
