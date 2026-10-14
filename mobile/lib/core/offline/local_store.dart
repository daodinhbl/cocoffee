import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

/// Durable key/value storage behind everything offline: cached API answers, the outbox, the saved cart.
/// Keys are plain strings, values are strings (JSON). [MemoryStore] for tests, [FileStore] on the device.
abstract class LocalStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);

  /// Keys starting with [prefix] ('' = every key).
  Future<List<String>> keys([String prefix = '']);

  Future<void> clear([String prefix = '']) async {
    for (final k in await keys(prefix)) {
      await delete(k);
    }
  }
}

class MemoryStore extends LocalStore {
  final Map<String, String> _m = {};

  @override
  Future<String?> read(String key) async => _m[key];

  @override
  Future<void> write(String key, String value) async {
    _m[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _m.remove(key);
  }

  @override
  Future<List<String>> keys([String prefix = '']) async => [for (final k in _m.keys) if (k.startsWith(prefix)) k];
}

/// One file per key under [dir]: `<readable head>-<sha256 prefix>.json` holding `{"k": key, "v": value}`.
/// Writes go to a temp file first and are renamed into place, so a crash mid-write never leaves a half-written
/// entry behind. Values read or written this session stay in memory.
class FileStore extends LocalStore {
  FileStore(this.dir);

  final Directory dir;
  final Map<String, String> _hot = {};
  int _seq = 0;

  static String fileNameFor(String key) {
    final safe = key.replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '_');
    final head = safe.length > 60 ? safe.substring(0, 60) : safe;
    final hash = sha256.convert(utf8.encode(key)).toString().substring(0, 16);
    return '$head-$hash.json';
  }

  File _file(String key) => File('${dir.path}${Platform.pathSeparator}${fileNameFor(key)}');

  @override
  Future<String?> read(String key) async {
    final hot = _hot[key];
    if (hot != null) return hot;
    try {
      final raw = jsonDecode(await _file(key).readAsString());
      if (raw is Map && raw['k'] == key && raw['v'] is String) {
        final v = raw['v'] as String;
        _hot[key] = v;
        return v;
      }
    } catch (_) {
      // missing or corrupt: treated as absent
    }
    return null;
  }

  @override
  Future<void> write(String key, String value) async {
    _hot[key] = value;
    await dir.create(recursive: true);
    final f = _file(key);
    final tmp = File('${f.path}.${_seq++}.tmp');
    await tmp.writeAsString(jsonEncode({'k': key, 'v': value}), flush: true);
    await tmp.rename(f.path);
  }

  @override
  Future<void> delete(String key) async {
    _hot.remove(key);
    try {
      await _file(key).delete();
    } on FileSystemException {
      // already gone
    }
  }

  @override
  Future<List<String>> keys([String prefix = '']) async {
    if (!await dir.exists()) return const [];
    final out = <String>[];
    await for (final e in dir.list()) {
      if (e is! File || !e.path.endsWith('.json')) continue;
      try {
        final raw = jsonDecode(await e.readAsString());
        if (raw is Map && raw['k'] is String && (raw['k'] as String).startsWith(prefix)) out.add(raw['k'] as String);
      } catch (_) {
        // skip a corrupt file
      }
    }
    return out;
  }
}
