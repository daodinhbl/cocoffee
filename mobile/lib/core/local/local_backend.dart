import 'dart:math' as math;

import 'package:sqflite/sqflite.dart';

import '../api/api_client.dart';
import 'local_db.dart';

/// The local mode's "server": answers the app's API calls (same paths, same JSON shapes as src/routes/index.js) from
/// the phone's SQLite file, so the screens run unchanged. It covers the core of a small shop:
///  - menu: GET /categories, /products, /products/:id, /admin/menu; POST/PUT /categories, /products;
///  - selling at the POS: GET /pos/bootstrap, POST /pos/checkout, /pos/hold, /orders/:id/pay, /orders/:id/cancel;
///  - orders: GET /orders (filters, pages, counts), /orders/:id, /orders/:id/receipt;
///  - revenue: GET /admin/reports (by day, hour, payment, best sellers), /admin/dashboard (today);
///  - the account: POST /auth/login, /auth/change-password, GET /auth/me.
/// Everything else (tables, stock, recipes, customers and debts, expenses and tax, Zalo, Heli, staff accounts,
/// photos) answers LOCAL_UNSUPPORTED; those screens are hidden in local mode (core/nav.dart, core/router.dart).
class LocalBackend {
  LocalBackend(this.db, {DateTime Function()? clock}) : _now = clock ?? DateTime.now;

  final LocalDb db;
  final DateTime Function() _now;

  static const token = 'local';
  static const minPassword = 10;
  static const _shopOffset = Duration(hours: 7);
  static const _methods = {'cash', 'transfer', 'card'};

  static final _orderId = RegExp(r'^/orders/(\d+)$');
  static final _orderAction = RegExp(r'^/orders/(\d+)/(pay|cancel|receipt)$');
  static final _productId = RegExp(r'^/products/(\d+)$');
  static final _categoryId = RegExp(r'^/categories/(\d+)$');

  // ------------------------------------------------------------------------------------------------- routing

