import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/api_client.dart';
import '../../core/offline/connectivity.dart';
import '../../core/offline/outbox.dart';
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

/// "2× Cà phê sữa đá, 1× Bạc xỉu" for the sync screen.
String cartSummary(Iterable<CartLine> lines) => lines.map((l) => '${l.qty}× ${l.name}').join(', ');

bool isBlank(CartState s) => s.isEmpty && s.orderId == null && s.localId == null;

/// The cart of the counter. Kept while the signed-in user stays the same (an admin can hop to the Web Admin
/// screens and come back), saved on the device between app starts, emptied when the account changes.
final cartProvider = NotifierProvider<CartNotifier, CartState>(CartNotifier.new);

class CartNotifier extends Notifier<CartState> {
  late String _storeKey;
  bool _restored = false; // nothing is written before the saved cart was read: the empty start must not overwrite it

  @override
  CartState build() {
    final userId = ref.watch(currentUserProvider.select((u) => u?.id));
    final server = ref.watch(serverUrlProvider);
    _storeKey = 'cart:$server:${userId ?? 'anon'}';
    _restored = false;
    listenSelf((_, next) {
      if (_restored) _persist(next);
    });
    Future.microtask(_restore);
    return const CartState();
  }

  ApiClient get _api => ref.read(apiProvider);
  OutboxNotifier get _outbox => ref.read(outboxProvider.notifier);
  bool get _offline => !ref.read(netProvider).online;

  void _set(CartState s) {
    if (ref.mounted) state = s;
  }

  void _busy(bool on) {
    if (ref.mounted && state.busy != on) state = state.copyWith(busy: on);
  }

  void _persist(CartState s) {
    unawaited(ref.read(localStoreProvider).write(_storeKey, jsonEncode(s.toJson())).catchError((Object _) {}));
  }

  /// The cart saved by the last run comes back, unless something was already put in this one.
  Future<void> _restore() async {
    try {
      await _restoreSaved();
    } finally {
      _restored = true;
      if (ref.mounted && (state.lines.isNotEmpty || state.orderId != null || state.localId != null)) _persist(state);
    }
  }

