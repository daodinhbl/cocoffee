import 'dart:async';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../session.dart';
import 'connectivity.dart';
import 'offline_db.dart';
import 'outbox.dart';
import 'snapshot_sync.dart';

/// Result of a write: the server's answer, or (when the phone had no connection) the answer worked out locally.
class WriteOutcome {
  const WriteOutcome(this.body, {required this.queued});

  final Map<String, dynamic> body;

  /// True when the write was stored in the outbox and will be sent when the connection is back.
  final bool queued;
}

/// A temporary id (always negative) for a record created while offline.
int newTempId([Random? random]) => -((random ?? Random.secure()).nextInt(2000000000) + 1);

final offlineWriterProvider = Provider<OfflineWriter>(OfflineWriter.new);

/// Sends a write of the management screens and, when the server cannot be reached, queues it in the outbox (replayed
/// oldest first, with an Idempotency-Key so a request that did get through is never executed twice) and applies its
/// effect to the offline database so the screens show it at once. Business errors (a 4xx answer) are never queued:
/// they reach the caller like any other API error. Without a stored copy of the data there is nothing to show the
/// effect on, so the write is refused with the usual "no connection" error instead.
///
/// Order is kept per record: while earlier writes on the same customer / item are still queued, a new one lines up
/// behind them instead of overtaking them online.
class OfflineWriter {
  OfflineWriter(this._ref);

  final Ref _ref;

  Future<WriteOutcome> submit({
    required String kind,
    required String path,
    required Map<String, dynamic> body,
    required Future<Map<String, dynamic>> Function(OfflineDb db) effect,
    String method = 'POST',
    Map<String, dynamic> local = const {},
  }) async {
    final api = _ref.read(apiProvider);
    final outbox = _ref.read(outboxProvider.notifier);
    final db = _ref.read(offlineDbProvider);
    final id = newLocalId();

    // Earlier writes still queued: send them first. Whatever stays queued (server busy, a refused creation...) keeps
    // its place in front of this write.
    if (_ref.read(netProvider).online && _ref.read(outboxProvider).pending.isNotEmpty) await outbox.sync();
    final livePath = resolveRefs(path, _ref.read(outboxProvider).refs); // null: a record created offline, not on the server yet
    final behindQueue = livePath == null || outbox.pendingFor(path).isNotEmpty;
    final hasCopy = db.enabled && await db.hasData;

    if (_ref.read(netProvider).online && livePath != null && (!behindQueue || !hasCopy)) {
      try {
        final key = {'Idempotency-Key': id};
        final res = method == 'PUT' ? await api.put(livePath, body, key) : await api.post(livePath, body, key);
        unawaited(_ref.read(snapshotSyncProvider.notifier).sync()); // the copy follows the server (throttled)
        return WriteOutcome(res, queued: false);
      } catch (e) {
        final x = toApiException(e);
        if (!x.isNetwork) rethrow;
      }
    }
    if (!hasCopy) {
      throw ApiException(code: 'OFFLINE', message: 'Không có kết nối mạng và chưa có dữ liệu ngoại tuyến. Hãy kết nối để thực hiện thao tác này.');
    }
    final response = await effect(db); // throws when the record is not in the copy: nothing is queued then
    await outbox.enqueue(kind: kind, path: path, body: body, local: local, id: id, method: method);
    return WriteOutcome({...response, 'queued': true}, queued: true);
  }
}
