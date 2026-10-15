import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../session.dart';
import 'connectivity.dart';

/// Minimum time between two automatic copies (a forced one — the "Đồng bộ ngay" button — ignores it).
const kSnapshotMinInterval = Duration(minutes: 2);

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

final snapshotSyncProvider = NotifierProvider<SnapshotSyncNotifier, SnapshotState>(SnapshotSyncNotifier.new);

/// Keeps the offline database (SQLite) in step with the server: GET /api/sync/snapshot replaces the local copy.
/// Runs at start, when the connection comes back, when the app returns to the foreground and after queued writes
/// were replayed; never while offline, and not more often than [kSnapshotMinInterval] unless forced.
class SnapshotSyncNotifier extends Notifier<SnapshotState> {
  DateTime? _lastTry;

  @override
  SnapshotState build() {
    final db = ref.watch(offlineDbProvider);
    if (db.enabled) unawaited(_loadInfo());
    return const SnapshotState();
  }

  Future<void> _loadInfo() async {
    final db = ref.read(offlineDbProvider);
    final at = await db.syncedAt();
    final counts = await db.counts();
    if (ref.mounted) state = state.copyWith(at: at, counts: counts);
  }

  /// Returns true when a new copy was stored.
  Future<bool> sync({bool force = false}) async {
    final db = ref.read(offlineDbProvider);
    final auth = ref.read(authProvider);
    if (!db.enabled || auth is! SignedIn || auth.user.mustChangePassword || state.syncing) return false;
    if (!force) {
      if (!ref.read(netProvider).online) return false;
      final last = _lastTry;
      if (last != null && DateTime.now().difference(last) < kSnapshotMinInterval) return false;
    }
    _lastTry = DateTime.now();
    state = state.copyWith(syncing: true, error: null);
    try {
      final snapshot = await ref.read(apiProvider).get('/sync/snapshot', useCache: false);
      await db.replaceSnapshot(snapshot);
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

  /// Forgets the local copy (Đồng bộ ngoại tuyến → Xóa dữ liệu).
  Future<void> clear() async {
    await ref.read(offlineDbProvider).clear();
    state = const SnapshotState();
  }
}
