import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;

import 'ngrok.dart' show HttpAnswer, HttpCall, realHttp;

/// Where the updater looks for new versions: the shop owner's / vendor's server (GET /download/windows/manifest.json).
const kDefaultUpdateServer = 'https://cocoffee.tasotek-giaiphapso.com';

class UpdateException implements Exception {
  UpdateException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// 1.10.2 > 1.9.9; missing parts count as 0.
bool versionIsNewer(String candidate, String current) {
  List<int> parts(String v) => v.split('.').map((s) => int.tryParse(s.replaceAll(RegExp(r'[^0-9].*'), '')) ?? 0).toList();
  final a = parts(candidate), b = parts(current);
  for (var i = 0; i < (a.length > b.length ? a.length : b.length); i++) {
    final x = i < a.length ? a[i] : 0, y = i < b.length ? b[i] : 0;
    if (x != y) return x > y;
  }
  return false;
}

/// The installer the server offers.
class WindowsRelease {
  const WindowsRelease({required this.version, required this.file, required this.size, required this.sha256});

  /// Null when the answer is not a usable manifest. The file name is checked: it becomes part of a URL and a local path.
  static WindowsRelease? tryParse(Object? json) {
    if (json is! Map) return null;
    final v = json['version_name'], f = json['file'], s = json['size'], h = json['sha256'];
    if (v is! String || !RegExp(r'^\d+(\.\d+)+$').hasMatch(v)) return null;
    if (f is! String || !RegExp(r'^POS-Tasotek-Server-Setup-\d+(\.\d+)+\.exe$').hasMatch(f)) return null;
    if (s is! int || s <= 0 || h is! String || !RegExp(r'^[0-9a-f]{64}$').hasMatch(h)) return null;
    return WindowsRelease(version: v, file: f, size: s, sha256: h);
  }

  final String version, file, sha256;
  final int size;
}

/// Checks the server for a newer installer, downloads it, verifies it and starts it silently (like the phone app's updater).
///
/// Safety: the download URL is rebuilt from [server] and the validated file name, never taken from the answer; the file must
/// match the manifest's size and SHA-256 before it is started. The server itself is the trust anchor (https), like the phone app.
class WindowsUpdater {
  WindowsUpdater({required this.server, this.http = realHttp, String? tempDir}) : tempDir = tempDir ?? p.join(Directory.systemTemp.path, 'tasotek-pos-update');

  final String server;
  final HttpCall http;
  final String tempDir;

  String get _base => server.trim().replaceAll(RegExp(r'/+$'), '');

  /// The newer release, or null when this version is current (or the server has none). Throws [UpdateException] when the check fails.
  Future<WindowsRelease?> check(String currentVersion) async {
    if (!_base.startsWith('https://') && !_base.startsWith('http://127.0.0.1') && !_base.startsWith('http://localhost')) {
      throw UpdateException('Địa chỉ máy chủ cập nhật phải bắt đầu bằng https://');
    }
    final HttpAnswer r;
    try {
      r = await http('GET', Uri.parse('$_base/download/windows/manifest.json'), headers: {'Accept': 'application/json'});
    } catch (_) {
      throw UpdateException('Không kết nối được máy chủ cập nhật. Kiểm tra mạng.');
    }
    if (r.status == 404) return null;
    if (r.status != 200) throw UpdateException('Máy chủ cập nhật trả lỗi ${r.status}.');
    Object? j;
    try {
      j = jsonDecode(r.body);
    } catch (_) {/* handled below */}
    final rel = WindowsRelease.tryParse(j);
    if (rel == null) throw UpdateException('Thông tin bản cập nhật không hợp lệ.');
    return versionIsNewer(rel.version, currentVersion) ? rel : null;
  }

  /// Downloads the installer to a temp folder and checks size and SHA-256. [onProgress] gets 0..1.
  Future<String> download(WindowsRelease rel, {void Function(double)? onProgress}) async {
    final dir = Directory(tempDir)..createSync(recursive: true);
    final target = File(p.join(dir.path, rel.file));
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
    try {
      final req = await client.getUrl(Uri.parse('$_base/download/windows/${rel.file}'));
      final res = await req.close();
      if (res.statusCode != 200) throw UpdateException('Tải bản cập nhật thất bại (${res.statusCode}).');
      final sink = target.openWrite();
      var got = 0;
      try {
        await for (final chunk in res) {
          sink.add(chunk);
          got += chunk.length;
          if (got > rel.size) throw UpdateException('Tệp tải về lớn hơn dự kiến.');
          onProgress?.call(got / rel.size);
        }
      } finally {
        await sink.close();
      }
    } on UpdateException {
      if (target.existsSync()) target.deleteSync();
      rethrow;
    } on SocketException {
      throw UpdateException('Mất kết nối khi tải bản cập nhật. Thử lại.');
    } finally {
      client.close(force: true);
    }
    if (target.lengthSync() != rel.size || await sha256Of(target.path) != rel.sha256) {
      target.deleteSync();
      throw UpdateException('Tệp tải về không khớp mã kiểm tra (SHA-256), đã xóa. Thử lại sau.');
    }
    return target.path;
  }

  /// Starts the installer silently and detached; Inno Setup closes the manager, replaces the program (data stays in
  /// %ProgramData%) and the script starts the manager again (/RELAUNCH=1). The caller stops the services first and exits afterwards.
  static Future<void> launchInstaller(String file) => Process.start(
        file,
        ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RELAUNCH=1'],
        mode: ProcessStartMode.detached,
      );
}

Future<String> sha256Of(String file) async => (await sha256.bind(File(file).openRead()).first).toString();
