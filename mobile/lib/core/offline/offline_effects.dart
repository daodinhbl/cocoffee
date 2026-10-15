import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../api/api_client.dart';
import 'offline_db.dart';

num _num(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;

/// The record is not in the copy (created elsewhere after the last snapshot): nothing to apply the write to, and no
/// figure to show — the write is refused rather than queued with a made-up answer.
ApiException _noCopy(String what) =>
    ApiException(code: 'OFFLINE_NO_COPY', message: '$what chưa có trong dữ liệu ngoại tuyến trên máy này. Hãy kết nối mạng để thực hiện thao tác.');

/// What a write queued while offline does to the local copy, so the lists and totals on screen already show it.
/// The server stays the source of truth: the next snapshot (taken once the queue is empty) replaces all of it.
extension OfflineEffects on OfflineDb {
  Future<Database> _db() async {
    final d = await database();
    if (d == null) throw ApiException(code: 'OFFLINE_DB', message: 'Không mở được dữ liệu ngoại tuyến trên máy này.');
    return d;
  }

  Future<Map<String, dynamic>?> _row(Database d, String table, int id) async {
    final rows = await d.query(table, columns: ['data'], where: 'id = ?', whereArgs: [id], limit: 1);
    return rows.isEmpty ? null : Map<String, dynamic>.from(jsonDecode('${rows.first['data']}') as Map);
  }

  /// Customer balance moves by [delta] (collection: negative, extra debt: positive). Returns the new balance.
  /// `updated_at` stays: on the server a ledger entry does not touch the customer row, so the list keeps its order.
  Future<num> addCustomerBalance(int id, num delta) async {
    final d = await _db();
    final data = await _row(d, 'customers', id);
    if (data == null) throw _noCopy('Khách hàng');
    final before = _num(data['balance']);
    final balance = before + delta;
    data['balance'] = balance;
    await d.update('customers', {'balance': balance.toDouble(), 'data': jsonEncode(data)}, where: 'id = ?', whereArgs: [id]);
    await _bumpDebtStats(before: before, after: balance);
    return balance;
  }

  /// Header totals of the customers screen follow the balance change.
  Future<void> _bumpDebtStats({required num before, required num after}) async {
    final stats = await metaJson('customer_stats');
    if (stats is! Map) return;
    final s = Map<String, dynamic>.from(stats);
    final owedBefore = before > 0 ? before : 0;
    final owedAfter = after > 0 ? after : 0;
    s['total_debt'] = _num(s['total_debt']) + owedAfter - owedBefore;
    s['debt_customers'] = _num(s['debt_customers']) + (owedAfter > 0 ? 1 : 0) - (owedBefore > 0 ? 1 : 0);
    await setMeta('customer_stats', jsonEncode(s));
  }

  /// Adds a row at the top of a customer's ledger copy (a collection or an adjustment made offline).
  Future<void> addLedgerEntry(int customerId, {required String type, required num amount, String? method, String? note}) async {
    final existing = await metaJson('ledger:$customerId');
    final rows = existing is List ? [...existing] : <dynamic>[];
    rows.insert(0, {
      'id': -DateTime.now().millisecondsSinceEpoch, 'entry_type': type, 'amount': amount, 'method': method, 'note': note,
      'created_at': DateTime.now().toUtc().toIso8601String(), 'order_id': null, 'order_code': null, 'created_by_name': null,
    });
    await setMeta('ledger:$customerId', jsonEncode(rows));
  }

  /// Like the server after a collection: the customer's debt orders become paid, oldest first, while the money
  /// collected so far covers them. Returns the codes of the orders settled now. The copy holds the recent orders and
  /// the newest ledger rows only, so this can settle fewer orders than the server will at replay, never more.
  Future<List<String>> settleOrdersLocally(int customerId, {required String method}) async {
    final d = await _db();
    final rows = await d.query('orders', where: "customer_id = ? AND status = 'completed'", whereArgs: [customerId], orderBy: 'created_ms, id');
    if (rows.isEmpty) return const [];
    final orders = [for (final r in rows) Map<String, dynamic>.from(jsonDecode('${r['data']}') as Map)];
    final ledger = await metaJson('ledger:$customerId');
    num pool;
    if (ledger is List && ledger.length < 50) {
      pool = ledger.fold<num>(0, (s, e) => e is Map && e['entry_type'] == 'payment' ? s - _num(e['amount']) : s);
    } else {
      // Ledger history incomplete: money paid = everything ever owed on these orders minus what is still owed.
      final customer = await _row(d, 'customers', customerId);
      pool = orders.fold<num>(0, (s, o) => s + _num(o['total'])) - _num(customer?['balance']);
    }
    final settled = <String>[];
    final now = DateTime.now().toUtc().toIso8601String();
    for (final o in orders) {
      final total = _num(o['total']);
      if (pool < total) break;
      pool -= total;
      if (o['payment_status'] == 'paid') continue;
      o['payment_status'] = 'paid';
      o['payment_method'] = method;
      o['paid_at'] = now;
      final payments = o['payments'] is List ? [...o['payments'] as List] : <dynamic>[];
      payments.add({'id': -DateTime.now().millisecondsSinceEpoch, 'method': method, 'amount': total, 'reference': 'Thu nợ khách hàng', 'paid_at': now});
      o['payments'] = payments;
      await d.update('orders', {'payment_status': 'paid', 'data': jsonEncode(o)}, where: 'id = ?', whereArgs: [o['id']]);
      settled.add('${o['order_code'] ?? ''}');
    }
    return settled;
  }

  /// A customer created offline, under a temporary negative [id].
  Future<Map<String, dynamic>> insertCustomer(int id, {required String name, String? phone, String? zaloUserId, String? note}) async {
    final now = DateTime.now().toUtc().toIso8601String();
    final data = <String, dynamic>{
      'id': id, 'name': name, 'phone': phone, 'zalo_user_id': zaloUserId, 'note': note,
      'created_at': now, 'updated_at': now, 'balance': 0, 'order_count': 0,
    };
    final d = await _db();
    await d.insert(
      'customers',
      {
        'id': id, 'name_norm': foldVi(name), 'phone': phone ?? '', 'zalo': zaloUserId ?? '', 'balance': 0.0,
        'updated_ms': DateTime.now().millisecondsSinceEpoch, 'data': jsonEncode(data),
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
    final stats = await metaJson('customer_stats');
    if (stats is Map) {
      final s = Map<String, dynamic>.from(stats);
      s['total_customers'] = _num(s['total_customers']) + 1;
      await setMeta('customer_stats', jsonEncode(s));
    }
    return data;
  }

  /// Edits a customer (the keys of [fields] are the API's: name, phone, zalo_user_id, note).
  Future<Map<String, dynamic>> patchCustomer(int id, Map<String, dynamic> fields) async {
    final d = await _db();
    final data = await _row(d, 'customers', id);
    if (data == null) throw _noCopy('Khách hàng');
    data
      ..addAll(fields)
      ..['updated_at'] = DateTime.now().toUtc().toIso8601String();
    await d.update(
      'customers',
      {
        'name_norm': foldVi('${data['name'] ?? ''}'), 'phone': '${data['phone'] ?? ''}', 'zalo': '${data['zalo_user_id'] ?? ''}',
        'updated_ms': DateTime.now().millisecondsSinceEpoch, 'data': jsonEncode(data),
      },
      where: 'id = ?',
      whereArgs: [id],
    );
    return data;
  }

  /// Stock moves: a receipt adds [receiveQuantity] at [unitCost] (moving-average cost), otherwise the count sets the
  /// quantity to [newQuantity]. The total stock value of the active items follows. Returns
  /// { quantity_on_hand, avg_cost, delta }.
  Future<Map<String, dynamic>> moveStock(int id, {num? receiveQuantity, num? unitCost, num? newQuantity}) async {
    final d = await _db();
    final data = await _row(d, 'inventory', id);
    if (data == null) throw _noCopy('Nguyên liệu');
    final q = _num(data['quantity_on_hand']);
    final cost = _num(data['avg_cost']);
    final valueBefore = data['stock_value'] == null ? q * cost : _num(data['stock_value']);
    num next;
    num avg = cost;
    if (receiveQuantity != null) {
      next = q + receiveQuantity;
      if (next > 0 && unitCost != null) avg = double.parse(((q * cost + receiveQuantity * unitCost) / next).toStringAsFixed(4));
    } else {
      next = newQuantity ?? q;
    }
    final min = _num(data['min_stock']);
    final valueAfter = double.parse((next * avg).toStringAsFixed(2));
    data
      ..['quantity_on_hand'] = next
      ..['avg_cost'] = avg
      ..['is_low'] = next <= min ? 1 : 0
      ..['stock_value'] = valueAfter;
    await d.update('inventory', {'is_low': next <= min ? 1 : 0, 'data': jsonEncode(data)}, where: 'id = ?', whereArgs: [id]);
    final active = data['is_active'] == null || data['is_active'] == 1 || data['is_active'] == true;
    final total = num.tryParse(await meta('inventory_stock_value') ?? '');
    if (active && total != null) await setMeta('inventory_stock_value', (total + valueAfter - valueBefore).toStringAsFixed(2));
    return {'quantity_on_hand': next, 'avg_cost': avg, 'delta': next - q};
  }

  /// An order cancelled from the phone: its status, and its table is free again.
  Future<Map<String, dynamic>> cancelOrderLocally(int id) async {
    final d = await _db();
    final data = await _row(d, 'orders', id);
    if (data == null) throw _noCopy('Đơn hàng');
    data['status'] = 'cancelled';
    await d.update('orders', {'status': 'cancelled', 'data': jsonEncode(data)}, where: 'id = ?', whereArgs: [id]);
    final tableId = data['table_id'];
    if (tableId is num) {
      final table = await _row(d, 'tables', tableId.toInt());
      if (table != null && table['current_order_id'] == id) {
        table
          ..['status'] = 'available'
          ..['current_order_id'] = null
          ..['current_order_total'] = null;
        await d.update('tables', {'data': jsonEncode(table)}, where: 'id = ?', whereArgs: [tableId.toInt()]);
      }
    }
    return data;
  }
}
