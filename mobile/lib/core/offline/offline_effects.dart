import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import 'offline_db.dart';

num _num(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;

/// What a write queued while offline does to the local copy, so the lists and totals on screen already show it.
/// The server stays the source of truth: the next snapshot replaces all of it.
extension OfflineEffects on OfflineDb {
  Future<Map<String, dynamic>?> _row(Database d, String table, int id) async {
    final rows = await d.query(table, columns: ['data'], where: 'id = ?', whereArgs: [id], limit: 1);
    return rows.isEmpty ? null : Map<String, dynamic>.from(jsonDecode('${rows.first['data']}') as Map);
  }

  /// Customer balance moves by [delta] (collection: negative, extra debt: positive). Returns the new balance.
  Future<num> addCustomerBalance(int id, num delta) async {
    final d = await database();
    if (d == null) return 0;
    final data = await _row(d, 'customers', id);
    if (data == null) return delta;
    final balance = _num(data['balance']) + delta;
    data['balance'] = balance;
    data['updated_at'] = DateTime.now().toUtc().toIso8601String();
    await d.update('customers', {'balance': balance.toDouble(), 'updated_ms': DateTime.now().millisecondsSinceEpoch, 'data': jsonEncode(data)},
        where: 'id = ?', whereArgs: [id]);
    await _bumpDebtStats(d, delta, before: _num(data['balance']) - delta, after: balance);
    return balance;
  }

  /// Header totals of the customers screen follow the balance change.
  Future<void> _bumpDebtStats(Database d, num delta, {required num before, required num after}) async {
    final stats = await metaJson('customer_stats');
    if (stats is! Map) return;
    final s = Map<String, dynamic>.from(stats);
    final owedBefore = before > 0 ? before : 0;
    final owedAfter = after > 0 ? after : 0;
    s['total_debt'] = _num(s['total_debt']) + owedAfter - owedBefore;
    s['debt_customers'] = _num(s['debt_customers']) + (owedAfter > 0 ? 1 : 0) - (owedBefore > 0 ? 1 : 0);
    await setMeta('customer_stats', jsonEncode(s));
  }

  /// A customer created offline, under a temporary negative [id].
  Future<Map<String, dynamic>> insertCustomer(int id, {required String name, String? phone, String? zaloUserId, String? note}) async {
    final now = DateTime.now().toUtc().toIso8601String();
    final data = <String, dynamic>{
      'id': id, 'name': name, 'phone': phone, 'zalo_user_id': zaloUserId, 'note': note,
      'created_at': now, 'updated_at': now, 'balance': 0, 'order_count': 0,
    };
    final d = await database();
    if (d != null) {
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
    }
    return data;
  }

  /// Edits a customer (the keys of [fields] are the API's: name, phone, zalo_user_id, note).
  Future<Map<String, dynamic>> patchCustomer(int id, Map<String, dynamic> fields) async {
    final d = await database();
    final data = d == null ? null : await _row(d, 'customers', id);
    if (d == null || data == null) return {'id': id, ...fields};
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

  /// Stock moves: [receive] adds [quantity] at [unitCost] (moving-average cost), otherwise the count is set to
  /// [newQuantity]. Returns { quantity_on_hand, avg_cost, delta }.
  Future<Map<String, dynamic>> moveStock(int id, {num? receiveQuantity, num? unitCost, num? newQuantity}) async {
    final d = await database();
    final data = d == null ? null : await _row(d, 'inventory', id);
    if (d == null || data == null) return {'quantity_on_hand': newQuantity ?? receiveQuantity ?? 0, 'avg_cost': unitCost ?? 0, 'delta': receiveQuantity ?? 0};
    final q = _num(data['quantity_on_hand']);
    final cost = _num(data['avg_cost']);
    num next;
    num avg = cost;
    if (receiveQuantity != null) {
      next = q + receiveQuantity;
      if (next > 0 && unitCost != null) avg = double.parse(((q * cost + receiveQuantity * unitCost) / next).toStringAsFixed(4));
    } else {
      next = newQuantity ?? q;
    }
    final min = _num(data['min_stock']);
    data
      ..['quantity_on_hand'] = next
      ..['avg_cost'] = avg
      ..['is_low'] = next <= min ? 1 : 0
      ..['stock_value'] = double.parse((next * avg).toStringAsFixed(2));
    await d.update('inventory', {'is_low': next <= min ? 1 : 0, 'data': jsonEncode(data)}, where: 'id = ?', whereArgs: [id]);
    return {'quantity_on_hand': next, 'avg_cost': avg, 'delta': next - q};
  }

  /// An order cancelled from the phone: its status, and its table is free again.
  Future<Map<String, dynamic>?> cancelOrderLocally(int id) async {
    final d = await database();
    final data = d == null ? null : await _row(d, 'orders', id);
    if (d == null || data == null) return null;
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
