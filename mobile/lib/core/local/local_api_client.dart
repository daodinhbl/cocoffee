import 'dart:typed_data';

import '../api/api_client.dart';
import '../app_mode.dart';
import 'local_backend.dart';

/// The API client of "Dùng trên máy này": same interface as [ApiClient], so every screen and provider works
/// unchanged, but each call is answered by [LocalBackend] from the phone's SQLite file. Nothing goes on the network.
///
/// This is where the app's data access has its two sources: [apiProvider] (core/session.dart) hands the screens the
/// server client or this one, depending on [AppMode].
class LocalApiClient extends ApiClient {
  LocalApiClient(this.backend) : super(serverUrl: kLocalServer, token: () => null, onUnauthorized: () {});

  final LocalBackend backend;

  /// Requests arrive with JSON-ish bodies (Map) from the screens; anything else is an empty body.
  static Map<String, dynamic> _body(Object? body) => body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{};

  static Map<String, dynamic> _query(Map<String, dynamic>? q) =>
      q == null ? const {} : (Map.of(q)..removeWhere((_, v) => v == null || (v is String && v.isEmpty)));

  @override
  Future<Map<String, dynamic>> get(String path, {Map<String, dynamic>? query, bool useCache = true}) => _guard(() => backend.get(path, _query(query)));

  @override
  Future<Map<String, dynamic>> post(String path, [Object? body, Map<String, String>? headers]) => _guard(() => backend.post(path, _body(body)));

  @override
  Future<Map<String, dynamic>> put(String path, [Object? body, Map<String, String>? headers]) => _guard(() => backend.put(path, _body(body)));

  /// The "server" is the phone itself: always reachable.
  @override
  Future<bool> ping() async => true;

  /// No photos are stored in local mode.
  @override
  Future<Uint8List?> bytes(String url) async => null;

  /// Business errors come out as [ApiException] already; a SQLite failure becomes a readable one.
  static Future<Map<String, dynamic>> _guard(Future<Map<String, dynamic>> Function() call) async {
    try {
      return await call();
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException(code: 'LOCAL_DB', message: 'Không đọc/ghi được dữ liệu trên máy: $e');
    }
  }
}
