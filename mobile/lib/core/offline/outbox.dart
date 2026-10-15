import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../session.dart';

/// A write that could not reach the server and waits to be replayed: a POS checkout, a held order, a payment.
/// [id] doubles as the Idempotency-Key, so a request that did reach the server (answer lost on the way back) is
/// replayed as the same request and not executed twice. [local] holds what the screens show meanwhile (code,
/// table, lines, total...). [error] is set when the server refused the replay (a business error, in Vietnamese).
/// Vietnamese name of a queued write.
String kindLabel(String kind) => switch (kind) {
      'checkout' => 'Thanh toán',
      'hold' => 'Giữ đơn',
      'pay' => 'Thu tiền',
      'customer.create' => 'Thêm khách hàng',
      'customer.update' => 'Sửa khách hàng',
      'customer.collect' => 'Thu nợ',
      'customer.adjust' => 'Điều chỉnh công nợ',
      'inventory.receive' => 'Nhập kho',
      'inventory.adjust' => 'Kiểm kê kho',
      'order.cancel' => 'Hủy đơn',
      _ => kind,
    };

class OutboxItem {
  const OutboxItem({
    required this.id,
    required this.kind,
    required this.path,
    required this.body,
    required this.local,
    required this.createdAt,
    this.method = 'POST',
    this.attempts = 0,
    this.error,
    this.errorCode,
  });

  factory OutboxItem.fromJson(Map<String, dynamic> j) => OutboxItem(
        id: '${j['id']}',
        kind: '${j['kind']}',
        path: '${j['path']}',
        body: Map<String, dynamic>.from(j['body'] as Map? ?? const {}),
        local: Map<String, dynamic>.from(j['local'] as Map? ?? const {}),
        createdAt: DateTime.tryParse('${j['created_at']}') ?? DateTime.fromMillisecondsSinceEpoch(0),
        method: '${j['method'] ?? 'POST'}',
        attempts: (j['attempts'] as num?)?.toInt() ?? 0,
        error: j['error'] as String?,
        errorCode: j['error_code'] as String?,
      );

  final String id;

  /// 'checkout' (POST /pos/checkout), 'hold' (POST /pos/hold), 'pay' (POST /orders/:id/pay), or an offline write of
  /// the management screens: 'customer.create', 'customer.update', 'customer.collect', 'customer.adjust',
  /// 'inventory.receive', 'inventory.adjust', 'order.cancel' (see offline_writer.dart).
  final String kind;
  final String path;
  final Map<String, dynamic> body;
  final Map<String, dynamic> local;
  final DateTime createdAt;

  /// HTTP verb of the replay: POST (default) or PUT.
  final String method;
  final int attempts;
  final String? error;
  final String? errorCode;

  bool get failed => error != null;

  /// Local code shown until the server answers, e.g. OFF-K3F9Q2.
  String get code => '${local['code'] ?? ''}';
  num get total => local['total'] is num ? local['total'] as num : num.tryParse('${local['total'] ?? ''}') ?? 0;
  int? get tableId => (body['table_id'] as num?)?.toInt();
  String get title => kindLabel(kind);

  Map<String, dynamic> toJson() => {
        'id': id,
        'kind': kind,
        'path': path,
        'body': body,
        'local': local,
        'created_at': createdAt.toIso8601String(),
        'method': method,
        'attempts': attempts,
        if (error != null) 'error': error,
        if (errorCode != null) 'error_code': errorCode,
      };

  OutboxItem copyWith({Map<String, dynamic>? body, Map<String, dynamic>? local, int? attempts, String? error, String? errorCode, bool clearError = false}) =>
      OutboxItem(
        id: id,
        kind: kind,
        path: path,
        body: body ?? this.body,
        local: local ?? this.local,
        createdAt: createdAt,
        attempts: attempts ?? this.attempts,
        error: clearError ? null : (error ?? this.error),
        errorCode: clearError ? null : (errorCode ?? this.errorCode),
      );
}

/// An item the server accepted: what it became there.
class SyncedItem {
  const SyncedItem({required this.id, required this.kind, required this.localCode, required this.serverCode, this.serverOrderId, this.serverId, required this.at});

  factory SyncedItem.fromJson(Map<String, dynamic> j) => SyncedItem(
        id: '${j['id']}',
        kind: '${j['kind']}',
        localCode: '${j['local_code'] ?? ''}',
        serverCode: '${j['server_code'] ?? ''}',
        serverOrderId: (j['server_order_id'] as num?)?.toInt(),
        serverId: (j['server_id'] as num?)?.toInt(),
        at: DateTime.tryParse('${j['at']}') ?? DateTime.fromMillisecondsSinceEpoch(0),
      );

