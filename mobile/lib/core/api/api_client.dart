import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../offline/offline_resolver.dart';
import '../offline/response_cache.dart';

/// Error from the CoCoffee API: `{ error: { code, message, details } }` (src/middlewares/errorHandler.js).
/// [message] is Vietnamese, ready to show; the server's English text is kept in [serverMessage].
class ApiException implements Exception {
  ApiException({required this.code, required this.message, this.status, this.details, this.serverMessage});

  final String code;
  final String message;
  final int? status;
  final Object? details;
  final String? serverMessage;

  bool get isUnauthorized => status == 401;
  bool get isOffline => code == 'OFFLINE';

  /// The server could not be reached or did not answer (no connection, timeout, or the host's 502-504 while the
  /// app is being redeployed): the request may be served from the cache or queued, nothing was refused.
  bool get isNetwork => isOffline || code == 'TIMEOUT' || (status != null && status! >= 502 && status! <= 504);

  @override
  String toString() => 'ApiException($code, $status): $message';
}

/// Vietnamese text for the codes the API throws (AppError codes in src/**). Unknown codes fall back to a
/// generic sentence plus the server text, so nothing is shown in English by accident.
String vietnameseFor(String code, String? serverMessage, Object? details) {
  switch (code) {
    case 'BAD_CREDENTIALS':
      return 'Sai tên đăng nhập hoặc mật khẩu.';
    case 'UNAUTHORIZED':
      return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
    case 'FORBIDDEN':
      return 'Tài khoản của bạn không có quyền làm việc này.';
    case 'NOT_FOUND':
    case 'ORDER_NOT_FOUND':
      return 'Không tìm thấy dữ liệu (có thể đã bị xóa).';
    case 'VALIDATION':
      return serverMessage?.isNotEmpty == true ? serverMessage! : 'Dữ liệu chưa hợp lệ.';
    case 'WEAK_PASSWORD':
      return 'Mật khẩu mới phải có ít nhất 10 ký tự.';
    case 'INSUFFICIENT_STOCK':
      final short = (details is Map ? details['short'] : null);
      if (short is List && short.isNotEmpty) {
        final items = short.map((s) => s is Map ? '${s['name']} (cần ${s['needed']}, còn ${s['available']} ${s['unit'] ?? ''})' : '$s').join('; ');
        return 'Không đủ tồn kho: $items';
      }
      return 'Không đủ tồn kho để hoàn tất đơn.';
    case 'DUPLICATE':
      return 'Giá trị này đã tồn tại (mã, tên hoặc từ khóa bị trùng).';
    case 'CONSTRAINT':
      return 'Bản ghi đang được dùng ở nơi khác nên không thể thay đổi.';
    case 'ORDER_NOT_OPEN':
      return 'Đơn không còn mở.';
    case 'CONFLICT':
    case 'TABLE_BUSY':
      return serverMessage?.isNotEmpty == true ? serverMessage! : 'Trạng thái đã thay đổi, vui lòng tải lại.';
    case 'MUST_CHANGE_PASSWORD':
      return 'Mật khẩu hiện tại quá yếu. Hãy đặt mật khẩu mới (tối thiểu 10 ký tự) để tiếp tục.';
    case 'DEMO_ACCOUNT':
      return 'Không thể thay đổi tài khoản demo.';
    case 'TABLE_OCCUPIED':
      return 'Bàn này đang có đơn mở. Tải lại để lấy đơn hiện tại của bàn.';
    case 'PRODUCT_UNAVAILABLE':
      return 'Có món vừa ngừng bán. Tải lại để cập nhật thực đơn.';
    case 'INSUFFICIENT_PAYMENT':
      return 'Tiền khách đưa chưa đủ.';
    case 'ORDER_NOT_PAYABLE':
      return 'Đơn không còn ở trạng thái thanh toán được.';
    case 'EMPTY_ORDER':
      return 'Đơn chưa có món nào.';
    case 'ORDER_NOT_CANCELLABLE':
      return 'Chỉ hủy được đơn đang chờ xác nhận hoặc đang phục vụ.';
    case 'NOT_APPLICABLE':
      return 'Chỉ đơn Zalo đã hoàn tất mới có bill Zalo.';
    case 'NOT_PRINTABLE':
      return 'Đơn này chưa in được hóa đơn.';
    case 'NOT_INSTALLED':
      return 'Máy chủ chưa được cài đặt. Mở địa chỉ máy chủ trên trình duyệt để hoàn tất cài đặt.';
    case 'BAD_JSON':
      return 'Dữ liệu gửi lên không hợp lệ.';
    case 'PAYLOAD_TOO_LARGE':
      return 'Dữ liệu gửi lên quá lớn (ảnh quá nặng?).';
    case 'IDEMPOTENCY_IN_PROGRESS':
      return 'Yêu cầu trước vẫn đang được xử lý, vui lòng đợi rồi tải lại.';
    case 'IDEMPOTENCY_MISMATCH':
      return 'Yêu cầu này đã được gửi trước đó với nội dung khác.';
    case 'RATE_LIMITED':
      return 'Thao tác quá nhanh, vui lòng thử lại sau ít phút.';
    case 'OFFLINE':
      return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
    case 'TIMEOUT':
      return 'Máy chủ phản hồi chậm, vui lòng thử lại.';
    case 'INTERNAL':
      return 'Máy chủ gặp lỗi. Vui lòng thử lại sau.';
    case 'LOCAL_UNSUPPORTED':
      return 'Chức năng này chưa có khi dùng trên máy này (không có máy chủ).';
    case 'ACCOUNT_NOT_DELETABLE':
      return 'Quán này không được tạo trong ứng dụng nên không xóa được tại đây. Vui lòng liên hệ quản trị máy chủ.';
    default:
      return serverMessage?.isNotEmpty == true ? serverMessage! : 'Có lỗi xảy ra ($code).';
  }
}

