import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../session.dart';

/// Product and ingredient photos kept on disk, so the POS grid still shows them without the server. A photo is
/// fetched once (through the API client, so a dead network fails fast) and read from `<dir>/img/` afterwards.
/// Disabled (every lookup null) without a directory: tests, or a platform without path_provider.
class ImageStore {
  ImageStore(Directory? dir, this._fetch) : _dir = dir == null ? null : Directory('${dir.path}${Platform.pathSeparator}img');

  final Directory? _dir;
  final Future<Uint8List?> Function(String url) _fetch;
  final Map<String, File> _ready = {};
  final Map<String, Future<File?>> _loading = {};

  bool get enabled => _dir != null;

  File _fileFor(String url) => File('${_dir!.path}${Platform.pathSeparator}${sha256.convert(utf8.encode(url))}.img');

  /// The cached file when it is already known to exist (no I/O), else null.
  File? ready(String url) => _ready[url];

  /// The cached file, fetching and saving it first when needed; null when it cannot be fetched (offline and
  /// never seen) or the store is disabled.
  Future<File?> file(String url) {
    if (_dir == null) return Future.value(null);
    final known = _ready[url];
    if (known != null) return Future.value(known);
    return _loading.putIfAbsent(url, () => _load(url).whenComplete(() => _loading.remove(url)));
  }

  Future<File?> _load(String url) async {
    final f = _fileFor(url);
    try {
      if (await f.exists()) return _ready[url] = f;
      final bytes = await _fetch(url);
      if (bytes == null || bytes.isEmpty) return null;
      await f.parent.create(recursive: true);
      final tmp = File('${f.path}.tmp');
      await tmp.writeAsBytes(bytes, flush: true);
      await tmp.rename(f.path);
      return _ready[url] = f;
    } catch (_) {
      return null;
    }
  }
}

final imageStoreProvider = Provider<ImageStore>((ref) => ImageStore(ref.watch(appDirProvider), (url) => ref.read(apiProvider).bytes(url)));
