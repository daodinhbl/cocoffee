import 'dart:convert';

import 'local_store.dart';

/// Last successful answer of every GET, per server and account, so a screen can show what it showed last time
/// when the server cannot be reached. Entries are `{"at": iso, "d": body}`; the oldest are dropped past [max].
class ResponseCache {
  ResponseCache(this.store, {required this.scope, this.max = 150});

  final LocalStore store;
  final String scope;
  final int max;
  int _writes = 0;

  /// `path?a=1&b=2` with the query keys sorted, so the same request always maps to the same entry.
  static String keyFor(String path, Map<String, dynamic>? query) {
    if (query == null || query.isEmpty) return path;
    final keys = query.keys.toList()..sort();
    return '$path?${[for (final k in keys) '$k=${query[k]}'].join('&')}';
  }

  String get _prefix => 'cache:$scope:';
  String _k(String key) => '$_prefix$key';

  Future<CacheEntry?> read(String key) async {
    final raw = await store.read(_k(key));
    if (raw == null) return null;
    try {
      final j = jsonDecode(raw);
      if (j is Map && j['d'] is Map) {
        return CacheEntry(DateTime.tryParse('${j['at']}') ?? DateTime.fromMillisecondsSinceEpoch(0), Map<String, dynamic>.from(j['d'] as Map));
      }
    } catch (_) {
      // corrupt entry: treated as absent
    }
    return null;
  }

  Future<void> write(String key, Map<String, dynamic> data, {DateTime? now}) async {
    await store.write(_k(key), jsonEncode({'at': (now ?? DateTime.now()).toIso8601String(), 'd': data}));
    if (++_writes % 25 == 0) await prune();
  }

  Future<int> count() async => (await store.keys(_prefix)).length;

  Future<void> clear() => store.clear(_prefix);

  /// Drops the oldest entries until at most [max] remain.
  Future<void> prune() async {
    final keys = await store.keys(_prefix);
    if (keys.length <= max) return;
    final dated = <(String, DateTime)>[];
    for (final k in keys) {
      var at = DateTime.fromMillisecondsSinceEpoch(0);
      try {
        final j = jsonDecode((await store.read(k)) ?? '');
        if (j is Map) at = DateTime.tryParse('${j['at']}') ?? at;
      } catch (_) {
        // undated: counts as oldest
      }
      dated.add((k, at));
    }
    dated.sort((a, b) => a.$2.compareTo(b.$2));
    for (final (k, _) in dated.take(keys.length - max)) {
      await store.delete(k);
    }
  }
}

class CacheEntry {
  const CacheEntry(this.at, this.data);
  final DateTime at;
  final Map<String, dynamic> data;
}