ApiException toApiException(Object error) {
  if (error is ApiException) return error;
  if (error is DioException) {
    final res = error.response;
    final data = res?.data;
    if (data is Map && data['error'] is Map) {
      final e = data['error'] as Map;
      final code = '${e['code'] ?? 'ERROR'}';
      final msg = e['message'] as String?;
      return ApiException(code: code, status: res?.statusCode, details: e['details'], serverMessage: msg,
          message: vietnameseFor(code, msg, e['details']));
    }
    if (res?.statusCode == 429) return ApiException(code: 'RATE_LIMITED', status: 429, message: vietnameseFor('RATE_LIMITED', null, null));
    switch (error.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
        return ApiException(code: 'TIMEOUT', message: vietnameseFor('TIMEOUT', null, null));
      case DioExceptionType.connectionError:
        return ApiException(code: 'OFFLINE', message: vietnameseFor('OFFLINE', null, null));
      default:
        final status = res?.statusCode;
        return ApiException(code: status != null ? 'HTTP_$status' : 'ERROR', status: status,
            message: status != null && status >= 500 ? vietnameseFor('INTERNAL', null, null) : 'Có lỗi xảy ra, vui lòng thử lại.');
    }
  }
  return ApiException(code: 'ERROR', message: 'Có lỗi xảy ra: $error');
}

/// `error.code` of a failed response, when the body is the API's error shape.
String? _errorCode(DioException e) {
  final data = e.response?.data;
  if (data is Map && data['error'] is Map) return '${(data['error'] as Map)['code'] ?? ''}';
  return null;
}

/// How the client reports reachability and asks whether to try the network at all (core/offline/connectivity.dart).
class NetHooks {
  const NetHooks({this.isOffline, this.onOffline, this.onOnline});

  /// true while the app already knows the server is unreachable: a GET then answers from the cache at once
  /// instead of waiting for a timeout.
  final bool Function()? isOffline;
  final void Function()? onOffline;
  final void Function()? onOnline;
}