  Future<void> _restoreSaved() async {
    try {
      final raw = await ref.read(localStoreProvider).read(_storeKey);
      if (raw == null || !ref.mounted) return;
      final saved = CartState.fromJson(Map<String, dynamic>.from(jsonDecode(raw) as Map));
      if (!isBlank(saved) && isBlank(state) && !state.busy) state = saved;
    } catch (_) {
      // unreadable: start empty
    }
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
  void reset({bool keepTable = false}) => _set(CartState(tableId: keepTable && state.orderId == null && state.localId == null ? state.tableId : null));

  /// Takeaway (null) or a free table. A new cart moves to it; a loaded order is dropped (like selectTable on the web).
  void useTable(int? tableId) {
    if (state.orderId != null || state.localId != null) {
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

  /// Opens an order saved while offline (its table shows "Chờ đồng bộ"): the queued hold's lines become the cart.
  void openLocal(OutboxItem hold, PosData data) {
    final lines = [
      for (final l in mapList(hold.local['lines']))
        CartLine(
          productId: toInt(l['product_id']),
          name: '${l['name'] ?? ''}',
          price: toNum(l['price']),
          qty: toInt(l['qty']).clamp(1, kMaxLineQty),
          note: '${l['note'] ?? ''}',
          imageUrl: data.product(toInt(l['product_id']))?.imageUrl,
        ),
    ];
    _set(CartState(tableId: hold.tableId, localId: hold.id, orderCode: hold.code, lines: lines, note: '${hold.body['note'] ?? ''}'));
  }

  /// Body of POST /api/pos/hold and the cart part of POST /api/pos/checkout. An order saved offline that the server
  /// has meanwhile accepted is addressed by its server id, so the replay does not open a second order on the table.
  Map<String, dynamic> _cartBody() {
    final serverId = state.orderId ?? (state.localId != null ? _outbox.serverOrderIdFor(state.localId!) : null);
    return {
      if (serverId != null) 'order_id': serverId else 'table_id': ?state.tableId,
      'items': [for (final l in state.lines) l.toJson()],
      'note': ?(state.note.isEmpty ? null : state.note),
    };
  }

  /// What the sync screen shows for a queued item, and what reopens a held order: the lines as they are now.
  Map<String, dynamic> _snapshot(String? where) => {
        'table_id': state.tableId,
        'table': ?where,
        'summary': cartSummary(state.lines),
        'count': state.count,
        'total': state.total,
        'note': state.note,
        'lines': [
          for (final l in state.lines) {'product_id': l.productId, 'name': l.name, 'price': l.price, 'qty': l.qty, 'note': l.note},
        ],
      };

  /// "Giữ đơn" / "Lưu đơn": POST /api/pos/hold keeps the order on its table (pay later), then a new takeaway cart
  /// starts. Offline (or when the request fails on the network) the order is queued instead and the table shows it
  /// until the server has it; an order still queued is updated in place. [where] is the table label for the queue.
  Future<Map<String, dynamic>> hold({String? where}) async {
    _busy(true);
    try {
      final body = _cartBody();
      final localId = state.localId;
      if (localId != null) {
        final queued = _outbox.byId(localId);
        if (queued != null) {
          await _outbox.update(queued.copyWith(body: body, local: {...queued.local, ..._snapshot(where)}, clearError: true));
          _set(const CartState());
          return {'order_code': queued.code, 'offline': true};
        }
      }
      if (_offline) return await _queueHold(body, where);
      try {
        final res = await _api.post('/pos/hold', body, {'Idempotency-Key': newLocalId()});
        final order = Map<String, dynamic>.from(res['order'] as Map);
        _set(const CartState());
        return order;
      } on ApiException catch (e) {
        if (e.isNetwork) return await _queueHold(body, where);
        rethrow;
      }
    } finally {
      _busy(false);
    }
  }

  Future<Map<String, dynamic>> _queueHold(Map<String, dynamic> body, String? where) async {
    final item = await _outbox.enqueue(kind: 'hold', path: '/pos/hold', body: body, local: _snapshot(where));
    _set(const CartState());
    return {'order_code': item.code, 'offline': true};
  }

  /// "Thanh toán": POST /api/pos/checkout saves the cart (new order, or the lines of the open one) and takes the
  /// payment in one step; a sale that fails on the server leaves nothing behind. The Idempotency-Key is chosen before
  /// the first try, so a request whose answer was lost is never executed twice. Offline, or when the request fails on
  /// the network, the sale is queued with that same key and answered with a local code (OFF-…); the receipt data
  /// comes from the cart. A business error (stock, payment) is rethrown untouched.
  Future<PayOutcome> checkout(PayRequest req, {String? where}) async {
    _busy(true);
    try {
      final key = newLocalId();
      final body = {
        ..._cartBody(),
        'method': req.method,
        if (req.tendered != null && req.tendered! > 0) 'tendered': req.tendered,
        'discount': math.min(req.discount, state.subtotal),
        if (req.reference != null && req.reference!.isNotEmpty) 'reference': req.reference,
      };
      if (_offline) return await _queueCheckout(key, body, req, where);
      try {
        final res = await _api.post('/pos/checkout', body, {'Idempotency-Key': key});
        final out = PayOutcome(order: Map<String, dynamic>.from(res['order'] as Map), change: toNum(res['change']), tableId: state.tableId);
        final localId = state.localId;
        if (localId != null) await _outbox.remove(localId); // the held order is paid: nothing left to replay
        _set(const CartState());
        return out;
      } on ApiException catch (e) {
        if (e.isNetwork) return await _queueCheckout(key, body, req, where);
        rethrow;
      }
    } finally {
      _busy(false);
    }
  }

  Future<PayOutcome> _queueCheckout(String key, Map<String, dynamic> body, PayRequest req, String? where) async {
    final cart = state;
    final total = cart.subtotal - math.min(req.discount, cart.subtotal);
    final tendered = req.tendered ?? 0;
    final change = req.method == 'cash' && tendered > total ? tendered - total : 0;
    final localId = cart.localId;
    if (localId != null) await _outbox.remove(localId); // the held order becomes this sale
    final item = await _outbox.enqueue(
      id: key,
      kind: 'checkout',
      path: '/pos/checkout',
      body: body,
      local: {..._snapshot(where), 'total': total, 'method': req.method, 'tendered': req.tendered, 'change': change},
    );
    _set(const CartState());
    return PayOutcome(
      order: {
        'order_code': item.code,
        'offline': true,
        'status': 'queued',
        'table_id': cart.tableId,
        'subtotal': cart.subtotal,
        'discount': math.min(req.discount, cart.subtotal),
        'total': total,
        'payment_method': req.method,
        'items': [for (final l in cart.lines) {'product_id': l.productId, 'product_name': l.name, 'unit_price': l.price, 'quantity': l.qty, 'note': l.note}],
      },
      change: change,
      tableId: cart.tableId,
    );
  }

  /// "Hủy đơn" (admin): POST /api/orders/:id/cancel; the table is released. An order still queued is simply dropped.
  Future<void> cancelOpen() async {
    final localId = state.localId;
    if (localId != null) {
      await _outbox.remove(localId);
      _set(const CartState());
      return;
    }
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
