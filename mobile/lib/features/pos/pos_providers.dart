import 'dart:math' as math;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/session.dart';
import 'pos_models.dart';

/// GET /api/pos/bootstrap -> { categories, products, tables, drafts, zalo, printer }
final posBootstrapProvider = FutureProvider.autoDispose<PosData>((ref) async {
  final res = await ref.watch(apiProvider).get('/pos/bootstrap');
  return PosData.fromJson(res);
});

/// GET /api/zalo/drafts -> { drafts: [{ id, chat_type, last_activity_at, expires_at, order_id, order_code, total }] }
/// (live drafts only: the session waits for the customer's "ok" and has not expired). Polled by the POS screen.
final zaloDraftsProvider = FutureProvider.autoDispose<List<ZaloDraft>>((ref) async {
  final res = await ref.watch(apiProvider).get('/zalo/drafts');
  return [for (final d in mapList(res['drafts'])) ZaloDraft.fromJson(d)];
});

/// Confirmed Zalo orders still to collect: GET /api/orders?source=zalo&status=completed&payment=unpaid.
/// payment_status is filtered here too, in case the server ignores the payment filter.
final zaloUnpaidProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.watch(apiProvider).get('/orders', query: {'source': 'zalo', 'status': 'completed', 'payment': 'unpaid', 'limit': 50});
  return [for (final o in mapList(res['orders'])) if (o['payment_status'] == 'unpaid') o];
});

/// GET /api/orders/:id -> { order: OrderWithItems } (read-only view of a Zalo draft).
final posOrderProvider = FutureProvider.autoDispose.family<Map<String, dynamic>, int>((ref, id) async {
  final res = await ref.watch(apiProvider).get('/orders/$id');
  return Map<String, dynamic>.from(res['order'] as Map);
});

/// POST /api/orders/:id/pay for an order that already exists and is not in the cart (a confirmed Zalo order).
Future<PayOutcome> payExistingOrder(ApiClient api, int orderId, PayRequest req) async {
  final res = await api.post('/orders/$orderId/pay', {
    'method': req.method,
    if (req.tendered != null && req.tendered! > 0) 'tendered': req.tendered,
    if (req.reference != null && req.reference!.isNotEmpty) 'reference': req.reference,
  });
  return PayOutcome(order: Map<String, dynamic>.from(res['order'] as Map), change: toNum(res['change']));
}

/// The cart of the counter. Kept while the signed-in user stays the same (an admin can hop to the Web Admin
/// screens and come back), emptied when the account changes.
final cartProvider = NotifierProvider<CartNotifier, CartState>(CartNotifier.new);

class CartNotifier extends Notifier<CartState> {
  @override
  CartState build() {
    ref.watch(currentUserProvider.select((u) => u?.id));
    return const CartState();
  }

  ApiClient get _api => ref.read(apiProvider);

  void _set(CartState s) {
    if (ref.mounted) state = s;
  }

  void _busy(bool on) {
    if (ref.mounted && state.busy != on) state = state.copyWith(busy: on);
  }

  /// Tap on a product: +1 on its plain line (no note), else a new line. Max 99 per line.
  void add(PosProduct p) {
    final lines = [...state.lines];
    final i = lines.indexWhere((l) => l.productId == p.id && l.note.isEmpty);
    if (i >= 0) {
      lines[i] = lines[i].copyWith(qty: math.min(kMaxLineQty, lines[i].qty + 1));
    } else {
      lines.add(CartLine(productId: p.id, name: p.name, price: p.price, qty: 1, imageUrl: p.imageUrl));
    }
    state = state.copyWith(lines: lines, dirty: true);
  }

  /// Stepper; quantity 0 removes the line.
  void changeQty(int index, int delta) {
    if (index < 0 || index >= state.lines.length) return;
    final lines = [...state.lines];
    final q = math.min(kMaxLineQty, lines[index].qty + delta);
    if (q <= 0) {
      lines.removeAt(index);
    } else {
      lines[index] = lines[index].copyWith(qty: q);
    }
    state = state.copyWith(lines: lines, dirty: true);
  }

  void removeAt(int index) {
    if (index < 0 || index >= state.lines.length) return;
    state = state.copyWith(lines: [...state.lines]..removeAt(index), dirty: true);
  }

  void setLineNote(int index, String note) {
    if (index < 0 || index >= state.lines.length) return;
    final v = note.trim();
    final lines = [...state.lines];
    lines[index] = lines[index].copyWith(note: v.length > kMaxNote ? v.substring(0, kMaxNote) : v);
    state = state.copyWith(lines: lines, dirty: true);
  }

  /// "Ghi chú cho đơn" (sent when the order is created; the API cannot change it on an open order).
  void setNote(String note) {
    final v = note.trim();
    state = state.copyWith(note: v.length > kMaxNote ? v.substring(0, kMaxNote) : v, dirty: true);
  }

