import 'package:cocoffee_mobile/core/security/app_lock.dart';
import 'package:cocoffee_mobile/core/session.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/test_app.dart';

class FakeAuth implements DeviceAuth {
  bool isAvailable = true, accepts = true;
  int asked = 0;
  @override
  Future<bool> available() async => isAvailable;
  @override
  Future<bool> confirm(String reason) async {
    asked++;
    return accepts;
  }
}

void main() {
  late FakeAuth auth;
  late ProviderContainer c;

  setUp(() async {
    auth = FakeAuth();
    final base = await testContainer(MockApi());
    c = ProviderContainer(overrides: [sessionStoreProvider.overrideWithValue(base.read(sessionStoreProvider)), deviceAuthProvider.overrideWithValue(auth)]);
    addTearDown(c.dispose);
  });

  test('off by default: never locked', () {
    final s = c.read(appLockProvider);
    expect(s.enabled, isFalse);
    expect(s.locked, isFalse);
    c.read(appLockProvider.notifier).leftApp(DateTime(2026, 10, 18, 9));
    c.read(appLockProvider.notifier).returned(DateTime(2026, 10, 18, 12));
    expect(c.read(appLockProvider).locked, isFalse);
  });

  test('turning it on needs the phone to confirm, and a phone without a screen lock cannot switch it on', () async {
    auth.isAvailable = false;
    expect(await c.read(appLockProvider.notifier).enable(), isFalse);
    expect(c.read(appLockProvider).enabled, isFalse);
    auth.isAvailable = true;
    auth.accepts = false;
    expect(await c.read(appLockProvider.notifier).enable(), isFalse);
    expect(c.read(appLockProvider).enabled, isFalse);
    auth.accepts = true;
    expect(await c.read(appLockProvider.notifier).enable(), isTrue);
    expect(c.read(appLockProvider).enabled, isTrue);
    expect(c.read(appLockProvider).locked, isFalse, reason: 'it was just confirmed');
  });

  test('locks only after the chosen time in the background; unlocking needs the phone again', () async {
    final n = c.read(appLockProvider.notifier);
    await n.enable();
    await n.setMinutes(5);
    n.leftApp(DateTime(2026, 10, 18, 9, 0));
    n.returned(DateTime(2026, 10, 18, 9, 4, 59));
    expect(c.read(appLockProvider).locked, isFalse, reason: 'a short look away');
    n.leftApp(DateTime(2026, 10, 18, 9, 0));
    n.returned(DateTime(2026, 10, 18, 9, 5, 1));
    expect(c.read(appLockProvider).locked, isTrue);
    auth.accepts = false;
    expect(await n.unlock(), isFalse);
    expect(c.read(appLockProvider).locked, isTrue);
    auth.accepts = true;
    expect(await n.unlock(), isTrue);
    expect(c.read(appLockProvider).locked, isFalse);
  });

  test('"every time" (0 minutes) locks on every return; switching it off unlocks', () async {
    final n = c.read(appLockProvider.notifier);
    await n.enable();
    await n.setMinutes(0);
    n.leftApp(DateTime(2026, 10, 18, 9, 0, 0));
    n.returned(DateTime(2026, 10, 18, 9, 0, 1));
    expect(c.read(appLockProvider).locked, isTrue);
    await n.disable();
    expect(c.read(appLockProvider).locked, isFalse);
    expect(c.read(appLockProvider).enabled, isFalse);
  });

  test('a cold start with the lock on begins locked', () async {
    await c.read(appLockProvider.notifier).enable();
    final again = ProviderContainer(overrides: [sessionStoreProvider.overrideWithValue(c.read(sessionStoreProvider)), deviceAuthProvider.overrideWithValue(auth)]);
    addTearDown(again.dispose);
    expect(again.read(appLockProvider).enabled, isTrue);
    expect(again.read(appLockProvider).locked, isTrue);
  });
}
