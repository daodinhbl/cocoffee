import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';

import '../session.dart';
import '../theme/app_theme.dart';

/// Asks the phone to confirm it is the owner (fingerprint, face, or the phone's PIN / pattern). Tests plug in a fake.
abstract class DeviceAuth {
  Future<bool> available();
  Future<bool> confirm(String reason);
}

class LocalAuthDevice implements DeviceAuth {
  final _auth = LocalAuthentication();

  @override
  Future<bool> available() async {
    try {
      return await _auth.isDeviceSupported();
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> confirm(String reason) async {
    try {
      return await _auth.authenticate(localizedReason: reason);
    } catch (_) {
      return false;
    }
  }
}

final deviceAuthProvider = Provider<DeviceAuth>((_) => LocalAuthDevice());

const _kEnabled = 'lock.enabled';
const _kMinutes = 'lock.minutes';

/// Choices offered in Settings: after how many minutes in the background the app asks again.
const kLockMinuteChoices = [0, 1, 5, 15]; // 0 = every time the app returns

class AppLockState {
  const AppLockState({required this.enabled, required this.minutes, required this.locked});
  final bool enabled;
  final int minutes;
  final bool locked;

  AppLockState copyWith({bool? enabled, int? minutes, bool? locked}) =>
      AppLockState(enabled: enabled ?? this.enabled, minutes: minutes ?? this.minutes, locked: locked ?? this.locked);
}

/// Locks the app behind the phone's own screen lock: when switched on, the app asks at start and again after it has been in
/// the background for [AppLockState.minutes]. It protects the open session of a phone that is lost or passed around; the
/// sign-in itself is unchanged.
class AppLockNotifier extends Notifier<AppLockState> {
  DateTime? _leftAt;

  @override
  AppLockState build() {
    final p = ref.watch(sessionStoreProvider).prefs;
    final enabled = p.getBool(_kEnabled) ?? false;
    final minutes = p.getInt(_kMinutes);
    return AppLockState(enabled: enabled, minutes: kLockMinuteChoices.contains(minutes) ? minutes! : 1, locked: enabled);
  }

  /// Switches the lock on only after the phone has confirmed once (so a phone without any screen lock cannot lock itself out).
  Future<bool> enable() async {
    final auth = ref.read(deviceAuthProvider);
    if (!await auth.available()) return false;
    if (!await auth.confirm('Xác nhận để bật khóa ứng dụng')) return false;
    await ref.read(sessionStoreProvider).prefs.setBool(_kEnabled, true);
    state = state.copyWith(enabled: true, locked: false);
    return true;
  }

  Future<void> disable() async {
    await ref.read(sessionStoreProvider).prefs.setBool(_kEnabled, false);
    state = state.copyWith(enabled: false, locked: false);
  }

  Future<void> setMinutes(int m) async {
    await ref.read(sessionStoreProvider).prefs.setInt(_kMinutes, m);
    state = state.copyWith(minutes: m);
  }

  /// The app went to the background.
  void leftApp([DateTime? now]) => _leftAt = now ?? DateTime.now();

  /// The app is back: lock when it was away long enough.
  void returned([DateTime? now]) {
    final left = _leftAt;
    _leftAt = null;
    if (!state.enabled || left == null) return;
    if ((now ?? DateTime.now()).difference(left).inSeconds >= state.minutes * 60) state = state.copyWith(locked: true);
  }

  Future<bool> unlock() async {
    if (!state.enabled) return true;
    if (!await ref.read(deviceAuthProvider).confirm('Mở khóa POS Tasotek')) return false;
    state = state.copyWith(locked: false);
    return true;
  }
}

final appLockProvider = NotifierProvider<AppLockNotifier, AppLockState>(AppLockNotifier.new);

/// Full-screen cover shown while the app is locked; asks the phone to confirm as soon as it appears.
class LockScreen extends ConsumerStatefulWidget {
  const LockScreen({super.key});
  @override
  ConsumerState<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends ConsumerState<LockScreen> {
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _try());
  }

  Future<void> _try() async {
    final ok = await ref.read(appLockProvider.notifier).unlock();
    if (!ok && mounted) setState(() => _failed = true);
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Palette.navyDarker,
      child: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.lock_rounded, size: 56, color: Colors.white),
              const SizedBox(height: 16),
              const Text('POS Tasotek đang khóa', style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text(_failed ? 'Chưa xác nhận được. Thử lại.' : 'Xác nhận bằng vân tay, khuôn mặt hoặc mã khóa máy.', style: const TextStyle(color: Colors.white70), textAlign: TextAlign.center),
              const SizedBox(height: 24),
              FilledButton.icon(onPressed: _try, icon: const Icon(Icons.fingerprint_rounded), label: const Text('Mở khóa')),
            ]),
          ),
        ),
      ),
    );
  }
}