  final String id;
  final String kind;
  final String localCode;
  final String serverCode;
  final int? serverOrderId;

  /// Id of the record a 'customer.create' became on the server.
  final int? serverId;
  final DateTime at;

  Map<String, dynamic> toJson() =>
      {'id': id, 'kind': kind, 'local_code': localCode, 'server_code': serverCode, 'server_order_id': serverOrderId, 'server_id': serverId, 'at': at.toIso8601String()};
}

class OutboxState {
  const OutboxState({this.items = const [], this.synced = const [], this.refs = const {}, this.syncing = false, this.loaded = false});

  final List<OutboxItem> items;
  final List<SyncedItem> synced;

  /// Temporary id (negative) given to a record created offline -> its id on the server, once replayed.
  final Map<int, int> refs;
  final bool syncing;
  final bool loaded;

  List<OutboxItem> get pending => [for (final i in items) if (!i.failed) i];
  int get failedCount => items.where((i) => i.failed).length;
  bool get isEmpty => items.isEmpty;

  OutboxState copyWith({List<OutboxItem>? items, List<SyncedItem>? synced, Map<int, int>? refs, bool? syncing, bool? loaded}) => OutboxState(
      items: items ?? this.items, synced: synced ?? this.synced, refs: refs ?? this.refs, syncing: syncing ?? this.syncing, loaded: loaded ?? this.loaded);
}

const _alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';

/// `off-<time36>-<10 random>`: unique per device, and a valid Idempotency-Key (8-100 chars of [A-Za-z0-9_.:-]).
String newLocalId({Random? random, DateTime? now}) {
  final r = random ?? Random.secure();
  final t = (now ?? DateTime.now()).millisecondsSinceEpoch.toRadixString(36);
  return 'off-$t-${List.generate(10, (_) => _alphabet[r.nextInt(_alphabet.length)]).join()}';
}

/// Short code shown for a local order, from its id: OFF-K3F9Q2.
String localCodeOf(String id) => 'OFF-${id.substring(id.length - 6).toUpperCase()}';

const kSyncedKept = 30;

/// Replaces the temporary (negative) ids in a queued path (`/admin/customers/-4821/collect`) with the ids the
/// server gave once the record was created. Null when one of them is not known yet.
String? resolveRefs(String path, Map<int, int> refs) {
  var ok = true;
  final out = path.replaceAllMapped(RegExp(r'/(-\d+)(?=/|$)'), (m) {
    final real = refs[int.parse(m.group(1)!)];
    if (real == null) {
      ok = false;
      return m.group(0)!;
    }
    return '/$real';
  });
  return ok ? out : null;
}

final outboxProvider = NotifierProvider<OutboxNotifier, OutboxState>(OutboxNotifier.new);

/// The queue of writes waiting for the server, persisted per server URL. Replayed oldest first by [sync]:
/// on reconnect (offline coordinator), when the app comes back to the foreground, and on demand.
class OutboxNotifier extends Notifier<OutboxState> {
  late Future<void> ready;
  late String _key;

  @override
  OutboxState build() {
    _key = 'outbox:${ref.watch(serverUrlProvider)}';
    ready = _load();
    return const OutboxState();
  }

  Future<void> _load() async {
    var loaded = const OutboxState(loaded: true);
    try {
      final raw = await ref.read(localStoreProvider).read(_key);
      if (raw != null) {
        final j = jsonDecode(raw) as Map;
        loaded = OutboxState(
          loaded: true,
          items: [for (final i in (j['items'] as List? ?? const [])) if (i is Map) OutboxItem.fromJson(Map<String, dynamic>.from(i))],
          synced: [for (final s in (j['synced'] as List? ?? const [])) if (s is Map) SyncedItem.fromJson(Map<String, dynamic>.from(s))],
          refs: {for (final e in ((j['refs'] as Map?) ?? const {}).entries) int.parse('${e.key}'): (e.value as num).toInt()},
        );
      }
    } catch (_) {
      // unreadable queue file: start empty rather than crash
    }
    if (!ref.mounted) return;
    state = loaded;
    if (loaded.pending.isNotEmpty) unawaited(sync());
  }

  Future<void> _persist() => ref.read(localStoreProvider).write(
        _key,
        jsonEncode({
          'items': [for (final i in state.items) i.toJson()],
          'synced': [for (final s in state.synced.take(kSyncedKept)) s.toJson()],
          'refs': {for (final e in state.refs.entries) '${e.key}': e.value},
        }),
      );

