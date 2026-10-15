import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../session.dart';
import 'connectivity.dart';
import 'offline_db.dart';
import 'outbox.dart';

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
    final id = newLocalId();
    if (_ref.read(netProvider).online) {
      try {
        final key = {'Idempotency-Key': id};
        return WriteOutcome(method == 'PUT' ? await api.put(path, body, key) : await api.post(path, body, key), queued: false);
      } catch (e) {
        final x = toApiException(e);
        if (!x.isNetwork) rethrow;
      }
    }
    final db = _ref.read(offlineDbProvider);
    if (!db.enabled || !await db.hasData) {
      throw ApiException(code: 'OFFLINE', message: 'Không có kết nối mạng và chưa có dữ liệu ngoại tuyến. Hãy kết nối để thực hiện thao tác này.');
    }
    final response = await effect(db);
    await _ref.read(outboxProvider.notifier).enqueue(kind: kind, path: path, body: body, local: local, id: id, method: method);
    return WriteOutcome({...response, 'queued': true}, queued: true);
  }
}
