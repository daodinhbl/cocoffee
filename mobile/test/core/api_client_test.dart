import 'dart:convert';
import 'dart:typed_data';

import 'package:cocoffee_mobile/core/api/api_client.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

/// Answers every request with the canned (status, body) for its path.
class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this.answers);
  final Map<String, (int, Map<String, dynamic>)> answers;

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    final (status, body) = answers[options.path] ?? (404, {'error': {'code': 'NOT_FOUND', 'message': 'not found'}});
    return ResponseBody.fromString(jsonEncode(body), status, headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    });
  }

  @override
  void close({bool force = false}) {}
}

Map<String, dynamic> _err(String code, String message) => {'error': {'code': code, 'message': message}};

void main() {
  late int unauthorized;
  late int mustChange;

  ApiClient client(Map<String, (int, Map<String, dynamic>)> answers) {
    final dio = Dio()..httpClientAdapter = _FakeAdapter(answers);
    return ApiClient(
      serverUrl: 'https://cafe.example.test',
      token: () => 'tok',
      onUnauthorized: () => unauthorized++,
      onMustChangePassword: () => mustChange++,
      dio: dio,
    );
  }

  setUp(() {
    unauthorized = 0;
    mustChange = 0;
  });

  test('a wrong current password (401 BAD_CREDENTIALS) keeps the session', () async {
    final api = client({'/auth/change-password': (401, _err('BAD_CREDENTIALS', 'Current password is wrong'))});
    await expectLater(
      api.post('/auth/change-password', {'current_password': 'x', 'new_password': 'y' * 10}),
      throwsA(isA<ApiException>().having((e) => e.code, 'code', 'BAD_CREDENTIALS')),
    );
    expect(unauthorized, 0);
  });

  test('401 UNAUTHORIZED ends the session; a failed login does not', () async {
    final api = client({
      '/orders': (401, _err('UNAUTHORIZED', 'Invalid or expired token')),
      '/auth/login': (401, _err('UNAUTHORIZED', 'x')),
    });
    await expectLater(api.get('/orders'), throwsA(isA<ApiException>().having((e) => e.isUnauthorized, 'isUnauthorized', isTrue)));
    expect(unauthorized, 1);
    await expectLater(api.post('/auth/login', {'username': 'a', 'password': 'b'}), throwsA(isA<ApiException>()));
    expect(unauthorized, 1);
  });

  test('403 MUST_CHANGE_PASSWORD raises the password gate with a Vietnamese message', () async {
    final api = client({'/admin/dashboard': (403, _err('MUST_CHANGE_PASSWORD', 'Change the default password before using the app'))});
    await expectLater(
      api.get('/admin/dashboard'),
      throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('tối thiểu 10 ký tự'))),
    );
    expect(mustChange, 1);
    expect(unauthorized, 0);
  });

  test('order error codes have Vietnamese text', () {
    for (final code in ['TABLE_OCCUPIED', 'PRODUCT_UNAVAILABLE', 'INSUFFICIENT_PAYMENT', 'ORDER_NOT_PAYABLE', 'EMPTY_ORDER', 'ORDER_NOT_CANCELLABLE', 'DEMO_ACCOUNT']) {
      expect(vietnameseFor(code, 'English text', null), isNot('English text'), reason: code);
    }
  });
}
