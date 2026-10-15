import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../session.dart';
import 'connectivity.dart';
import 'outbox.dart';

/// Minimum time between two automatic copies (a forced one — the "Cập nhật dữ liệu ngay" button, the refresh after a
/// replay — ignores it). Counted from the last copy that succeeded, for this server and account.
const kSnapshotMinInterval = Duration(minutes: 2);

/// While the app stays online the copy is refreshed this often, so what it shows when the connection drops is recent.
const kSnapshotRefreshEvery = Duration(minutes: 10);

class SnapshotState {
  const SnapshotState({this.syncing = false, this.at, this.error, this.counts = const {}});

  final bool syncing;

  /// When the copy on this phone was taken on the server.
  final DateTime? at;
  final String? error;
  final Map<String, int> counts;

  SnapshotState copyWith({bool? syncing, DateTime? at, Object? error = _keep, Map<String, int>? counts}) => SnapshotState(
        syncing: syncing ?? this.syncing,
        at: at ?? this.at,
        error: identical(error, _keep) ? this.error : error as String?,
        counts: counts ?? this.counts,
      );

  static const _keep = Object();
}

/// Does [body] look like GET /api/sync/snapshot? A maintenance page or a proxy answer must never replace the copy.
bool isSnapshot(Map<String, dynamic> body) =>
    body['generated_at'] is String && body['categories'] is List && body['products'] is List && body['tables'] is List && body['orders'] is List;

final snapshotSyncProvider = NotifierProvider<SnapshotSyncNotifier, SnapshotState>(SnapshotSyncNotifier.new);

/// Keeps the offline database (SQLite) in step with the server: GET /api/sync/snapshot replaces the local copy.
/// Runs at sign-in, when the connection comes back, when the app returns to the foreground, every
/// [kSnapshotRefreshEvery] while online, after an online write and after queued writes were replayed. Never while
/// offline, never while writes are still queued (their effects live only in the copy), and not more often than
/// [kSnapshotMinInterval] unless forced.
class SnapshotSyncNotifier extends Notifier<SnapshotState> {
  DateTime? _lastSuccess;
  Future<bool>? _running;
  bool _rerunForced = false;
  Timer? _timer;

  @override
  SnapshotState build() {
    final db = ref.watch(offlineDbProvider);   // one per server and account: the throttle starts over with it
    _lastSuccess = null;
    _running = null;
    _rerunForced = false;
    _timer?.cancel();
    _timer = null;
    if (db.enabled) {
      unawaited(_loadInfo());
      _timer = Timer.periodic(kSnapshotRefreshEvery, (_) => sync());
      ref.onDispose(() => _timer?.cancel());
    }
    return const SnapshotState();
  }

  Future<void> _loadInfo() async {
    final db = ref.read(offlineDbProvider);
    final at = await db.syncedAt();
    final counts = await db.counts();
    if (ref.mounted) state = state.copyWith(at: at, counts: counts);
  }

  /// Returns true when a new copy was stored. A call made while a run is going shares its result; a forced one
  /// also runs again afterwards, so the refresh after a replay is never lost.
  Future<bool> sync({bool force = false}) {
    final running = _running;
    if (running != null) {
      if (force) _rerunForced = true;
      return running;
    }
    final run = _sync(force: force);
    _running = run;
    return run.whenComplete(() {
      if (identical(_running, run)) _running = null;
      if (_rerunForced && ref.mounted) {
        _rerunForced = false;
        unawaited(sync(force: true));
      }
    });
  }

  Future<bool> _sync({required bool force}) async {
    final db = ref.read(offlineDbProvider);
    final user = ref.read(currentUserProvider);
    if (!db.enabled || user == null || user.mustChangePassword) return false;
    if (!ref.read(netProvider).online) return false;
    await ref.read(outboxProvider.notifier).ready;   // the queue must be known before deciding anything about it
    if (!ref.mounted) return false;
    final pending = ref.read(outboxProvider).pending.length;
    if (pending > 0) {
      // Their effects exist only in the copy: replacing it now would hide them. The offline coordinator asks again
      // once the queue has been replayed.
      if (force) state = state.copyWith(error: 'Còn $pending thao tác chờ gửi lên máy chủ; dữ liệu ngoại tuyến sẽ được cập nhật sau khi gửi xong.');
      return false;
    }
    if (!force) {
      final last = _lastSuccess;
      if (last != null && DateTime.now().difference(last) < kSnapshotMinInterval) return false;
    }
    state = state.copyWith(syncing: true, error: null);
    try {
      final snapshot = await ref.read(apiProvider).get('/sync/snapshot', useCache: false);
      if (!isSnapshot(snapshot)) throw ApiException(code: 'BAD_SNAPSHOT', message: 'Máy chủ trả về dữ liệu không đúng định dạng, bản sao được giữ nguyên.');
      if (!await db.replaceSnapshot(snapshot)) throw ApiException(code: 'OFFLINE_DB', message: 'Không ghi được dữ liệu ngoại tuyến trên máy này.');
      _lastSuccess = DateTime.now();
      final at = await db.syncedAt();
      final counts = await db.counts();
      if (ref.mounted) state = SnapshotState(at: at, counts: counts);
      return true;
    } catch (e) {
      final message = e is ApiException ? e.message : 'Không đồng bộ được dữ liệu ngoại tuyến.';
      if (ref.mounted) state = state.copyWith(syncing: false, error: message);
      return false;
    }
  }

  /// Forgets the local copy (Đồng bộ ngoại tuyến → Xóa bản sao).
  Future<void> clear() async {
    await ref.read(offlineDbProvider).clear();
    _lastSuccess = null;
    state = const SnapshotState();
  }
}
