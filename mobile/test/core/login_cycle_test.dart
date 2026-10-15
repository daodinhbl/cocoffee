import 'dart:convert';
import 'dart:io';

import 'package:cocoffee_mobile/core/offline/connectivity.dart';
import 'package:cocoffee_mobile/core/offline/offline_coordinator.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Regression: logging in with the REAL providers (no apiProvider override) threw
/// `CircularDependencyError: Provider<ApiClient>` in debug builds, where Riverpod asserts on cycles.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null; // the test binding fakes HTTP with 400; this test talks to a local server
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'), (_) async => null);

  test('login with the real apiProvider does not hit a provider cycle', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      req.response.headers.contentType = ContentType.json;
      if (req.uri.path == '/api/auth/login') {
        req.response.write(jsonEncode({
          'token': 't0k',
          'user': {'id': 1, 'username': 'boss', 'full_name': 'Chủ Quán', 'role': 'admin'},
        }));
      } else {
        req.response.write(jsonEncode({}));
      }
      await req.response.close();
    });

    SharedPreferences.setMockInitialValues({'server_url': 'http://127.0.0.1:${server.port}'});
    final session = SessionStore(await SharedPreferences.getInstance());
    final container = ProviderContainer(overrides: [
      sessionStoreProvider.overrideWithValue(session),
      networkEventsProvider.overrideWithValue(() => const Stream<bool>.empty()),
    ]);
    addTearDown(container.dispose);
    container.read(offlineCoordinatorProvider); // the app keeps it alive and listening, like main()

    await container.read(authProvider.notifier).login('boss', 'secret-password');
    await Future<void>.delayed(const Duration(milliseconds: 100));

    expect(container.read(authProvider), isA<SignedIn>());
    expect(container.read(apiProvider), isNotNull);
  });
}
