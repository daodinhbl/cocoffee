import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';

int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
int? _intOrNull(Object? v) => v == null ? null : (v is num ? v.toInt() : int.tryParse('$v'));
num? _numOrNull(Object? v) => v == null ? null : (v is num ? v : num.tryParse('$v'));

/// tableModel.listAll() row: { id, code, name, capacity, status, current_order_id, is_active, current_order_code,
/// current_order_total }.
class DiningTable {
  const DiningTable({
    required this.id,
    required this.code,
    required this.name,
    required this.capacity,
    required this.status,
    required this.currentOrderId,
    required this.isActive,
    required this.currentOrderCode,
    required this.currentOrderTotal,
  });

  factory DiningTable.fromJson(Map<String, dynamic> j) {
    final active = j['is_active'];
    return DiningTable(
      id: _int(j['id']),
      code: '${j['code'] ?? ''}',
      name: '${j['name'] ?? ''}',
      capacity: _int(j['capacity']),
      status: '${j['status'] ?? 'available'}',
      currentOrderId: _intOrNull(j['current_order_id']),
      isActive: active == null || active == true || active == 1 || active == '1',
      currentOrderCode: j['current_order_code'] == null ? null : '${j['current_order_code']}',
      currentOrderTotal: _numOrNull(j['current_order_total']),
    );
  }

  final int id;
  final String code;
  final String name;
  final int capacity;
  final String status;
  final int? currentOrderId;
  final bool isActive;
  final String? currentOrderCode;
  final num? currentOrderTotal;

  bool get serving => isActive && status == 'serving';
}

Duration? _noRetry(int _, Object _) => null;

/// Admins: GET /api/tables?all=1 (inactive included). Cashiers: GET /api/tables (active only).
/// Order like the web: active first, then by code.
final tablesProvider = FutureProvider.autoDispose<List<DiningTable>>((ref) async {
  final api = ref.watch(apiProvider);
  final admin = ref.watch(currentUserProvider)?.isAdmin ?? false;
  final res = await api.get('/tables', query: admin ? {'all': 1} : null);
  final rows = [for (final r in (res['tables'] as List? ?? const [])) if (r is Map) DiningTable.fromJson(Map<String, dynamic>.from(r))];
  return [...rows.where((t) => t.isActive), ...rows.where((t) => !t.isActive)];
}, retry: _noRetry);