/// Thin wrapper over Dio: base URL `<server>/api`, Bearer token, JSON in/out, errors as [ApiException].
///
/// Session signals (src/middlewares/auth.js):
///  - 401 UNAUTHORIZED ends the session ([onUnauthorized]). 401 BAD_CREDENTIALS does not: it is the answer to a
///    wrong password (login, or the current password in POST /auth/change-password), and the user stays signed in.
///  - 403 MUST_CHANGE_PASSWORD: the token only reaches /auth/me and /auth/change-password ([onMustChangePassword]).
///
/// Offline (core/offline/): every successful GET is kept in [cache]; when a GET fails on the network (or the app
/// already knows it is offline) the cached answer is returned instead, so screens keep showing their last data.
/// Writes are never cached; the outbox replays the ones that matter with an Idempotency-Key header.
class ApiClient {
  ApiClient({
    required String serverUrl,
    required String? Function() token,
    required void Function() onUnauthorized,
    void Function()? onMustChangePassword,
    Dio? dio,
    this.cache,
    this.offline,
    this.hasLocalEdits,
    NetHooks net = const NetHooks(),
  })  : _dio = dio ?? Dio(),
        _server = serverUrl.replaceAll(RegExp(r'/+$'), ''),
        // ignore: prefer_initializing_formals
        _net = net {
    _dio.options
      ..baseUrl = '$_server/api'
      ..connectTimeout = const Duration(seconds: 10)
      ..receiveTimeout = const Duration(seconds: 20)
      ..headers = {'Accept': 'application/json'};
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        final t = token();
        if (t != null && t.isNotEmpty) options.headers['Authorization'] = 'Bearer $t';
        handler.next(options);
      },
      onError: (e, handler) {
        final path = e.requestOptions.path;
        final status = e.response?.statusCode;
        final code = _errorCode(e);
        if (status == 401 && code != 'BAD_CREDENTIALS' && !path.endsWith('/auth/login')) onUnauthorized();
        if (status == 403 && code == 'MUST_CHANGE_PASSWORD') onMustChangePassword?.call();
        handler.next(e);
      },
    ));
  }

  final Dio _dio;
  final String _server;
  final NetHooks _net;

  /// The offline cache behind [get] (null when the client was built without one).
  final ResponseCache? cache;

  /// The offline database (SQLite copy of the shop's data): answers list screens with any filter when offline.
  final OfflineResolver? offline;

  /// Are writes queued whose effects exist only in the offline database? Then it wins over the response cache.
  final bool Function()? hasLocalEdits;

  /// GET. Online the server always answers. When it cannot be reached ([useCache] false skips this) the answer comes
  /// from the phone: the offline database (any filter, search or page, plus the effects of queued writes) or the
  /// response cache (the exact request seen before) — whichever is fresher, the database winning while writes
  /// are queued, since their effects exist only there.
  Future<Map<String, dynamic>> get(String path, {Map<String, dynamic>? query, bool useCache = true}) async {
    final q = _clean(query);
    final store = useCache ? cache : null;
    final key = store == null ? null : ResponseCache.keyFor(path, q);
    Future<Map<String, dynamic>?> local() async {
      if (!useCache) return null;
      final fromDb = await offline?.resolve(path, q, detail: true);
      final hit = key == null ? null : await store!.read(key);
      if (fromDb == null) return hit?.data;
      if (hit == null || (hasLocalEdits?.call() ?? false)) return fromDb;
      final copyAt = await offline!.db.syncedAt();
      return copyAt != null && hit.at.isAfter(copyAt) ? hit.data : fromDb;
    }

    if (_net.isOffline?.call() ?? false) {
      final hit = await local();
      if (hit != null) return hit;
    }
    try {
      final data = await _send(() => _dio.get<dynamic>(path, queryParameters: q));
      if (key != null) unawaited(store!.write(key, data).catchError((Object _) {}));
      return data;
    } on ApiException catch (e) {
      if (e.isNetwork) {
        final hit = await local();
        if (hit != null) return hit;
      }
      rethrow;
    }
  }

  Future<Map<String, dynamic>> post(String path, [Object? body, Map<String, String>? headers]) =>
      _send(() => _dio.post<dynamic>(path, data: body ?? const {}, options: headers == null ? null : Options(headers: headers)));

  Future<Map<String, dynamic>> put(String path, [Object? body, Map<String, String>? headers]) =>
      _send(() => _dio.put<dynamic>(path, data: body ?? const {}, options: headers == null ? null : Options(headers: headers)));

  /// Is the server reachable? GET `<server>/health` with a short timeout; any answer below 500 counts.
  Future<bool> ping() async {
    try {
      final res = await _dio.get<dynamic>('$_server/health',
          options: Options(receiveTimeout: const Duration(seconds: 6), validateStatus: (_) => true));
      final ok = (res.statusCode ?? 599) < 500;
      if (ok) _net.onOnline?.call();
      return ok;
    } catch (_) {
      return false;
    }
  }

  /// Raw bytes of a server file (product photos); null when it cannot be fetched.
  Future<Uint8List?> bytes(String url) async {
    try {
      final res = await _dio.get<List<int>>(url, options: Options(responseType: ResponseType.bytes));
      final data = res.data;
      return data == null ? null : Uint8List.fromList(data);
    } catch (_) {
      return null;
    }
  }

  static Map<String, dynamic>? _clean(Map<String, dynamic>? q) =>
      q == null ? null : (Map.of(q)..removeWhere((_, v) => v == null || (v is String && v.isEmpty)));

  Future<Map<String, dynamic>> _send(Future<Response<dynamic>> Function() call) async {
    try {
      final res = await call();
      _net.onOnline?.call();
      final data = res.data;
      if (data is Map<String, dynamic>) return data;
      if (data is List) return {'items': data};
      return {'data': data};
    } catch (e) {
      final x = toApiException(e);
      if (x.isNetwork) _net.onOffline?.call();
      throw x;
    }
  }
}
