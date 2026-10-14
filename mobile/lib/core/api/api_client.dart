import 'package:dio/dio.dart';

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
    case 'BAD_JSON':
      return 'Dữ liệu gửi lên không hợp lệ.';
    case 'PAYLOAD_TOO_LARGE':
      return 'Dữ liệu gửi lên quá lớn (ảnh quá nặng?).';
    case 'IDEMPOTENCY_IN_PROGRESS':
      return 'Yêu cầu trước vẫn đang được xử lý, vui lòng đợi rồi tải lại.';
    case 'RATE_LIMITED':
      return 'Thao tác quá nhanh, vui lòng thử lại sau ít phút.';
    case 'OFFLINE':
      return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
    case 'TIMEOUT':
      return 'Máy chủ phản hồi chậm, vui lòng thử lại.';
    case 'INTERNAL':
      return 'Máy chủ gặp lỗi. Vui lòng thử lại sau.';
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

/// Thin wrapper over Dio: base URL `<server>/api`, Bearer token, JSON in/out, errors as [ApiException].
///
/// Session signals (src/middlewares/auth.js):
///  - 401 UNAUTHORIZED ends the session ([onUnauthorized]). 401 BAD_CREDENTIALS does not: it is the answer to a
///    wrong password (login, or the current password in POST /auth/change-password), and the user stays signed in.
///  - 403 MUST_CHANGE_PASSWORD: the token only reaches /auth/me and /auth/change-password ([onMustChangePassword]).
class ApiClient {
  ApiClient({
    required String serverUrl,
    required String? Function() token,
    required void Function() onUnauthorized,
    void Function()? onMustChangePassword,
    Dio? dio,
  }) : _dio = dio ?? Dio() {
    _dio.options
      ..baseUrl = '${serverUrl.replaceAll(RegExp(r'/+$'), '')}/api'
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

  Future<Map<String, dynamic>> get(String path, {Map<String, dynamic>? query}) => _send(() => _dio.get<dynamic>(path, queryParameters: _clean(query)));
  Future<Map<String, dynamic>> post(String path, [Object? body]) => _send(() => _dio.post<dynamic>(path, data: body ?? const {}));
  Future<Map<String, dynamic>> put(String path, [Object? body]) => _send(() => _dio.put<dynamic>(path, data: body ?? const {}));

  static Map<String, dynamic>? _clean(Map<String, dynamic>? q) =>
      q == null ? null : (Map.of(q)..removeWhere((_, v) => v == null || (v is String && v.isEmpty)));

  Future<Map<String, dynamic>> _send(Future<Response<dynamic>> Function() call) async {
    try {
      final res = await call();
      final data = res.data;
      if (data is Map<String, dynamic>) return data;
      if (data is List) return {'items': data};
      return {'data': data};
    } catch (e) {
      throw toApiException(e);
    }
  }
}