  OutboxItem? byId(String id) {
    for (final i in state.items) {
      if (i.id == id) return i;
    }
    return null;
  }

  /// The server order a local item became, once replayed (null while it still waits).
  int? serverOrderIdFor(String localId) {
    for (final s in state.synced) {
      if (s.id == localId) return s.serverOrderId;
    }
    return null;
  }

  Future<OutboxItem> enqueue({
    required String kind,
    required String path,
    required Map<String, dynamic> body,
    required Map<String, dynamic> local,
    String? id,
    String method = 'POST',
  }) async {
    await ready;
    final itemId = id ?? newLocalId();
    final item = OutboxItem(id: itemId, kind: kind, path: path, body: body, local: {'code': localCodeOf(itemId), ...local}, createdAt: DateTime.now(), method: method);
    state = state.copyWith(items: [...state.items, item]);
    await _persist();
    return item;
  }

  /// Replaces an item (a held order edited again while still offline).
  Future<void> update(OutboxItem item) async {
    state = state.copyWith(items: [for (final i in state.items) if (i.id == item.id) item else i]);
    await _persist();
  }

  Future<void> remove(String id) async {
    state = state.copyWith(items: [for (final i in state.items) if (i.id != id) i]);
    await _persist();
  }

  /// Clears the error of a failed item and replays the queue.
  Future<void> retry(String id) async {
    state = state.copyWith(items: [for (final i in state.items) if (i.id == id) i.copyWith(clearError: true) else i]);
    await _persist();
    await sync();
  }

  Future<void> clearSynced() async {
    state = state.copyWith(synced: const []);
    await _persist();
  }

  /// Replays the pending items, oldest first. A network failure stops the run (still offline); a business error
  /// marks that item failed and the run moves on, so one refused sale never blocks the others.
  Future<void> sync() async {
    if (state.syncing) return;
    await ready;
    if (!ref.mounted || state.pending.isEmpty) return;
    state = state.copyWith(syncing: true);
    try {
      for (final item in state.pending) {
        if (!ref.mounted) return;
        if (byId(item.id) == null) continue; // discarded meanwhile
        try {
          final path = resolveRefs(item.path, state.refs);
          if (path == null) {
            // It points at a record created offline whose own creation was refused: nothing to attach it to.
            state = state.copyWith(items: [
              for (final i in state.items)
                if (i.id == item.id) i.copyWith(attempts: i.attempts + 1, error: 'Khách hàng tạo ngoại tuyến chưa được gửi lên máy chủ.', errorCode: 'DEPENDENCY') else i,
            ]);
            continue;
          }
          final api = ref.read(apiProvider);
          final key = {'Idempotency-Key': item.id};
          final res = item.method == 'PUT' ? await api.put(path, item.body, key) : await api.post(path, item.body, key);
          final order = res['order'] is Map ? Map<String, dynamic>.from(res['order'] as Map) : const <String, dynamic>{};
          final created = item.kind == 'customer.create' && res['customer'] is Map ? Map<String, dynamic>.from(res['customer'] as Map) : null;
          final tempId = (item.local['temp_id'] as num?)?.toInt();
          final done = SyncedItem(
            id: item.id,
            kind: item.kind,
            localCode: item.code,
            serverCode: '${order['order_code'] ?? ''}',
            serverOrderId: (order['id'] as num?)?.toInt(),
            serverId: (created?['id'] as num?)?.toInt(),
            at: DateTime.now(),
          );
          if (!ref.mounted) return;
          final refs = created != null && tempId != null ? {...state.refs, tempId: (created['id'] as num).toInt()} : state.refs;
          state = state.copyWith(
            items: [for (final i in state.items) if (i.id != item.id) i],
            synced: [done, ...state.synced].take(kSyncedKept).toList(),
            refs: refs,
          );
        } catch (e) {
          final x = toApiException(e);
          if (x.isNetwork) break; // offline again: the rest waits
          if (x.code == 'IDEMPOTENCY_IN_PROGRESS' || x.code == 'RATE_LIMITED') break; // try again later
          if (!ref.mounted) return;
          state = state.copyWith(items: [
            for (final i in state.items)
              if (i.id == item.id) i.copyWith(attempts: i.attempts + 1, error: x.message, errorCode: x.code) else i,
          ]);
        }
      }
    } finally {
      if (ref.mounted) {
        state = state.copyWith(syncing: false);
        await _persist();
      }
    }
  }
}