  Future<Map<String, dynamic>> get(String path, Map<String, dynamic> q) async {
    final d = await db.database();
    switch (path) {
      case '/auth/me':
        return {'user': await _user(d)};
      case '/pos/bootstrap':
        return _bootstrap(d);
      case '/settings/printer':
        return {'printer': _printer};
      case '/zalo/drafts':
        return {'drafts': const []};
      case '/zalo/status':
      case '/admin/zalo/status':
        return {'state': 'off', 'label': 'Zalo: không dùng trên máy này'};
      case '/tables':
        return {'tables': const []};
      case '/inventory':
        return {'items': const []};
      case '/categories':
        return {'categories': await _categories(d, all: _on(q['all']))};
      case '/products':
        return {'products': await _products(d, all: _on(q['all']), categoryId: int.tryParse('${q['category_id'] ?? ''}'))};
      case '/admin/menu':
        return {'products': await _products(d, all: true), 'categories': await _categories(d, all: true), 'items': const []};
      case '/orders':
        return _orders(d, q);
      case '/admin/reports':
        return _report(d, q);
      case '/admin/dashboard':
        return _dashboard(d);
      case '/admin/notifications':
        return {'low_stock': const [], 'counts': await _queueCounts(d), 'receipt_errors': const []};
      case '/admin/new-orders':
        return {'last_id': int.tryParse('${q['after_id'] ?? ''}') ?? 0, 'orders': const []};
    }
    final order = _orderId.firstMatch(path);
    if (order != null) {
      final o = await _order(d, int.parse(order.group(1)!));
      final payments = o.remove('payments');
      return {'order': o, if ('${q['include'] ?? ''}'.split(',').contains('payments')) 'payments': payments};
    }
    final action = _orderAction.firstMatch(path);
    if (action != null && action.group(2) == 'receipt') {
      final o = await _order(d, int.parse(action.group(1)!));
      if (o['status'] != 'open' && o['status'] != 'completed') throw _err('NOT_PRINTABLE', 409);
      return {'order': o, 'payments': o.remove('payments'), 'printer': _printer, 'shop_name': await db.meta('shop.name') ?? '', 'vat': null};
    }
    final product = _productId.firstMatch(path);
    if (product != null) return {'product': await _product(d, int.parse(product.group(1)!))};
    throw unsupported();
  }

  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> b) async {
    final d = await db.database();
    switch (path) {
      case '/auth/login':
        return _login(d, b);
      case '/auth/change-password':
        return _changePassword(d, b);
      case '/pos/checkout':
        return _checkout(d, b);
      case '/pos/hold':
        return {'order': await _hold(d, b)};
      case '/categories':
        return _createCategory(d, b);
      case '/products':
        return _createProduct(d, b);
    }
    final action = _orderAction.firstMatch(path);
    if (action != null && action.group(2) == 'pay') return _pay(d, int.parse(action.group(1)!), b);
    if (action != null && action.group(2) == 'cancel') return {'order': await _cancel(d, int.parse(action.group(1)!))};
    throw unsupported();
  }

  Future<Map<String, dynamic>> put(String path, Map<String, dynamic> b) async {
    final d = await db.database();
    final product = _productId.firstMatch(path);
    if (product != null) return _updateProduct(d, int.parse(product.group(1)!), b);
    final category = _categoryId.firstMatch(path);
    if (category != null) return _updateCategory(d, int.parse(category.group(1)!), b);
    throw unsupported();
  }

  static ApiException unsupported() => ApiException(code: 'LOCAL_UNSUPPORTED', status: 501, message: vietnameseFor('LOCAL_UNSUPPORTED', null, null));

  static ApiException _err(String code, int status, [String? message, Object? details]) =>
      ApiException(code: code, status: status, details: details, serverMessage: message, message: vietnameseFor(code, message, details));

  static bool _on(Object? v) => v == true || v == 1 || v == '1' || v == 'true';
  static num _num(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
  static int? _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}');
  static String? _str(Object? v, {int max = 255}) {
    final s = '${v ?? ''}'.trim();
    if (s.isEmpty) return null;
    return s.length > max ? s.substring(0, max) : s;
  }

  static num _money(Object? v) {
    final n = _num(v);
    return n == n.roundToDouble() ? n.round() : n;
  }

  String _nowIso() => _now().toUtc().toIso8601String();

  static const _printer = {'autoPrint': false, 'showVat': false, 'vatRate': 0, 'paperMm': 80};

  // ------------------------------------------------------------------------------------------------- account

  static Map<String, dynamic> _publicUser(Map<String, Object?> u) =>
      {'id': u['id'], 'username': u['username'], 'full_name': u['full_name'], 'role': u['role'], 'is_active': 1, 'must_change_password': false};

  Future<Map<String, dynamic>> _user(Database d) async {
    final rows = await d.query('users', orderBy: 'id', limit: 1);
    if (rows.isEmpty) throw _err('UNAUTHORIZED', 401);
    return _publicUser(rows.first);
  }

  Future<Map<String, dynamic>> _login(Database d, Map<String, dynamic> b) async {
    final username = '${b['username'] ?? ''}'.trim().toLowerCase();
    final rows = await d.query('users', where: 'username = ?', whereArgs: [username], limit: 1);
    final ok = rows.isNotEmpty && LocalDb.hashPassword('${b['password'] ?? ''}', '${rows.first['salt']}') == rows.first['password_hash'];
    if (!ok) throw _err('BAD_CREDENTIALS', 401);
    return {'token': token, 'must_change_password': false, 'user': _publicUser(rows.first)};
  }

  Future<Map<String, dynamic>> _changePassword(Database d, Map<String, dynamic> b) async {
    final next = '${b['new_password'] ?? ''}';
    if (next.length < minPassword) throw _err('WEAK_PASSWORD', 400);
    final rows = await d.query('users', orderBy: 'id', limit: 1);
    if (rows.isEmpty) throw _err('UNAUTHORIZED', 401);
    final u = rows.first;
    final current = '${b['current_password'] ?? ''}';
    if (LocalDb.hashPassword(current, '${u['salt']}') != u['password_hash']) throw _err('BAD_CREDENTIALS', 401);
    if (next == current) throw _err('VALIDATION', 400, 'Mật khẩu mới phải khác mật khẩu hiện tại.');
    final salt = LocalDb.newSalt();
    await d.update('users', {'salt': salt, 'password_hash': LocalDb.hashPassword(next, salt)}, where: 'id = ?', whereArgs: [u['id']]);
    return {'ok': true, 'token': token};
  }

  // ---------------------------------------------------------------------------------------------------- menu

  static Map<String, dynamic> _categoryJson(Map<String, Object?> r) =>
      {'id': r['id'], 'code': r['code'], 'name': r['name'], 'sort_order': r['sort_order'], 'is_active': r['is_active']};

  Future<List<Map<String, dynamic>>> _categories(Database d, {bool all = false}) async {
    final rows = await d.query('categories', where: all ? null : 'is_active = 1', orderBy: 'sort_order, id');
    return [for (final r in rows) _categoryJson(r)];
  }

  static Map<String, dynamic> _productJson(Map<String, Object?> r) => {
        'id': r['id'],
        'category_id': r['category_id'],
        'category_name': r['category_name'],
        'sku': r['sku'],
        'name': r['name'],
        'price': _money(r['price']),
        'stock_mode': 'direct',
        'inventory_item_id': null,
        'inventory_item_name': null,
        'is_active': r['is_active'],
        'image_url': null,
        'aliases': [r['name']],
      };

  static const _productSelect = 'SELECT p.*, c.name AS category_name, c.sort_order AS category_sort FROM products p '
      'LEFT JOIN categories c ON c.id = p.category_id';

  Future<List<Map<String, dynamic>>> _products(Database d, {bool all = false, int? categoryId}) async {
    final where = <String>[];
    final args = <Object?>[];
    if (!all) where.add('p.is_active = 1');
    if (categoryId != null) {
      where.add('p.category_id = ?');
      args.add(categoryId);
    }
    final rows = await d.rawQuery(
      '$_productSelect ${where.isEmpty ? '' : 'WHERE ${where.join(' AND ')}'} ORDER BY ${all ? 'p.is_active DESC, ' : ''}category_sort, p.name COLLATE NOCASE',
      args,
    );
    return [for (final r in rows) _productJson(r)];
  }

  Future<Map<String, dynamic>> _product(Database d, int id) async {
    final rows = await d.rawQuery('$_productSelect WHERE p.id = ?', [id]);
    if (rows.isEmpty) throw _err('NOT_FOUND', 404);
    return _productJson(rows.first);
  }

  Future<void> _checkCategory(Database d, Object? id) async {
    final c = _int(id);
    if (c == null || (await d.query('categories', where: 'id = ?', whereArgs: [c], limit: 1)).isEmpty) {
      throw _err('VALIDATION', 400, 'Chọn nhóm món.');
    }
  }

  static int _price(Object? v) {
    final p = _num(v);
    if (v == null || p < 0 || p > 100000000) throw _err('VALIDATION', 400, 'Giá bán chưa hợp lệ.');
    return p.round();
  }

  static String _name(Object? v, String what) {
    final s = _str(v, max: 150);
    if (s == null) throw _err('VALIDATION', 400, 'Nhập $what.');
    return s;
  }

  Future<Map<String, dynamic>> _createCategory(Database d, Map<String, dynamic> b) async {
    final name = _name(b['name'], 'tên nhóm');
    var code = (_str(b['code'], max: 40) ?? '').toLowerCase();
    if (code.isEmpty) code = 'nhom-${_now().millisecondsSinceEpoch}';
    try {
      final id = await d.insert('categories', {'code': code, 'name': name, 'sort_order': _int(b['sort_order']) ?? 0, 'is_active': 1});
      return _categoryJson((await d.query('categories', where: 'id = ?', whereArgs: [id])).first);
    } on DatabaseException catch (e) {
      if (e.isUniqueConstraintError()) throw _err('DUPLICATE', 409);
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _updateCategory(Database d, int id, Map<String, dynamic> b) async {
    final patch = <String, Object?>{
      if (b.containsKey('name')) 'name': _name(b['name'], 'tên nhóm'),
      if (b.containsKey('sort_order')) 'sort_order': _int(b['sort_order']) ?? 0,
      if (b.containsKey('is_active')) 'is_active': _on(b['is_active']) ? 1 : 0,
    };
    if (patch.isNotEmpty && await d.update('categories', patch, where: 'id = ?', whereArgs: [id]) == 0) throw _err('NOT_FOUND', 404);
    final rows = await d.query('categories', where: 'id = ?', whereArgs: [id]);
    if (rows.isEmpty) throw _err('NOT_FOUND', 404);
    return {'category': _categoryJson(rows.first)};
  }

  Future<Map<String, dynamic>> _createProduct(Database d, Map<String, dynamic> b) async {
    final name = _name(b['name'], 'tên món');
    await _checkCategory(d, b['category_id']);
    var sku = (_str(b['sku'], max: 40) ?? '').toUpperCase();
    if (sku.isEmpty) sku = 'M${_now().millisecondsSinceEpoch}';
    try {
      final id = await d.insert('products', {
        'category_id': _int(b['category_id']),
        'sku': sku,
        'name': name,
        'price': _price(b['price']),
        'is_active': 1,
        'created_at': _nowIso(),
      });
      return {'product': await _product(d, id)};
    } on DatabaseException catch (e) {
      if (e.isUniqueConstraintError()) throw _err('DUPLICATE', 409);
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _updateProduct(Database d, int id, Map<String, dynamic> b) async {
    if (b.containsKey('category_id')) await _checkCategory(d, b['category_id']);
    final patch = <String, Object?>{
      if (b.containsKey('name')) 'name': _name(b['name'], 'tên món'),
      if (b.containsKey('price')) 'price': _price(b['price']),
      if (b.containsKey('category_id')) 'category_id': _int(b['category_id']),
      if (b.containsKey('is_active')) 'is_active': _on(b['is_active']) ? 1 : 0,
    };
    if (patch.isNotEmpty && await d.update('products', patch, where: 'id = ?', whereArgs: [id]) == 0) throw _err('NOT_FOUND', 404);
    return {'product': await _product(d, id)};
  }

  /// GET /pos/bootstrap: active groups and dishes; no tables, no Zalo in local mode (takeaway sales).
  Future<Map<String, dynamic>> _bootstrap(Database d) async {
    final categories = await _categories(d);
    final active = {for (final c in categories) c['id']};
    return {
      'categories': [for (final c in categories) {'id': c['id'], 'code': c['code'], 'name': c['name']}],
      'products': [
        for (final p in await _products(d))
          if (active.contains(p['category_id'])) {'id': p['id'], 'category_id': p['category_id'], 'name': p['name'], 'price': p['price'], 'image_url': null},
      ],
      'tables': const [],
      'drafts': const [],
      'zalo': {'state': 'off', 'label': 'Zalo: không dùng trên máy này'},
      'printer': {'autoPrint': false, 'vatRate': 0, 'paperMm': 80},
    };
  }

  // -------------------------------------------------------------------------------------------------- orders

  Future<Map<String, dynamic>> _order(DatabaseExecutor d, int id) async {
    final rows = await d.query('orders', where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) throw _err('ORDER_NOT_FOUND', 404);
    final items = await d.query('order_items', where: 'order_id = ?', whereArgs: [id], orderBy: 'id');
    final payments = await d.rawQuery(
      'SELECT p.*, u.full_name AS received_by_name FROM payments p LEFT JOIN users u ON u.id = p.received_by WHERE p.order_id = ? ORDER BY p.id',
      [id],
    );
    return {
      ..._orderRow(rows.first),
      'item_count': items.fold<num>(0, (s, i) => s + _num(i['quantity'])),
      'items': [
        for (final i in items)
          {
            'id': i['id'], 'product_id': i['product_id'], 'product_name': i['product_name'], 'unit_price': _money(i['unit_price']),
            'quantity': i['quantity'], 'line_total': _money(i['line_total']), 'note': i['note'],
          },
      ],
      'payments': [
        for (final p in payments)
          {'id': p['id'], 'method': p['method'], 'amount': _money(p['amount']), 'reference': p['reference'], 'paid_at': p['paid_at'], 'received_by_name': p['received_by_name']},
      ],
    };
  }

  static Map<String, dynamic> _orderRow(Map<String, Object?> o) => {
        'id': o['id'],
        'order_code': o['order_code'],
        'source': 'pos',
        'status': o['status'],
        'payment_status': o['payment_status'],
        'payment_method': o['payment_method'],
        'subtotal': _money(o['subtotal']),
        'discount': _money(o['discount']),
        'total': _money(o['total']),
        'cogs_total': null,
        'table_id': null,
        'table_code': null,
        'table_name': null,
        'customer_id': null,
        'customer_name': null,
        'note': o['note'],
        'created_at': o['created_at'],
        'completed_at': o['completed_at'],
        'paid_at': o['paid_at'],
        'receipt_sent_at': null,
        'receipt_error': null,
        if (o.containsKey('item_count')) 'item_count': o['item_count'],
      };

  /// The cart lines of a sale or a held order, priced from the menu as it is now (like the server does).
  Future<List<Map<String, Object?>>> _lines(DatabaseExecutor d, Object? raw) async {
    final items = [for (final e in (raw is List ? raw : const [])) if (e is Map) e];
    if (items.isEmpty) throw _err('EMPTY_ORDER', 400);
    final out = <Map<String, Object?>>[];
    for (final it in items) {
      final id = _int(it['product_id']);
      final qty = _int(it['quantity']) ?? 0;
      if (id == null || qty < 1 || qty > 99) throw _err('VALIDATION', 400, 'Số lượng mỗi món từ 1 đến 99.');
      final rows = await d.query('products', where: 'id = ?', whereArgs: [id], limit: 1);
      if (rows.isEmpty || rows.first['is_active'] != 1) throw _err('PRODUCT_UNAVAILABLE', 409);
      final price = _num(rows.first['price']);
      out.add({'product_id': id, 'product_name': rows.first['name'], 'unit_price': price, 'quantity': qty, 'line_total': price * qty, 'note': _str(it['note'])});
    }
    return out;
  }

  /// A new open order, or the lines of an open one replaced. Returns its id.
  Future<int> _save(Transaction tx, Map<String, dynamic> b, List<Map<String, Object?>> lines) async {
    final subtotal = lines.fold<num>(0, (s, l) => s + _num(l['line_total']));
    final existing = _int(b['order_id']);
    late int id;
    if (existing != null) {
      final rows = await tx.query('orders', where: 'id = ?', whereArgs: [existing], limit: 1);
      if (rows.isEmpty) throw _err('ORDER_NOT_FOUND', 404);
      if (rows.first['status'] != 'open') throw _err('ORDER_NOT_OPEN', 409);
      id = existing;
      final discount = math.min(_num(rows.first['discount']), subtotal);
      await tx.update('orders', {'subtotal': subtotal, 'discount': discount, 'total': subtotal - discount}, where: 'id = ?', whereArgs: [id]);
      await tx.delete('order_items', where: 'order_id = ?', whereArgs: [id]);
    } else {
      final now = _now().toUtc();
      final user = await tx.query('users', columns: ['id'], orderBy: 'id', limit: 1);
      id = await tx.insert('orders', {
        'order_code': 'TMP',
        'status': 'open',
        'payment_status': 'unpaid',
        'subtotal': subtotal,
        'discount': 0,
        'total': subtotal,
        'note': _str(b['note']),
        'created_by': user.isEmpty ? null : user.first['id'],
        'created_at': now.toIso8601String(),
        'created_ms': now.millisecondsSinceEpoch,
      });
      await tx.update('orders', {'order_code': _code(now, id)}, where: 'id = ?', whereArgs: [id]);
    }
    for (final l in lines) {
      await tx.insert('order_items', {...l, 'order_id': id});
    }
    return id;
  }

  /// "MN261023-00012": MN (máy này) + shop day + number, like the server's CF261013-00042.
  static String _code(DateTime utc, int id) {
    final t = utc.add(_shopOffset);
    String two(int n) => n.toString().padLeft(2, '0');
    return 'MN${two(t.year % 100)}${two(t.month)}${two(t.day)}-${id.toString().padLeft(5, '0')}';
  }

  Future<Map<String, dynamic>> _hold(Database d, Map<String, dynamic> b) async {
    final id = await d.transaction((tx) async => _save(tx, b, await _lines(tx, b['items'])));
    return _order(d, id);
  }

  /// Completes order [id] and records the payment. Returns the change for cash.
  Future<num> _settle(Transaction tx, int id, Map<String, dynamic> b, {num? discount}) async {
    final method = '${b['method'] ?? ''}';
    if (!_methods.contains(method)) throw _err('VALIDATION', 400, 'Chọn hình thức thanh toán.');
    final rows = await tx.query('orders', where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) throw _err('ORDER_NOT_FOUND', 404);
    final o = rows.first;
    final payable = o['status'] == 'open' || (o['status'] == 'completed' && o['payment_status'] == 'unpaid');
    if (!payable) throw _err('ORDER_NOT_PAYABLE', 409);
    final subtotal = _num(o['subtotal']);
    final cut = discount == null ? _num(o['discount']) : math.max<num>(0, math.min(discount, subtotal));
    final total = subtotal - cut;
    final tendered = b['tendered'] == null ? null : _num(b['tendered']);
    if (method == 'cash' && tendered != null && tendered > 0 && tendered < total) throw _err('INSUFFICIENT_PAYMENT', 400);
    final now = _now().toUtc();
    final at = now.toIso8601String();
    final user = await tx.query('users', columns: ['id'], orderBy: 'id', limit: 1);
    await tx.update(
      'orders',
      {
        'status': 'completed', 'payment_status': 'paid', 'payment_method': method, 'discount': cut, 'total': total, 'paid_at': at,
        'completed_at': o['completed_at'] ?? at, 'completed_ms': o['completed_ms'] ?? now.millisecondsSinceEpoch,
      },
      where: 'id = ?',
      whereArgs: [id],
    );
    await tx.insert('payments', {
      'order_id': id, 'method': method, 'amount': total, 'tendered': tendered, 'reference': _str(b['reference'], max: 100),
      'received_by': user.isEmpty ? null : user.first['id'], 'paid_at': at,
    });
    return method == 'cash' && tendered != null && tendered > total ? tendered - total : 0;
  }

  /// POST /pos/checkout: saves the cart and takes the payment in one step (nothing is left behind on an error).
  Future<Map<String, dynamic>> _checkout(Database d, Map<String, dynamic> b) async {
    late int id;
    final change = await d.transaction((tx) async {
      id = await _save(tx, b, await _lines(tx, b['items']));
      return _settle(tx, id, b, discount: _num(b['discount']));
    });
    return {'order': await _order(d, id), 'change': _money(change)};
  }

  Future<Map<String, dynamic>> _pay(Database d, int id, Map<String, dynamic> b) async {
    final change = await d.transaction((tx) => _settle(tx, id, b, discount: b.containsKey('discount') ? _num(b['discount']) : null));
    return {'order': await _order(d, id), 'change': _money(change)};
  }

  Future<Map<String, dynamic>> _cancel(Database d, int id) async {
    final rows = await d.query('orders', where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) throw _err('ORDER_NOT_FOUND', 404);
    if (rows.first['status'] != 'open' && rows.first['status'] != 'draft') throw _err('ORDER_NOT_CANCELLABLE', 409);
    await d.update('orders', {'status': 'cancelled', 'cancelled_at': _nowIso()}, where: 'id = ?', whereArgs: [id]);
    return _order(d, id);
  }

  /// A shop day "YYYY-MM-DD" as UTC milliseconds [start of day, start of next day).
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

  /// GET /orders: status, source, payment, q (order code), date_from/date_to, page(+page_size) or limit/offset.
  Future<Map<String, dynamic>> _orders(Database d, Map<String, dynamic> q) async {
    String? s(String k) => _str(q[k]);
    final common = <String>[];
    final cArgs = <Object?>[];
    final source = s('source');
    if (source != null && source != 'pos') common.add('0'); // only POS sales on this phone
    if (s('table_id') != null) common.add('0');
    final bounds = _dayBounds(q['date_from'], q['date_to']);
    if (bounds != null) {
      common.add('created_ms >= ? AND created_ms < ?');
      cArgs.addAll([bounds.$1, bounds.$2]);
    }
    if (s('q') != null) {
      common.add(r"order_code LIKE ? ESCAPE '\'");
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
    final pageSize = paged ? (_int(q['page_size']) ?? 25).clamp(1, 100) : (_int(q['limit']) ?? 50).clamp(1, 200);
    final pages = total == 0 ? 1 : (total / pageSize).ceil();
    final page = paged ? (_int(q['page']) ?? 1).clamp(1, pages) : 1;
    final offset = paged ? (page - 1) * pageSize : (_int(q['offset']) ?? 0).clamp(0, 1 << 30);
    final rows = await d.rawQuery(
      'SELECT o.*, (SELECT COALESCE(SUM(quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS item_count '
      'FROM orders o ${clause(where)} ORDER BY o.id DESC LIMIT $pageSize OFFSET $offset',
      args,
    );
    final groups = await d.rawQuery(
      'SELECT status, payment_status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders ${clause(common)} GROUP BY status, payment_status',
      cArgs,
    );
    final counts = <String, num>{'all': 0, 'draft': 0, 'open': 0, 'completed': 0, 'cancelled': 0, 'unpaid': 0, 'revenue': 0, 'unpaid_amount': 0, 'open_amount': 0};
    for (final g in groups) {
      final n = g['n'] as int;
      final amount = _num(g['amount']);
      final st = '${g['status']}';
      counts['all'] = counts['all']! + n;
      if (counts.containsKey(st)) counts[st] = counts[st]! + n;
      if (st == 'completed') counts['revenue'] = counts['revenue']! + amount;
      if (st == 'completed' && g['payment_status'] == 'unpaid') {
        counts['unpaid'] = counts['unpaid']! + n;
        counts['unpaid_amount'] = counts['unpaid_amount']! + amount;
      }
      if (st == 'open') counts['open_amount'] = counts['open_amount']! + amount;
    }
    return {
      'orders': [for (final r in rows) _orderRow(r)],
      'total': total,
      'page': page,
      'pages': pages,
      'page_size': pageSize,
      'counts': {for (final e in counts.entries) e.key: _money(e.value)},
    };
  }

  // ------------------------------------------------------------------------------------------------- revenue

  String _today() {
    final t = _now().toUtc().add(_shopOffset);
    String two(int n) => n.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)}';
  }

  static String _addDays(String day, int n) {
    final t = DateTime.parse('${day}T12:00:00Z').add(Duration(days: n));
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)}';
  }

  /// Completed sales in the shop-day range: `completed_ms` falls in it (a held order counts on the day it was paid).
  static const _completedIn = "status = 'completed' AND completed_ms >= ? AND completed_ms < ?";

  /// Shop day / hour of a UTC millisecond column, in SQL.
  static const _dayOf = "strftime('%Y-%m-%d', (completed_ms / 1000) + 25200, 'unixepoch')";
  static const _hourOf = "CAST(strftime('%H', (completed_ms / 1000) + 25200, 'unixepoch') AS INTEGER)";

  Future<Map<String, dynamic>> _summary(Database d, (int, int) b) async {
    final r = (await d.rawQuery(
      'SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue, '
      "COALESCE(SUM(CASE WHEN payment_status = 'unpaid' THEN total ELSE 0 END), 0) AS unpaid FROM orders WHERE $_completedIn",
      [b.$1, b.$2],
    ))
        .first;
    final revenue = _money(r['revenue']);
    return {'orders': r['orders'], 'revenue': revenue, 'cogs': 0, 'gross_profit': revenue, 'unpaid': _money(r['unpaid'])};
  }

  Future<List<Map<String, dynamic>>> _top(Database d, (int, int) b, int limit) async {
    final rows = await d.rawQuery(
      'SELECT i.product_id, i.product_name, SUM(i.quantity) AS qty, SUM(i.line_total) AS revenue FROM order_items i '
      'JOIN orders o ON o.id = i.order_id WHERE o.$_completedIn GROUP BY i.product_id, i.product_name ORDER BY revenue DESC, qty DESC LIMIT $limit',
      [b.$1, b.$2],
    );
    return [for (final r in rows) {'product_id': r['product_id'], 'product_name': r['product_name'], 'name': r['product_name'], 'qty': r['qty'], 'revenue': _money(r['revenue']), 'cogs': 0}];
  }

  /// GET /admin/reports?from=&to=: default the last 7 days, at most 366.
  Future<Map<String, dynamic>> _report(Database d, Map<String, dynamic> q) async {
    final day = RegExp(r'^\d{4}-\d{2}-\d{2}$');
    final today = _today();
    var from = day.hasMatch('${q['from'] ?? ''}') ? '${q['from']}' : _addDays(today, -6);
    var to = day.hasMatch('${q['to'] ?? ''}') ? '${q['to']}' : today;
    if (from.compareTo(to) > 0) (from, to) = (to, from);
    var clamped = false;
    if (from.compareTo(_addDays(to, -365)) < 0) {
      from = _addDays(to, -365);
      clamped = true;
    }
    final b = _dayBounds(from, to)!;
    final args = [b.$1, b.$2];
    final summary = await _summary(d, b);
    final days = await d.rawQuery('SELECT $_dayOf AS day, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE $_completedIn GROUP BY day ORDER BY day', args);
    final hours = await d.rawQuery('SELECT $_hourOf AS hour, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE $_completedIn GROUP BY hour ORDER BY hour', args);
    final pay = await d.rawQuery(
      "SELECT CASE WHEN payment_status = 'paid' THEN COALESCE(payment_method, 'other') ELSE 'unpaid' END AS method, COUNT(*) AS orders, SUM(total) AS revenue "
      'FROM orders WHERE $_completedIn GROUP BY method ORDER BY revenue DESC',
      args,
    );
    final orders = _num(summary['orders']);
    return {
      'range': {'from': from, 'to': to, 'clamped': clamped},
      'summary': summary,
      'avg_ticket': orders > 0 ? (_num(summary['revenue']) / orders).round() : 0,
      'days': [for (final r in days) {'day': r['day'], 'orders': r['orders'], 'revenue': _money(r['revenue']), 'cogs': 0}],
      'hours': [for (final r in hours) {'hour': r['hour'], 'orders': r['orders'], 'revenue': _money(r['revenue'])}],
      'by_source': [if (orders > 0) {'source': 'pos', 'orders': summary['orders'], 'revenue': summary['revenue'], 'cogs': 0}],
      'by_payment': [for (final r in pay) {'method': r['method'], 'orders': r['orders'], 'revenue': _money(r['revenue'])}],
      'top_products': await _top(d, b, 10),
    };
  }

  Future<Map<String, dynamic>> _queueCounts(Database d) async {
    final open = Sqflite.firstIntValue(await d.rawQuery("SELECT COUNT(*) FROM orders WHERE status = 'open'")) ?? 0;
    final unpaid = Sqflite.firstIntValue(await d.rawQuery("SELECT COUNT(*) FROM orders WHERE status = 'completed' AND payment_status = 'unpaid'")) ?? 0;
    return {'drafts': 0, 'open_orders': open, 'unpaid': unpaid};
  }

  /// GET /admin/dashboard: today against yesterday, sales per hour, best sellers, the last orders.
  Future<Map<String, dynamic>> _dashboard(Database d) async {
    final today = _today();
    final b = _dayBounds(today, today)!;
    final hours = await d.rawQuery('SELECT $_hourOf AS hour, COUNT(*) AS orders, SUM(total) AS revenue FROM orders WHERE $_completedIn GROUP BY hour', [b.$1, b.$2]);
    final recent = await d.rawQuery('SELECT * FROM orders ORDER BY id DESC LIMIT 5');
    return {
      'day': today,
      'today': await _summary(d, b),
      'yesterday': await _summary(d, _dayBounds(_addDays(today, -1), _addDays(today, -1))!),
      'counts': await _queueCounts(d),
      'recent_orders': [for (final r in recent) _orderRow(r)],
      'hourly': [for (final r in hours) {'hour': r['hour'], 'orders': r['orders'], 'revenue': _money(r['revenue'])}],
      'best_sellers': await _top(d, b, 5),
      'low_stock': const [],
      'low_stock_count': 0,
      'overstock': const [],
      'debtors': const [],
    };
  }
}