  /// "Giảm giá (đ)": rounded, >= 0; the display clamps it to the subtotal.
  void setDiscount(num value) {
    final v = math.max(0, value.round());
    if (v != state.discount) state = state.copyWith(discount: v, dirty: true);
  }

  /// Empties the cart; with [keepTable] the chosen table stays (a new cart for the same table).
  void reset({bool keepTable = false}) => _set(CartState(tableId: keepTable && state.orderId == null ? state.tableId : null));

  /// Takeaway (null) or a free table. A new cart moves to it; a loaded order is dropped (like selectTable on the web).
  void useTable(int? tableId) {
    if (state.orderId != null) {
      state = CartState(tableId: tableId);
    } else {
      state = state.copyWith(tableId: tableId);
    }
  }

  /// Loads the open order of a busy table: GET /api/orders/:id. Its lines replace the cart.
  Future<Map<String, dynamic>> openOrder(int orderId, PosData data) async {
    _busy(true);
    try {
      final res = await _api.get('/orders/$orderId');
      final o = Map<String, dynamic>.from(res['order'] as Map);
      if (o['status'] != 'open') {
        throw ApiException(code: 'ORDER_NOT_OPEN', status: 409, message: 'Đơn này không còn mở.');
      }
      final lines = [
        for (final it in mapList(o['items'])) CartLine.fromOrderItem(it, data.product(toInt(it['product_id']))),
      ];
      _set(CartState(
        tableId: toIntOrNull(o['table_id']),
        orderId: toInt(o['id'] ?? orderId),
        orderCode: strOrNull(o['order_code']),
        lines: lines,
        discount: toNum(o['discount']),
        note: '${o['note'] ?? ''}',
      ));
      return o;
    } finally {
      _busy(false);
    }
  }

  /// POST /api/orders { table_id?, items, note? } for a new order, PUT /api/orders/:id/items { items } for an open one.
  Future<(Map<String, dynamic>, bool created)> _save() async {
    final items = [for (final l in state.lines) l.toJson()];
    final id = state.orderId;
    if (id != null) {
      final res = await _api.put('/orders/$id/items', {'items': items});
      return (Map<String, dynamic>.from(res['order'] as Map), false);
    }
    final res = await _api.post('/orders', {
      if (state.tableId != null) 'table_id': state.tableId,
      'items': items,
      if (state.note.isNotEmpty) 'note': state.note,
    });
    return (Map<String, dynamic>.from(res['order'] as Map), true);
  }

  /// "Giữ đơn" / "Lưu đơn": keeps the order on its table (pay later), then starts a new takeaway cart.
  Future<Map<String, dynamic>> hold() async {
    _busy(true);
    try {
      final (order, _) = await _save();
      _set(const CartState());
      return order;
    } finally {
      _busy(false);
    }
  }

  /// "Thanh toán": saves the cart (create or update) then POST /api/orders/:id/pay. When the payment of a
  /// just-created order fails, the order is cancelled again (POST /api/orders/:id/cancel), as the web checkout
  /// does, so a failed sale leaves nothing half done.
  Future<PayOutcome> checkout(PayRequest req) async {
    _busy(true);
    Map<String, dynamic>? created;
    var saved = false;
    try {
      final (order, isNew) = await _save();
      saved = true;
      if (isNew) created = order;
      final id = toInt(order['id']);
      final res = await _api.post('/orders/$id/pay', {
        'method': req.method,
        if (req.tendered != null && req.tendered! > 0) 'tendered': req.tendered,
        'discount': math.min(req.discount, state.subtotal),
        if (req.reference != null && req.reference!.isNotEmpty) 'reference': req.reference,
      });
      final out = PayOutcome(order: Map<String, dynamic>.from(res['order'] as Map), change: toNum(res['change']), tableId: state.tableId);
      _set(const CartState());
      return out;
    } catch (e) {
      if (created != null) {
        final id = toInt(created['id']);
        try {
          await _api.post('/orders/$id/cancel');
        } catch (_) {
          // Could not cancel (connection lost): keep the order so a retry updates it instead of creating another.
          if (ref.mounted) state = state.copyWith(orderId: id, orderCode: strOrNull(created['order_code']));
        }
      } else if (saved && ref.mounted) {
        state = state.copyWith(dirty: false); // the lines were saved on the open order
      }
      rethrow;
    } finally {
      _busy(false);
    }
  }

  /// "Hủy đơn" (admin): POST /api/orders/:id/cancel; the table is released.
  Future<void> cancelOpen() async {
    final id = state.orderId;
    if (id == null) return;
    _busy(true);
    try {
      await _api.post('/orders/$id/cancel');
      _set(const CartState());
    } finally {
      _busy(false);
    }
  }
}
